#!/usr/bin/env python3
"""Break-glass activation control flow (issue #437).

This tool implements the operator-side control flow of the break-glass
runbook in docs/runbooks/break-glass.md:

  * activation requires a quorum of custodians (two-person control) whose
    shares live outside the repository on offline media;
  * an audit record is appended and fsynced *before* a grant is created, so
    a grant never exists without a trail;
  * grants expire automatically and ``check`` treats expired or revoked
    grants as absent (it never "un-expires");
  * every activation and revocation queues one alert per admin plus the
    audit channel, and optionally POSTs them to a webhook;
  * credential material (the custodian shares) is never printed and never
    stored in the repository - only salted SHA-256 hashes live in the vault
    metadata.

The tool adds no backdoor to any service. It gates and records the recovery
actions in the runbook, which keep using the existing primitives
(auth-service local login, SCIM provisioning, SQL admin repair).

Exit codes:
  0  success
  1  operation refused or failed
  2  vault/usage error
  3  ``check``: no active grant
"""

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

VAULT_ENV_VAR = "BREAK_GLASS_DIR"
WEBHOOK_ENV_VAR = "BREAK_GLASS_ALERT_WEBHOOK"
REPO_ROOT = Path(__file__).resolve().parents[1]
AUDIT_CHANNEL = "audit-channel"
QUORUM = 2
HARD_MAX_HOURS = 8.0
DEFAULT_MAX_HOURS = 4.0
DEFAULT_GRANT_HOURS = 2.0
SLUG_RE = re.compile(r"[^a-z0-9-]+")


def _now():
    """Return the current time as an aware UTC datetime (monkeypatched in tests)."""
    return datetime.now(timezone.utc)


def _iso(moment):
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_iso(text):
    return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)


def _die(message, code=2):
    print("ERROR: %s" % message, file=sys.stderr)
    raise SystemExit(code)


def _fail(message):
    print("REFUSED: %s" % message, file=sys.stderr)
    return 1


def _inside_repo(path):
    """Return the repository root when ``path`` would live inside it."""
    try:
        Path(path).resolve().relative_to(REPO_ROOT)
        return REPO_ROOT
    except ValueError:
        return None


def _slugify(value):
    slug = SLUG_RE.sub("-", value.strip().lower()).strip("-")
    return slug or "custodian"


# ── vault helpers ───────────────────────────────────────────────────────────

def _metadata_path(vault):
    return Path(vault) / "metadata.json"


def _require_vault(vault):
    path = _metadata_path(vault)
    if not path.is_file():
        _die("no break-glass vault at %s (run 'init' first, or set %s)" % (
            vault, VAULT_ENV_VAR))
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        _die("vault metadata at %s is unreadable: %s" % (path, exc))


def _write_json_atomic(path, payload, mode=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name, dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        if mode is not None:
            os.chmod(tmp_name, mode)
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name) and tmp_name != str(path):
            os.unlink(tmp_name)


def _record_hash(record):
    payload = {key: value for key, value in record.items() if key != "hash"}
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(("%s\n%s" % (record.get("prev_hash", ""), blob)).encode("utf-8")).hexdigest()


def _read_audit(vault):
    log = Path(vault) / "audit.jsonl"
    records = []
    if log.is_file():
        with log.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    records.append(json.loads(line))
    return records


def _append_audit(vault, event, actor, details):
    """Append one hash-chained audit record and fsync it. Raises on failure."""
    records = _read_audit(vault)
    record = {
        "seq": len(records) + 1,
        "ts": _iso(_now()),
        "event": event,
        "actor": actor,
        "details": details,
        "prev_hash": records[-1]["hash"] if records else "",
    }
    record["hash"] = _record_hash(record)
    log = Path(vault) / "audit.jsonl"
    with log.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, sort_keys=True) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    return record


def _share_hash(salt, share):
    return hashlib.sha256(("%s%s" % (salt, share)).encode("utf-8")).hexdigest()


def _grants_dir(vault):
    return Path(vault) / "grants"


def _load_grants(vault, now=None):
    now = now or _now()
    grants = []
    directory = _grants_dir(vault)
    if not directory.is_dir():
        return grants
    for path in sorted(directory.glob("*.json")):
        try:
            grant = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if grant.get("revoked"):
            state = "revoked"
        elif _parse_iso(grant["expires_at"]) <= now:
            state = "expired"
        else:
            state = "active"
        grant["state"] = state
        grant["remaining_seconds"] = max(
            0, int((_parse_iso(grant["expires_at"]) - now).total_seconds()))
        grants.append(grant)
    return grants


def _active_grants(vault, now=None):
    return [grant for grant in _load_grants(vault, now) if grant["state"] == "active"]


def _safe_webhook(url):
    """Only https webhooks are allowed, so the alert path cannot be coerced
    into file:// or another non-HTTP scheme from the environment."""
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme == "https" and bool(parsed.netloc)


def _emit_alerts(vault, metadata, event, grant, dry_run=False):
    """Queue one alert per admin plus the audit channel, then try the webhook."""
    recipients = [
        {"kind": "admin", "id": admin} for admin in metadata.get("admins", [])
    ]
    recipients.append({"kind": "audit-channel", "id": AUDIT_CHANNEL})
    alert_path = Path(vault) / "alerts.jsonl"
    queued = []
    for recipient in recipients:
        alert = {
            "ts": _iso(_now()),
            "event": event,
            "grant_id": grant["id"],
            "incident": grant.get("incident"),
            "recipient": recipient,
            "expires_at": grant.get("expires_at"),
            "delivery": "queued",
        }
        if not dry_run:
            with alert_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(alert, sort_keys=True) + "\n")
        queued.append(alert)
    webhook = os.environ.get(WEBHOOK_ENV_VAR, "").strip()
    if webhook and not dry_run and not _safe_webhook(webhook):
        print("WARNING: refusing break-glass webhook that is not an https URL; "
              "alerts remain queued in %s" % alert_path, file=sys.stderr)
        webhook = ""
    if webhook and not dry_run:
        payload = {
            "event": event,
            "grant_id": grant["id"],
            "incident": grant.get("incident"),
            "expires_at": grant.get("expires_at"),
            "recipients": recipients,
        }
        request = urllib.request.Request(
            webhook,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=10):
                delivery = "delivered"
        except (urllib.error.URLError, OSError) as exc:
            delivery = "failed: %s" % exc
            with alert_path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({
                    "ts": _iso(_now()),
                    "event": event,
                    "grant_id": grant["id"],
                    "recipient": {"kind": "webhook", "id": webhook},
                    "delivery": delivery,
                }, sort_keys=True) + "\n")
            print("WARNING: break-glass alert webhook delivery failed: %s" % exc,
                  file=sys.stderr)
            print("WARNING: page the on-call manually now (%s) and keep the "
                  "queued alerts in %s" % (recipient_ids(metadata), alert_path),
                  file=sys.stderr)
    return queued


def recipient_ids(metadata):
    return ", ".join(metadata.get("admins", []) + [AUDIT_CHANNEL])


# ── commands ────────────────────────────────────────────────────────────────

def cmd_init(args):
    vault = Path(args.dir)
    in_repo = _inside_repo(vault)
    if in_repo:
        return _fail(
            "vault path %s is inside the repository at %s; credential "
            "material must never live in the repository" % (vault, in_repo))
    if len(args.custodian) < QUORUM:
        return _fail("at least %d --custodian names are required "
                     "(two-person control)" % QUORUM)
    if not args.admin:
        return _fail("at least one --admin recipient is required")
    max_hours = min(float(args.max_hours), HARD_MAX_HOURS)
    if max_hours <= 0:
        return _fail("--max-hours must be positive")

    slugs = [_slugify(name) for name in args.custodian]
    if len(set(slugs)) != len(slugs):
        return _fail("custodian names must be unique: %s" % args.custodian)

    shares_dir = vault / "custodians"
    shares_dir.mkdir(parents=True, exist_ok=True)
    _grants_dir(vault).mkdir(parents=True, exist_ok=True)

    custodians = []
    share_paths = []
    for name, slug in zip(args.custodian, slugs):
        share = secrets.token_hex(32)
        salt = secrets.token_hex(16)
        share_file = shares_dir / ("%s.share" % slug)
        share_file.write_text(share + "\n", encoding="utf-8")
        os.chmod(share_file, stat.S_IRUSR | stat.S_IWUSR)
        share_paths.append(share_file)
        custodians.append({
            "id": slug,
            "name": name,
            "salt": salt,
            "share_hash": _share_hash(salt, share),
        })
        del share

    metadata = {
        "version": 1,
        "created_at": _iso(_now()),
        "quorum": QUORUM,
        "max_hours": max_hours,
        "custodians": custodians,
        "admins": list(dict.fromkeys(args.admin)),
    }
    _write_json_atomic(_metadata_path(vault), metadata)
    _append_audit(vault, "vault_initialized", "setup",
                  {"custodians": [c["id"] for c in custodians],
                   "quorum": QUORUM, "max_hours": max_hours})

    print("Break-glass vault initialised at %s" % vault)
    print("Custodians (quorum %d of %d): %s" % (
        QUORUM, len(custodians), ", ".join(c["id"] for c in custodians)))
    print("Alerts will be queued for: %s" % recipient_ids(metadata))
    print("")
    print("Share files (SECRET material - distribute, then remove from this host):")
    for path in share_paths:
        print("  %s" % path)
    print("")
    print("Next steps:")
    print("  1. Give each share file to a different custodian over a separate")
    print("     channel and store it on offline media.")
    print("  2. Shred the local copies (shred -u <file> / srm <file>).")
    print("  3. Back up %s (hashes only, no secrets)." % _metadata_path(vault))
    return 0


def _read_custodian_shares(paths):
    shares = []
    for raw in paths:
        path = Path(raw)
        try:
            share = path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise ValueError("cannot read custodian share %s: %s" % (path, exc))
        if not share:
            raise ValueError("custodian share %s is empty" % path)
        shares.append((path, share))
    return shares


def _verify_quorum(metadata, share_inputs):
    verified = []
    seen = set()
    for path, share in share_inputs:
        matched = None
        for custodian in metadata.get("custodians", []):
            candidate = _share_hash(custodian["salt"], share)
            if hmac.compare_digest(candidate, custodian["share_hash"]):
                matched = custodian
                break
        if matched is None:
            raise ValueError("share %s does not match any registered custodian" % path)
        if matched["id"] in seen:
            raise ValueError("custodian %s supplied more than one share" % matched["id"])
        seen.add(matched["id"])
        verified.append(matched)
    return verified


def cmd_activate(args):
    vault = Path(args.dir)
    metadata = _require_vault(vault)
    try:
        supplied = _read_custodian_shares(args.custodian_file)
        verified = _verify_quorum(metadata, supplied)
    except ValueError as exc:
        return _fail(str(exc))

    quorum = int(metadata.get("quorum", QUORUM))
    if len(verified) < quorum:
        return _fail("quorum not met: %d of %d custodians verified; a single "
                     "custodian cannot activate break-glass" % (len(verified), quorum))

    max_hours = float(metadata.get("max_hours", DEFAULT_MAX_HOURS))
    hours = float(args.hours if args.hours is not None else DEFAULT_GRANT_HOURS)
    if hours <= 0 or hours > max_hours:
        return _fail("requested TTL %.2fh is outside the allowed window "
                     "(>0 and <= %.2fh); break-glass access must expire "
                     "automatically" % (hours, max_hours))

    now = _now()
    grant = {
        "id": "bg-%s-%s" % (now.strftime("%Y%m%dT%H%M%SZ"), secrets.token_hex(3)),
        "incident": args.incident,
        "reason": args.reason,
        "custodians": [c["id"] for c in verified],
        "issued_at": _iso(now),
        "expires_at": _iso(now + timedelta(hours=hours)),
        "revoked": False,
    }
    audit_details = {
        "grant_id": grant["id"],
        "incident": grant["incident"],
        "reason": grant["reason"],
        "custodians": grant["custodians"],
        "issued_at": grant["issued_at"],
        "expires_at": grant["expires_at"],
        "ttl_minutes": int(hours * 60),
    }

    if args.dry_run:
        print("DRY RUN - nothing written")
        print("Quorum satisfied: %s" % ", ".join(grant["custodians"]))
        print("Grant would be %s, valid until %s" % (grant["id"], grant["expires_at"]))
        print("Audit record would be appended before the grant is created")
        print("Alerts would be queued for: %s" % recipient_ids(metadata))
        return 0

    try:
        record = _append_audit(vault, "access_granted", grant["custodians"][0],
                               audit_details)
    except OSError as exc:
        return _fail("audit record could not be written (%s); no grant was "
                     "created" % exc)

    _write_json_atomic(_grants_dir(vault) / ("%s.json" % grant["id"]), grant)
    _emit_alerts(vault, metadata, "break_glass_activated", grant)

    print("Break-glass access ACTIVE")
    print("  grant:      %s" % grant["id"])
    print("  incident:   %s" % grant["incident"])
    print("  custodians: %s" % ", ".join(grant["custodians"]))
    print("  expires:    %s (TTL %.0f min)" % (grant["expires_at"],
                                               audit_details["ttl_minutes"]))
    print("  audit:      seq %d in %s" % (record["seq"], vault / "audit.jsonl"))
    print("  alerts:     queued for %s" % recipient_ids(metadata))
    print("")
    print("Proceed with the recovery steps in docs/runbooks/break-glass.md")
    print("and revoke as soon as the incident is stable:")
    print("  python scripts/break_glass.py revoke --dir %s --grant-id %s "
          "--reason \"<why>\"" % (vault, grant["id"]))
    return 0


def cmd_check(args):
    vault = Path(args.dir)
    _require_vault(vault)
    active = _active_grants(vault)
    if args.grant_id:
        active = [grant for grant in active if grant["id"] == args.grant_id]
    if args.json:
        print(json.dumps({"active": active}, indent=2, sort_keys=True))
    elif active:
        for grant in active:
            print("ACTIVE %s incident=%s expires=%s remaining=%ds custodians=%s" % (
                grant["id"], grant.get("incident"), grant.get("expires_at"),
                grant["remaining_seconds"], ",".join(grant.get("custodians", []))))
    else:
        print("NO ACTIVE BREAK-GLASS GRANT (refusing recovery actions)")
    return 0 if active else 3


def cmd_status(args):
    vault = Path(args.dir)
    metadata = _require_vault(vault)
    grants = _load_grants(vault)
    if args.json:
        print(json.dumps({
            "vault": str(vault),
            "quorum": metadata.get("quorum", QUORUM),
            "max_hours": metadata.get("max_hours"),
            "custodians": [c["id"] for c in metadata.get("custodians", [])],
            "admins": metadata.get("admins", []),
            "grants": grants,
        }, indent=2, sort_keys=True))
        return 0
    print("Vault:        %s" % vault)
    print("Custodians:   %s (quorum %s)" % (
        ", ".join(c["id"] for c in metadata.get("custodians", [])),
        metadata.get("quorum", QUORUM)))
    print("Alerts go to: %s" % recipient_ids(metadata))
    if not grants:
        print("Grants:       none")
    for grant in grants:
        print("Grant %s state=%s expires=%s incident=%s" % (
            grant["id"], grant["state"], grant.get("expires_at"),
            grant.get("incident")))
    return 0


def cmd_revoke(args):
    vault = Path(args.dir)
    metadata = _require_vault(vault)
    path = _grants_dir(vault) / ("%s.json" % args.grant_id)
    if not path.is_file():
        return _fail("no grant %s in %s" % (args.grant_id, vault))
    grant = json.loads(path.read_text(encoding="utf-8"))
    if grant.get("revoked"):
        return _fail("grant %s is already revoked" % args.grant_id)
    grant["revoked"] = True
    grant["revoked_at"] = _iso(_now())
    grant["revoked_reason"] = args.reason
    _write_json_atomic(path, grant)
    _append_audit(vault, "access_revoked", "revocation",
                  {"grant_id": grant["id"], "incident": grant.get("incident"),
                   "reason": args.reason, "revoked_at": grant["revoked_at"]})
    _emit_alerts(vault, metadata, "break_glass_revoked", grant)
    print("Grant %s revoked at %s" % (grant["id"], grant["revoked_at"]))
    print("Alerts queued for %s" % recipient_ids(metadata))
    return 0


def cmd_verify_audit(args):
    vault = Path(args.dir)
    _require_vault(vault)
    records = _read_audit(vault)
    prev_hash = ""
    for index, record in enumerate(records, start=1):
        if record.get("seq") != index:
            print("FAIL: audit record %d has seq %r (expected %d)" % (
                index, record.get("seq"), index), file=sys.stderr)
            return 1
        if record.get("prev_hash", "") != prev_hash:
            print("FAIL: audit record %d does not link to the previous hash" % index,
                  file=sys.stderr)
            return 1
        if record.get("hash") != _record_hash(record):
            print("FAIL: audit record %d hash mismatch (record was modified)" % index,
                  file=sys.stderr)
            return 1
        prev_hash = record["hash"]
    print("Audit chain intact: %d record(s), head %s" % (
        len(records), prev_hash[:16] if prev_hash else "(empty)"))
    return 0


# ── CLI ─────────────────────────────────────────────────────────────────────

def build_parser():
    parser = argparse.ArgumentParser(
        prog="break_glass.py",
        description="Break-glass two-person activation control flow (issue #437).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_vault_flag(target):
        target.add_argument(
            "--dir", default=os.environ.get(VAULT_ENV_VAR, ""),
            help="vault directory outside the repository (default: $%s)" % VAULT_ENV_VAR)

    init = sub.add_parser("init", help="create a vault and custodian shares")
    add_vault_flag(init)
    init.add_argument("--custodian", action="append", default=[], required=True,
                      help="custodian name (repeat; at least 2)")
    init.add_argument("--admin", action="append", default=[], required=True,
                      help="admin recipient id/email for alerts (repeat)")
    init.add_argument("--max-hours", type=float, default=DEFAULT_MAX_HOURS,
                      help="hard cap for any grant (default %.1f, max %.1f)"
                           % (DEFAULT_MAX_HOURS, HARD_MAX_HOURS))
    init.set_defaults(func=cmd_init)

    activate = sub.add_parser(
        "activate", help="two-custodian activation (audit first, then grant)")
    add_vault_flag(activate)
    activate.add_argument("--custodian-file", action="append", default=[],
                          required=True,
                          help="path to a custodian share (repeat; quorum required)")
    activate.add_argument("--incident", required=True, help="incident/ticket id")
    activate.add_argument("--reason", required=True,
                          help="what access is needed and why")
    activate.add_argument("--hours", type=float, default=None,
                          help="requested TTL in hours (default %.1f)"
                               % DEFAULT_GRANT_HOURS)
    activate.add_argument("--dry-run", action="store_true",
                          help="validate everything but write nothing")
    activate.set_defaults(func=cmd_activate)

    check = sub.add_parser("check", help="gate: exit 0 only for a live grant")
    add_vault_flag(check)
    check.add_argument("--grant-id", default=None)
    check.add_argument("--json", action="store_true")
    check.set_defaults(func=cmd_check)

    status = sub.add_parser("status", help="show vault and grant state")
    add_vault_flag(status)
    status.add_argument("--json", action="store_true")
    status.set_defaults(func=cmd_status)

    revoke = sub.add_parser("revoke", help="end a grant early")
    add_vault_flag(revoke)
    revoke.add_argument("--grant-id", required=True)
    revoke.add_argument("--reason", required=True)
    revoke.set_defaults(func=cmd_revoke)

    verify = sub.add_parser("verify-audit", help="verify the audit hash chain")
    add_vault_flag(verify)
    verify.set_defaults(func=cmd_verify_audit)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.dir:
        _die("no vault directory given; pass --dir or set %s" % VAULT_ENV_VAR)
    try:
        return args.func(args)
    except SystemExit:
        raise
    except Exception as exc:  # noqa: BLE001 - CLI boundary, report and fail closed
        _die("%s failed: %s" % (args.command, exc), code=1)
        return 1


if __name__ == "__main__":
    sys.exit(main())
