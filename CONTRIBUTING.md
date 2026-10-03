# Contributing to Atlas Workforce System

Thank you for your interest in contributing! This project is part of **OpenSourceNest Sprint 26 (Sept 20 – Oct 17, 2026)** — a 4-week, mentor-shielded sprint.

> **Sprint contributors: read this entire file before writing code.** PRs that ignore this guide will be asked to redo the workflow.

Please also read our [Code of Conduct](CODE_OF_CONDUCT.md) and [Security Policy](SECURITY.md).

---

## 1. OSN Sprint 26 — How to contribute (mandatory)

We follow the official Sprint 26 flow. Mentors triage first; maintainers do final review/merge.

1. **Find your project** — pick this repo from the Sprint 26 project board.
2. **Read and claim (no code yet)**
   - Read this `CONTRIBUTING.md` fully.
   - Find an open issue tagged [`osn-sprint-26`](https://github.com/Senthil455/Atlas-Workforce-System/labels/osn-sprint-26).
   - Leave a comment asking to be assigned (e.g. `/assign` or "Please assign me").
   - **Do NOT open a Pull Request for an unassigned issue.** Unclaimed PRs will be closed.
   - One issue per contributor at a time unless a mentor says otherwise.
3. **Build and connect**
   - Fork the repo, create a branch from `main` (see §4).
   - If you get stuck, ask in **OpenSourceNest WhatsApp / Discord** and tag a mentor. **Do not ping the maintainer directly.**
4. **Submit for review**
   - Open a PR from your fork using the PR template.
   - Link the issue (`Closes #<number>`).
   - An OSN mentor reviews first for style/tests/cleanliness. After mentor approval, the maintainer does the final merge.

Good first areas for Sprint 26: docs fixes, UI tweaks (frontend), test coverage gaps (see `README.md` → Known gaps), k6/Playwright wiring, small bug fixes in one service. Avoid touching secrets, auth crypto, or multi-service refactors unless the issue explicitly asks.

---

## 2. Prerequisites

- **Git**, **Docker + Docker Compose v2**
- **Node.js 20** (frontend, `api-gateway-node`, `auth-service`)
- **Python 3.11** (all `*-python-service`, `ats-service`, `audit-compliance-service`, `ai-copilot-service`, etc.)
- **Go 1.21** (`notification-go-service`, `attendance-service`, `lms-service`)
- **JDK 17 + Maven** (`payroll-java-service`, `leave-service`, `performance-service`)
- Optional: `k6`, Playwright browsers (`npx playwright install --with-deps chromium`)

---

## 3. Quick start (local stack)

```bash
git clone https://github.com/Senthil455/Atlas-Workforce-System.git
cd Atlas-Workforce-System

# 1. Env — never commit .env
cp .env.example .env
# Fill in secrets: JWT_SECRET, INTERNAL_JWT_SECRET, POSTGRES_PASSWORD,
# MONGO_PASSWORD, ADMIN_DEFAULT_PASSWORD, etc.
# Generate strong values: openssl rand -base64 64

# 2. Shared Python observability lib (required before running Python services locally)
pip install -e services/atlas_observability/

# 3. Start everything
docker compose up --build
# or detached:
# make up
# make logs   # tail logs
# make status # docker compose ps
# make down   # stop
```

Access:

| Service | URL |
|---------|-----|
| Frontend | `http://localhost:3000` |
| API Gateway | `http://localhost:8080` |
| Auth (`:8010`), Analytics (`:8003`), Audit (`:8011`), ATS (`:8012`), AI Copilot (`:8015`) | `http://localhost:<port>/docs` |
| RabbitMQ UI | `http://localhost:15672` (guest/guest) |
| Grafana | `http://localhost:3001` (admin / `GRAFANA_ADMIN_PASSWORD` from `.env`) |
| Prometheus | `http://localhost:9090` |

Default login: `admin@atlas.io` — password is whatever you set as `ADMIN_DEFAULT_PASSWORD` in `.env`. Never use defaults in production.

Monitoring stack (optional):

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

---

## 4. Branching & commits

Branch from `main`:

```bash
git checkout main && git pull
git checkout -b <type>/<issue>-<short-desc>
# types: feat | fix | docs | test | chore | perf | refactor | ci
# example: fix/42-attendance-overtime-null
```

- Keep PRs small and scoped to **one issue / one service** where possible.
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat(ats): add ...`, `fix(auth): ...`, `docs: ...`, `test(lms): ...`.
- Do not commit `.env`, binaries (`*.exe`), logs, `tsbuildinfo`, `.next/`, or files >1MB — CI (`guard-against-binaries`) will fail.

---

## 5. Development per stack

### Frontend (`frontend/`, Next.js 16 + Tailwind 4)

```bash
cd frontend
npm ci
npm run dev      # dev server
npm run lint     # eslint — must pass
npx tsc --noEmit # typecheck — must pass
npm test         # vitest
npm run build    # Next build — must pass (NEXT_PUBLIC_API_URL=http://localhost:8080/api)
npx playwright test --project=chromium  # e2e (needs built app)
```

### Node services (`services/api-gateway-node`, `services/auth-service`)

```bash
cd services/auth-service   # or api-gateway-node
npm ci
npm test
node -c index.js           # syntax check (mirrors CI)
npm audit --audit-level=high
```

### Python services (`employee-python-service`, `analytics-python-service`, `ats-service`, `audit-compliance-service`, `ai-copilot-service`, `ai-service`, `integration-service`, `security-service`, `live-service`, `employee-lifecycle-service`, `workforce-planning-service`)

```bash
cd services/<service>
pip install -r requirements.txt
python -m py_compile main.py
flake8 . --count --select=E9,F63,F7,F82 --show-source --statistics --max-line-length=120
pytest -v
```

### Go services (`notification-go-service`, `attendance-service`, `lms-service`)

```bash
cd services/<service>
go mod download
go vet ./...
go build -v ./...
go test -v -count=1 ./...
```

### Java services (`payroll-java-service`, `leave-service`, `performance-service`)

```bash
# install shared lib once
cd services/atlas-common && mvn install -DskipTests
cd ../payroll-java-service  # or leave-service / performance-service
mvn clean test
```

### All at once

```bash
make test       # backend unit tests (node + python + java)
make test-e2e   # Playwright chromium suite
```

---

## 6. Pull Request process

1. Sync with `main`, run the relevant tests/lints above.
2. Fill in `.github/PULL_REQUEST_TEMPLATE.md` completely:
   - `Closes #<issue-number>` (must be an `osn-sprint-26` issue you were assigned).
   - Confirm: "I was assigned this issue / I read CONTRIBUTING.md".
   - Screenshots for UI changes; API examples for endpoint changes.
3. CI must be green: `frontend-check`, `node/go/python/java-services-check`, `docker-build`, `compose-safety-check`, `k8s-validate`, `ci-coverage-check`, `e2e-tests`, `k6-performance`, `security-scan`, `guard-against-binaries`.
4. Mentor reviews first → requested changes are normal. After mentor approval, maintainer merges. Do not merge `main` into your branch repeatedly; rebase if asked.

PRs may be closed if they: have no linked assigned issue, bundle unrelated changes, break tests/lint, add secrets/defaults, or add large binaries.

---

## 7. Code style

- Frontend/Node: ESLint + Prettier conventions, TypeScript strict (`tsc --noEmit` clean).
- Python: PEP8, max line 120 for the CI gate (`flake8` select E9,F63,F7,F82), no unused imports.
- Go: `gofmt` + `go vet` clean.
- Java: Maven fmt conventions of the module; keep `@PositiveOrZero`, `@Version` semantics intact on money/versioned entities.
- Keep existing zero-trust patterns: never log secrets/tokens, never bypass `X-Internal-Auth` / CSRF / origin checks, parameterize all DB queries.

---

## 8. Security — read before touching auth/payments

This is an HRMS/payroll system with real PII. See [SECURITY.md](SECURITY.md).

- **Never** commit secrets, tokens, private keys, or `.env`. Use `.env.example` placeholders only.
- Do not weaken: JWT HS256 whitelist, `kid` blocking, httpOnly `SameSite=Strict; Secure` cookies, rotated-token revocation, device nonce (Redis 300s TTL), short-lived internal JWT (10s), MFA/TOTP, RBAC, login rate limit (5/15min), CSRF double-submit, WS origin check, file-upload magic-bytes + 10MB limit.
- Report vulnerabilities privately per `SECURITY.md` — do not open public issues for them.

`docker-compose.yml` defaults to `NODE_ENV=production` and unconditional secret guards on purpose — do not change defaults to `development` or gate guards on `NODE_ENV` (CI `compose-safety-check` enforces this).

---

## 9. Reporting issues

Use the issue templates (`.github/ISSUE_TEMPLATE/`). Include: service + port, repro steps, expected vs actual, logs (`docker compose logs <service>`), env (OS, Docker version, commit SHA). For Sprint 26 task ideas, use the **Sprint task** template and leave labeling to maintainers (`osn-sprint-26` + `good first issue` where fitting).

---

## 10. Maintainers

- Async-first: GitHub issues/PRs beat DMs. Author: Senthil Raja R — see `README.md` for contact.
- Maintainer Sprint checklist: [`docs/osn-sprint-26-maintainer-guide.md`](docs/osn-sprint-26-maintainer-guide.md).

Thank you for keeping Atlas spam-free and shippable. Happy sprint!
