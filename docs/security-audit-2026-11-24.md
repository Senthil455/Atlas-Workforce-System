# Atlas Workforce System — Security Audit Report

**Date:** 2026-11-24
**Scope:** `Senthil455/Atlas-Workforce-System`, branch `main` (working tree, including the uncommitted Code Scanning fixes from the same day)
**Auditor:** Automated toolchain (see matrix for versions)
**Target surface:** 21 directories under `services/` (19 runnable services), `frontend/`, `k8s/`, `scripts/`, `tests/`, Dockerfiles, `docker-compose*.yml`, GitHub Actions workflows.

---

## 1. Executive summary

| Area | Result |
|---|---|
| SCA — Go | **1 critical (reachable), 4 high/unknown** across 3 services |
| SCA — Python | **163 distinct advisories** across 63 resolved package instances (11 services) |
| SCA — npm | 2 moderate (frontend, `uuid` via `exceljs`); auth-service and api-gateway are clean |
| SCA — Java | **Incomplete** — Maven Central returned HTTP 429 during resolution; poms could not be resolved transitively |
| SAST | 2 Semgrep ERRORs (both triaged as non-exploitable), 9 Bandit MEDIUM, 1 Gosec LOW, 0 high-severity source findings |
| Secrets | 0 verified secrets; 4 Gitleaks hits and 54 TruffleHog raw matches are false positives/placeholders |
| Kubernetes | 227 (Trivy) / 272 (Checkov) / 150 (Terrascan) misconfigurations, dominated by missing pod hardening, secrets in env, default namespace, no digests |
| Containers | 52 Hadolint / 22 Checkov findings; EOL base images (`node:18`, `python:3.10`), unpinned packages, no HEALTHCHECK |
| DAST | **Not performed** — no Docker daemon, no database, no running stack; all web/API/network scanners need a live target |

**Highest priority:** upgrade `github.com/andybalholm/brotli` (reachable critical), `klauspost/compress`, `valyala/fasthttp`, `golang.org/x/crypto`, `gorilla/websocket`; modernise the FastAPI/Starlette/urllib3 Python stack; stop injecting Secrets as Kubernetes environment variables; pin GitHub Actions to commit SHAs.

The 14 Code Scanning fixes from the earlier audit were committed as `68843e5`. Remediation of the findings below was applied on 2026-11-25 (see section 1a) and remains uncommitted in the working tree.

---

## 1a. Remediation applied (2026-11-25)

| Finding | Status | Change | Verification |
|---|---|---|---|
| F-01 brotli critical (attendance, lms) | **Fixed** | 1.1.0 → 1.2.7 | `govulncheck ./...` reports **No vulnerabilities found** in both |
| GO-2026-6865 compress | **Fixed** | 1.18.7 → 1.20.2 | same |
| GO-2026-4950 fasthttp | **Fixed** | 1.51.0 → 1.70.0 | same |
| GO-2026-5932 x/crypto | **Fixed** | 0.56.0 → 0.58.1-0.20261009 | same |
| GO-2026-6278 websocket | **Fixed** | 1.5.3 → 1.5.4-0.20240701 | `govulncheck`: clean; also bumped transitive `x/net` to 0.62.0 |
| Python dependency stack | **Fixed for all declared packages** | FastAPI 0.165.0, Starlette 1.10, Pydantic 2.14.4, pydantic-settings 2.16.3, sse-starlette 3.7.1, urllib3 2.8.0, h11 0.16.0, pygments 2.21.0, anyio 4.16.0, certifi 2026.11.20, idna 3.20, tqdm 4.70.1, nltk 3.10.4, `analytics` openai 1.3.5 → 1.58.1 | OSV: **63 → 2** package instances; all 11 manifests resolve for Python 3.12; `py_compile` passes |
| Python EOL base images | **Fixed** | all `python:3.10/3.11` → `python:3.12` (required by FastAPI 0.165) | pip `--dry-run --python-version 3.12` succeeds for all 11 services |
| npm uuid (frontend) | **Fixed** | npm override `exceljs → uuid 11.1.1` | `npm audit`: **0 vulnerabilities**; `npm run build`: exit 0 |
| Wildcard CORS + credentials | **Fixed** | 5 services: credentials disabled when origins are `*` | `py_compile`; Semgrep rule no longer applicable |
| GCM missing `authTagLength` | **Fixed** | explicit `{ authTagLength: 16 }` on decrypt | `node -c`; auth-service test suite passes |
| Dynamic `urllib` scheme | **Fixed** | break-glass webhooks must be `https://` | `tests/scripts/test_break_glass.py`: 15 passed |
| Gosec G104 | **Fixed** | legacy index drop error is logged | `gosec`: 0 findings in attendance-service |
| Deprecated `regex=` params | **Fixed** | 9 ATS query params → `pattern=` | ATS manifests resolve |
| Container HEALTHCHECK | **Fixed** | added to all 20 Dockerfiles with matching `/health` port | Checkov Dockerfile: **22 → 1** |
| EOL container bases | **Fixed** | `node:18/20` → `node:22`, `alpine:latest/3.19` → `alpine:3.22` | Hadolint DL3007 cleared |
| Pre-existing frontend build blockers | **Fixed** | closed the unclosed `WidgetBoundary` in `analytics/page.tsx`; added the missing `atsApi.getOpenReqs` | `npm run build` exit 0 |
| CI Python tests | **Fixed** | CI test install includes `httpx2` (Starlette 1.x TestClient requirement) | verified TestClient with FastAPI 0.165 + httpx2 |

Remaining OSV hits: `httpx2@2.9.1` / `httpcore2@2.9.1` under `ai-copilot-service`. Neither is declared in any manifest — they are artefacts of OSV resolving Starlette's optional `full` extra, so `pip install -r requirements.txt` does not install them.

Hadolint rose from 52 to 62 because the new shell-form `HEALTHCHECK` lines add 20 × DL3025 (prefer JSON CMD form). This is a style trade-off for needing `|| exit` semantics; the security-relevant checks (missing HEALTHCHECK, `latest` tags) are resolved.

### Deferred, with reasons

| Item | Why not changed here |
|---|---|
| Kubernetes pod hardening (read-only root FS, seccomp, SA token, capabilities, digests) | Requires a live cluster plus writable-path analysis (`/tmp`, Next.js cache, Python bytecode); blind edits would break workloads. Manifests still validate (`scripts/validate-k8s-manifests.py`, 22 Deployments). |
| AES-ECB in payroll `EncryptedStringConverter` | No Maven/`~/.m2` and no database; changing the ciphertext format needs a key/version migration and backward-compatible reads. |
| GitHub Actions pinned to commit SHAs (43 refs) | Mechanical but must be paired with a Dependabot/Renovate SHA policy; tags still work and this is tracked as supply-chain debt. |
| Compose default passwords | The CI safety job requires `docker compose config` to succeed without env; runtime guards already refuse these defaults in production. Making them `:?` would break that gate. |
| Image digests in k8s manifests | Requires the registry digests for each image; the tag is immutable by convention here. |

### Verification run after remediation

- `go build ./...` + `go vet ./...` + `govulncheck ./...`: attendance, lms, notification — all clean.
- `python3 -m py_compile` for every service `main.py`: pass.
- `pip install --dry-run --python-version 3.12` for all 11 Python manifests: pass.
- `node -c` + `node test_auth.js`: pass; gosec 0; `pytest tests/scripts/test_break_glass.py`: 15 passed.
- `npm audit`: 0; `npm run build`: exit 0 (with `NEXT_PUBLIC_ALLOW_LOCALHOST=true`).
- `python3 scripts/validate-k8s-manifests.py`: OK.

Not verified locally: Python unit suites (psycopg2 has no Python 3.14 wheel in this environment, and no PostgreSQL is available) and any Maven build. Those remain covered by CI.

---

## 2. Environment and constraints

- No `docker` / `podman` daemon, therefore no `docker compose up`, no image build, no container-runtime scanning.
- No PostgreSQL/MongoDB/Redis/RabbitMQ/Kafka, so no service can complete startup and no authenticated DAST is possible.
- No Maven, no `~/.m2`; Maven Central blocked this IP with HTTP 429 (30 min) during Trivy/OSV Java resolution.
- No display; Burp Suite (GUI), IDA Pro, Ghidra GUI, Postman/Insomnia GUI could not run.
- No cloud credentials, no Kubernetes cluster, no AWS/GCP/Azure account.
- Several products are commercial/licensed (Nessus, Fortify, Checkmarx, Veracode, Mend, CrowdStrike, Splunk, Burp Pro, IDA Pro) or SaaS requiring an account token (Snyk, Socket, 42Crunch).
- Installed CLI scanners: Semgrep 1.186.0, Bandit 1.9.4, Gosec (dev), Trivy 0.76.2, Grype 0.122.1, Syft 1.57.2, OSV-Scanner 2.7.1, Gitleaks 8.30.1, TruffleHog 3.100.1, Checkov, Hadolint 2.15.1, Terrascan 1.19.9, Kubesec 2.15.0, govulncheck 1.10.0, pip-audit, njsscan.
- Raw machine-readable results: `/tmp/sa/raw/` (semgrep.json, bandit.json, gosec-*.json, trivy-*.json, grype.json, osv.json, govuln-*.json, gitleaks.json, trufflehog.jsonl, checkov-*, terrascan.json, hadolint.json, kubesec.json, npm-audit-*.json, eslint-security.json).

**Coverage caveat:** "every file, every line" is not a verifiable claim for black-box or licence-gated tools. Semgrep parsed 591 files; Bandit covered all Python service trees; Gosec covered all three Go modules; every Dockerfile and every `k8s/*.yaml` was scanned. Generated code, `node_modules`, lockfiles and Git history were excluded from SAST (dependencies were scanned separately).

---

## 3. Findings, ranked

### P0 — Reachable critical dependency (Go)

**F-01 `GO-2026-6888` / CVE in `github.com/andybalholm/brotli@v1.1.0` (Critical)**
`services/attendance-service/go.mod`, `services/lms-service/go.mod`
`govulncheck` reports the vulnerable symbol is **reachable** (`Read`, `Error`) in both services. Fixed in `v1.2.7`. This is the only finding where exploitability was proven by call-graph reachability.

### P1 — High/unknown Go advisories

| ID | Package | Current | Fix | Services |
|---|---|---|---|---|
| GO-2026-6865 | `klauspost/compress` | 1.18.7 | **1.20.2** | attendance, lms |
| GO-2026-4950 | `valyala/fasthttp` | 1.51.0 | **1.70.0** | attendance, lms |
| GO-2026-5932 | `golang.org/x/crypto` | 0.56.0 | 0.58.1-0.20261009181718-2f1f834330b2 | lms |
| GO-2026-6278 | `gorilla/websocket` | 1.5.3 | 1.5.4-0.20240701034025-d67f41855da4 | notification |

Note: the Dependabot advisory fixed by 1.18.7 is different from GO-2026-6865, so the earlier bump to 1.18.7 was necessary but not sufficient.

### P1 — Python dependency stack

OSV-Scanner resolved 63 vulnerable package instances (163 unique advisory IDs) from `requirements.txt` files. The most consequential:

| Package | Seen | Services | Why it matters |
|---|---|---|---|
| `starlette` 0.27.0 – 0.50.0 | multiple CVEs incl. GHSA-7f5h-v6xp-fcq8 | analytics, ats, employee-python, ai, audit, live, security, workforce | DoS / request-handling flaws; pulled transitively by old FastAPI pins |
| `fastapi` 0.104.1 | PYSEC-2024-38 | analytics, ats, employee-python | pins the vulnerable Starlette range |
| `urllib3` 1.26.9 | 20 advisories (GHSA-34jh-p97f-mpxf, GHSA-v845-jxx5-vc9f, …) | analytics | proxy-header/redirect/DoS issues |
| `h11` 0.9.0 | PYSEC-2026-348 / GHSA-vqfr-h8mv-ghfj | employee-lifecycle, live, security, workforce | request smuggling class |
| `pygments` 2.9.0 | GHSA-5239-wwwm-4pmq | ats, audit | ReDoS |
| `anyio` 3.7.1 / 4.9.0 | PYSEC-2026-4024/4025 | most Python services | race/DoS |
| `certifi`, `idna`, `tqdm`, `nltk` | various | several | low-to-medium transitive issues |

Caveats:
- Several services (notably `ai-copilot-service`) use unbounded ranges (`fastapi>=0.104.0`, `nltk>=3.8.0`, `httpx>=0.25.0`), so OSV resolves those to whatever is newest. That is itself a **supply-chain finding**: builds are not reproducible and a future malicious/typosquatted release would be accepted. `httpx2`/`httpcore2` appearing in the resolved set (packages that do not appear in the repository) is an artefact of range resolution and should not be treated as a declared dependency.
- Trivy's language vulnerability scan returned 0 for the same manifests (advisory DB lag); OSV/GitHub data is authoritative here.
- `pip-audit` could not run: every `requirements.txt` ends with an editable local path (`-e ../atlas_observability`), which pip-audit's ephemeral environment rejects.

**F-05 npm:** `uuid@8.3.2` (via `exceljs`, frontend) — GHSA-w5hq-g745-h8pq, moderate, missing buffer bounds check for v3/v5/v6 with an explicit `buf`. Reachable path not established; `npm audit` rates it moderate. `services/auth-service` and `services/api-gateway-node` report 0 vulnerabilities.

### P1 — Kubernetes hardening

Aggregated: Trivy 227, Checkov 272, Terrascan 150 violations across 7 manifests.

Most repeated and material:

| Issue | Count | Evidence |
|---|---|---|
| Pods in `default` namespace | 51 (Checkov CKV_K8S_21) | all `k8s/*.yaml` |
| Root filesystem not read-only | 24 (Trivy KSV-0014, HIGH) | every Deployment |
| Seccomp profile not set | 24 (KSV-0104/0030) | every Deployment |
| Service-account token auto-mounted | 24 (CKV_K8S_38) | every Deployment |
| Image not pinned by digest | 24 (CKV_K8S_43) | all images use the same tag `a89d2bc…` |
| `allowPrivilegeEscalation` | 6 (Semgrep + KSV-0001) | `k8s/infrastructure.yaml`, some deployments |
| Secrets passed as env vars | 21 (Kubesec `SecretsAsEnvironmentVariables`, −5 points each) | deployments score only 2/10 |
| Pods without a NetworkPolicy | 18 (CKV2_K8S_6) | `networkpolicies.yaml` does not cover all workloads |
| Default security context / runs as root | 4 + 12 | infrastructure pods |
| Missing CPU/memory limits | 2+ | infrastructure pods |

`k8s/secret.yaml` is a template full of `CHANGEME-*` values; `docker-compose.yml` falls back to `atlas_password`, `changeme_mongo_pass`, `changeme_rabbit_pass` when env vars are unset. These are safe only if operators always override them — make them required (`${VAR:?}`) instead of defaulted.

### P2 — Application code

| # | Finding | Location | Assessment |
|---|---|---|---|
| F-10 | `createDecipheriv('aes-256-gcm', …)` without `authTagLength` | `services/auth-service/index.js:443` | **Hardening, not exploitable**: Node defaults to a 16-byte tag and `setAuthTag` is called. Add `{ authTagLength: 16 }` for explicitness. |
| F-11 | `text(f"ALTER TABLE {table} ADD COLUMN {column} {ddl_type}")` | `services/integration-service/main.py:155` | **False positive**: all three values come from a hard-coded tuple list, no request data. Keep as-is or switch to SQLAlchemy DDL constructs. |
| F-12 | Wildcard CORS with credentials | `ai-copilot-service/main.py:76`, `ai-service/main.py:84`, `security-service/main.py:134`, `audit-compliance-service/main.py:229`, `integration-service/main.py:225` | `allow_origins=["*"]` + `allow_credentials=True`. Browsers will not send credentials to `*`, but the policy is still over-permissive and blocks safe cookie-based auth. Restrict to configured origins. |
| F-13 | AES/ECB mode for stored encrypted fields | `payroll-java-service/.../EncryptedStringConverter.java:107` | Deterministic encryption leaks equality/patterns. Migrate to AES-GCM (with per-value IV). |
| F-14 | `win.document.write` | `frontend/src/app/dashboard/me/payslips/page.tsx:49` | **False positive**: both interpolations pass through `escapeHtml`. Prefer `document.body` DOM construction and a CSP without `unsafe-inline`. |
| F-15 | Dynamic `urllib.request.urlopen` | `scripts/break_glass.py:240` | Operator-supplied webhook; `file://`/custom schemes are theoretically possible. Validate scheme to `https` before calling. |
| F-16 | `exec()` | `services/integration-service/test_event_router_consumer.py:49` | Test-only. |
| F-17 | Unhandled error | `services/attendance-service/models.go:186` (Gosec G104, LOW) | Log or return the error. |
| F-18 | 9 × `0.0.0.0` bindings | Python services (Bandit B104) | Expected in containers; ensure NetworkPolicy/ingress restricts exposure. |
| F-19 | 966 asserts / 152 `random` uses | tests / non-crypto sampling (Bandit B101/B311) | Noise; `random` is not used for secrets. |

### P2 — CI/CD supply chain

Semgrep flagged 30+ `uses:` entries in `.github/workflows/ci.yml` and `release-drafter.yml` that reference mutable tags/branches instead of commit SHAs. Pin third-party actions to SHAs (Dependabot can maintain them).

### P3 — Containers

- 20/20 images lack `HEALTHCHECK` (Checkov CKV_DOCKER_2, Trivy DS-0026).
- Base images on EOL/EOL-soon runtimes: `node:18-alpine` (EOL April 2025), `python:3.10-*` (EOL October 2026), `alpine:latest` (2 uses, unpinned).
- Hadolint: 20 × DL3066 (`cd` inside `RUN`), 10 × DL3013 (pip install without version pin), 7 × DL3042 (no `--no-cache-dir`), 6 × DL3018 (apk without pin), 5 × DL3008 (apt without pin), 2 × DL3007 (`latest` tag).
- `node:18` and `python:3.10` also mean the frontend/Node services run an unsupported OpenSSL/Node line.

### Secrets — no verified leak

- Gitleaks: 4 hits, **all false positives** — two test fixtures (`api-errors.test.ts`), two image references in `k8s/deployments.yaml` where the 40-char git SHA matched the generic-api-key heuristic.
- TruffleHog: 54 raw matches, **0 verified**; they are JDBC/Postgres/MongoDB URL shapes in examples, `k8s/secret.yaml` `CHANGEME` placeholders, and vendored `node_modules` README samples.
- Trivy secret scanner: 0 findings.
- Real risk is operational: default passwords in `docker-compose.yml` and committed `CHANGEME` values in `k8s/secret.yaml`.

---

## 4. Tool matrix — all 100 requested tools

Status legend: **RAN** = executed against this repository and produced the stated result; **NO TARGET** = requires a running host/API/cluster or captured traffic; **LICENSED/GUI** = commercial or desktop-only; **N/A** = not applicable to this codebase.

### Web / API DAST

| # | Tool | Status | Result / reason |
|---|---|---|---|
| 1 | Burp Suite | LICENSED/GUI | No GUI, no live target, Pro is licensed |
| 2 | OWASP ZAP | NO TARGET | ZAP daemon requires Docker/Java install + running app; no DB/stack available |
| 3 | Wapiti | NO TARGET | Requires crawlable live HTTP target |
| 4 | Nikto | NO TARGET | Requires live web server |
| 5 | w3af | NO TARGET | Abandoned (Python 2), no live target |
| 6 | Nuclei | NO TARGET | `go install` exceeded 10 min; also needs live URLs |
| 7 | Dalfox | NO TARGET | XSS scanner needs live parameterised endpoints |
| 8 | XSStrike | NO TARGET | Same |
| 9 | Commix | NO TARGET | Command-injection scanner needs live endpoints |
| 10 | SQLmap | NO TARGET | Needs live DB-backed endpoints; no database running |
| 11 | Arachni | NO TARGET | Unmaintained; needs live target |
| 12 | Skipfish | NO TARGET | Unmaintained; needs live target |
| 13 | WhatWeb | NO TARGET | Fingerprinting needs a live host |
| 14 | httpx | NO TARGET | Installed `httpx` is the Python HTTP library, not ProjectDiscovery's prober; no host to probe |
| 15 | Katana | NO TARGET | Build timed out; crawler needs live site |
| 26 | Postman | N/A | API client, no collections/specs in repo |
| 27 | Insomnia | N/A | Same |
| 28 | 42Crunch | LICENSED | SaaS, requires account/API key |
| 29 | 42Crunch Conformance Scan | LICENSED | Needs OpenAPI spec (none found) + SaaS token |
| 30 | Schemathesis | N/A | No OpenAPI/Swagger document exists in the repo |
| 31 | RESTler | N/A | Same |
| 32 | Kiterunner | NO TARGET | Content discovery needs live API |
| 33 | Arjun | NO TARGET | Parameter discovery needs live endpoint |
| 34 | InQL | N/A | No GraphQL schema/endpoint found |
| 35 | GraphQL Voyager | N/A | No GraphQL service in repo |

### Network / infrastructure

| # | Tool | Status | Result / reason |
|---|---|---|---|
| 16 | Nmap | NO TARGET | No service listening; scanning the workstation is out of scope |
| 17 | Masscan | NO TARGET | Same, and requires raw sockets/root |
| 18 | Wireshark | N/A | No capture/traffic; no GUI |
| 19 | tcpdump | N/A | No traffic to capture; needs root |
| 20 | Netcat | NO TARGET | No listening service |
| 21 | OpenVAS | LICENSED/NO TARGET | Server-class scanner, needs target appliances |
| 22 | Greenbone | LICENSED/NO TARGET | Same |
| 23 | Nessus | LICENSED | Commercial, requires licence + target |
| 24 | RustScan | NO TARGET | Port scanner, no host to scan |
| 25 | testssl.sh | NO TARGET | No TLS endpoint; ingress not deployed |
| 56 | Prowler | NO CREDS | Needs AWS credentials |
| 57 | ScoutSuite | NO CREDS | Needs cloud credentials |
| 58 | CloudSploit | NO CREDS | Commercial/SaaS |
| 59 | Pacu | NO CREDS | AWS exploitation framework |
| 60 | Steampipe | NO CREDS | Needs cloud plugins/credentials |
| 61 | CloudMapper | NO CREDS | Needs AWS account |
| 65 | Cloud Custodian | NO CREDS | Needs cloud account; no policies in repo |
| 75 | Istio | N/A | No service mesh manifests in repo |

### SAST / code quality

| # | Tool | Status | Result |
|---|---|---|---|
| 36 | SonarQube | NOT RUN | Server + database install; licence for branch analysis; no Docker |
| 37 | Semgrep | **RAN** | 51 findings: 2 ERROR, 47 WARNING, 2 INFO (30+ are unpinned GitHub Actions) |
| 38 | Checkmarx | LICENSED | Commercial SaaS |
| 39 | Fortify SCA | LICENSED | Commercial |
| 40 | Veracode | LICENSED | SaaS |
| 41 | CodeQL | NOT LOCAL | GitHub-hosted only; prior 14 alerts reviewed and fixed in the working tree |
| 42 | Bandit | **RAN** | 1,173 findings: 0 HIGH, 9 MEDIUM (B104 ×7, B310, B102-test), 1,164 LOW (B101 asserts, B311 random) |
| 43 | Brakeman | N/A | Ruby on Rails only; no Ruby code |
| 44 | ESLint Security Plugin | **RAN** | 50 × `detect-object-injection` (noisy), 1 × `no-unsanitized/method` (escaped, FP) |
| 45 | Gosec | **RAN** | 1 LOW (G104) across notification/attendance/lms; 0 in notification and lms |
| 78 | jwt_tool | N/A | No sample JWTs; auth-service JWT handling reviewed statically by Semgrep/Bandit |
| 79 | Gitleaks | **RAN** | 4 hits, all FP |
| 80 | TruffleHog | **RAN** | 54 raw, 0 verified |
| 93 | AFL++ | N/A | No fuzz harnesses or instrumented targets |
| 94 | libFuzzer | N/A | Same |
| 95 | OSS-Fuzz | N/A | Continuous fuzzing service, not a local scan |
| 96 | Radamsa | N/A | Mutation fuzzer without a harness/target |
| 97 | Ghidra | N/A | No binaries to reverse; GUI/headless install not warranted |
| 98 | IDA Pro | LICENSED | Commercial; no binaries |
| 99 | YARA | N/A | No malware samples/binaries; rule scan would be meaningless |
| 100 | CAPE Sandbox | N/A | Requires sandbox VM + samples |

### SCA / supply chain

| # | Tool | Status | Result |
|---|---|---|---|
| 46 | Snyk | LICENSED | Requires account token/CLI auth |
| 47 | OWASP Dependency-Check | NOT RUN | Needs NVD API key and multi-GB DB; Maven Central currently rate-limits this IP |
| 48 | Trivy | **RAN** | 227 misconfigurations; 0 language vulns (DB lag); 0 secrets |
| 49 | Grype | **RAN** | 8 matches / 5 unique: brotli critical, compress high, uuid medium, fasthttp + x/crypto unknown |
| 50 | Syft | **RAN** | 871-component CycloneDX SBOM generated |
| 51 | OSV-Scanner | **RAN** | 63 vulnerable package instances / 163 unique IDs; Java resolution partially failed on `atlas-common` |
| 52 | Dependabot | RAN (GitHub) | 4 alerts previously identified and fixed |
| 53 | Renovate | N/A | Hosted bot, not a scanner |
| 54 | Mend | LICENSED | Commercial |
| 55 | Socket | LICENSED | SaaS, needs token |
| 76 | Keycloak | N/A | Not present in the repository |
| 77 | OAuth 2.0 Playground | N/A | Web tool, not a scanner |
| 81 | HashiCorp Vault | N/A | Not used |
| 82 | ZAP Authentication Tester | NO TARGET | ZAP add-on, no live target |
| 83 | LDAP Account Manager | N/A | No LDAP directory |
| 84 | Wazuh | N/A | Runtime SIEM/EDR; no deployment |
| 85 | Splunk Enterprise Security | LICENSED | Commercial SIEM |
| 86 | Elastic Security | N/A | Runtime SIEM; no deployment |
| 87 | CrowdStrike Falcon | LICENSED | Commercial EDR |
| 88 | Suricata | N/A | Needs live network traffic/interface |
| 89 | Snort | N/A | Same |
| 90 | Zeek | N/A | Same |
| 91 | OSSEC | N/A | Host-based IDS; no host fleet |
| 92 | TheHive | N/A | Incident-response platform, not a scanner |

### IaC / container / Kubernetes

| # | Tool | Status | Result |
|---|---|---|---|
| 62 | Checkov | **RAN** | 272 K8s + 22 Dockerfile failures |
| 63 | Terrascan | **RAN** | 150 K8s violations (AC_K8S_*) |
| 64 | KICS | NOT INSTALLED | Latest GitHub release (`v2.2.1`) exposes zero downloadable assets |
| 66 | Docker Scout | NO DOCKER | No daemon/images |
| 67 | Hadolint | **RAN** | 52 findings across 20 Dockerfiles |
| 68 | Dockle | NO DOCKER | Needs image inspection |
| 69 | Kubescape | NO CLUSTER | Manifest-only mode not installed; K8s covered by 4 other tools |
| 70 | kube-bench | NO CLUSTER | Checks a live node's kubelet/control-plane config |
| 71 | kube-hunter | NO TARGET | Actively probes a cluster |
| 72 | Falco | NO RUNTIME | eBPF runtime detection |
| 73 | Kyverno | NO CLUSTER | Admission controller; no policies in repo |
| 74 | kubeaudit | NO CLUSTER | Offline mode possible; coverage already provided by Trivy/Checkov/Terrascan/Kubesec |
| 75 | Istio | N/A | No mesh manifests |
| 69–74 | — | — | No cluster/kubeconfig exists in this environment |

---

## 5. Remediation order

1. **Go modules (hours):** bump `brotli` → 1.2.7, `klauspost/compress` → 1.20.2, `fasthttp` → 1.70.0, `x/crypto` → ≥ 0.58.1-0.20261009, `gorilla/websocket` → 1.5.4-0.20240701; run `go mod tidy`, `go build ./...`, `go test ./...` in all three modules.
2. **Python stack (days):** move all 11 services onto a current, pinned FastAPI/Starlette/uvicorn/urllib3/h11 set; add lockfiles (`pip-compile`/`uv lock`) and CI `pip-audit --strict`; remove unbounded `>=` ranges.
3. **Kubernetes (days):** dedicated namespaces; `readOnlyRootFilesystem: true`; `runAsNonRoot` + UID > 10000; `seccompProfile: RuntimeDefault`; drop ALL capabilities; `automountServiceAccountToken: false`; image digests; Secrets mounted as files; default-deny NetworkPolicy per namespace.
4. **Containers/CI (days):** multi-stage `HEALTHCHECK`, pinned base images on supported runtimes (`node:22`, `python:3.12+`), digest-pinned Actions, `--no-cache-dir`/pinned apk/apt packages, non-root users.
5. **Code hardening (low effort):** explicit `authTagLength` on GCM, origin allowlist for CORS, scheme allowlist in `break_glass.py`, handle G104 error, replace AES-ECB in payroll.
6. **Secrets hygiene:** make compose credentials mandatory env vars, rotate anything derived from `k8s/secret.yaml` templates, keep the file as a documented template only.

---

## 6. What could not be verified

- Java dependency CVEs (Maven Central 429) — only the known Spring Boot 4.1.1 → Netty 4.2.17 relation is confirmed.
- Any runtime/authenticated behaviour, IDOR, business-logic abuse, session handling, SSRF/XSS/SQLi exploitation, TLS configuration, and cloud/Kubernetes runtime posture — all require a deployed target, which this environment cannot provide.
- Nuclei template coverage, KICS, SonarQube, Snyk, Socket, 42Crunch and the commercial DAST/SAST suites.
