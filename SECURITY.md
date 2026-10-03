# Security Policy

Atlas Workforce System handles workforce, payroll, and identity data. Security reports are taken seriously.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| `main` (active Sprint 26 work) | ✅ |
| Tagged releases (if any) | ✅ best-effort for latest tag |
| Old forks / stale branches | ❌ |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for vulnerabilities.**

- Email: **senthilrajasen637@gmail.com** with subject `[SECURITY] <short summary>`
- Include: affected service + version/commit, repro steps, impact, and any PoC (redact real PII/secrets).
- Expect acknowledgement within **72 hours**. We aim to triage within 7 days and will keep you updated.
- Please give us reasonable time to fix before public disclosure (90 days default).

Mentors/Sprint contributors: if you spot a live secret in the repo or a critical auth bypass during Sprint 26, stop, do not exploit further, and report privately as above.

## Ground Rules for Contributors

- Never commit `.env`, tokens, keys, or real credentials. Use `.env.example` placeholders.
- Do not weaken zero-trust controls (JWT HS256 whitelist, internal JWT 10s TTL, httpOnly refresh cookies, MFA step-up, RBAC, rate limits, CSRF double-submit, WS origin check, upload magic-bytes checks).
- `docker-compose.yml` must keep `NODE_ENV=production` default + unconditional secret guards (enforced by `compose-safety-check`).
- Security-sensitive PRs (auth, SCIM/SAML, sessions, payroll money fields) require extra-careful tests and must pass `security-scan` (Trivy), `bandit`/`gosec` SARIF gates, and `npm audit --audit-level=high`.

## Preferred Scope for Sprint 26

Safe: docs, UI, tests, k6/Playwright, non-auth bug fixes.
Sensitive (mentor + maintainer approval required): anything under `services/auth-service`, `services/api-gateway-node` (auth/rate-limit/CSRF), `security-service`, payroll transactions, audit hash chain.

Thank you for keeping Atlas and its users safe.
