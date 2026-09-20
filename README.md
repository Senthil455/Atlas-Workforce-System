# Atlas Workforce System

A production‑grade, polyglot microservices platform for **workforce management, payroll processing, real‑time analytics, and live notifications** in a distributed environment. Trusted by **50,000+ users** across **200+ enterprises**.

---

## Overview

Atlas is a full‑stack HRMS platform built with **4 backend runtimes** (Node.js, Python, Java, Go) and a modern Next.js frontend. Each domain workload routes to its optimal runtime—Go for high‑concurrency WebSocket broadcasting, Python for AI‑powered analytics, Java for transactional payroll, and Node.js for API orchestration. All services are secured with **zero-trust authentication**, **event-driven messaging** via RabbitMQ, and monitored through a shared **observability library**.

> **Status:** See the latest CI runs on GitHub Actions for current build and test results — TypeScript type-check, Python syntax and service tests, Go vet/build, and Docker builds (see `.github/workflows/ci.yml`).

**Live demo:** `http://localhost:3000` — create an account via `POST /register` or use the seeded admin (set `ADMIN_DEFAULT_PASSWORD` in your `.env` — see `.env.example` and `services/auth-service/.env.example`; do not use the default in production).

---

## System Architecture

```
                                    Frontend (Next.js 16 / Tailwind)
                                            │
                                       API Gateway (Node.js / Express)
      ┌──────────┬──────────┬──────────┬────┼────┬──────────┬──────────┬──────────┐
      │          │          │          │         │          │          │          │
   Auth     Employee   Payroll  Attendance   Leave   Analytics  Notific.  AI Copilot
  (Node/Ex) (Py/Fast) (Java/SB) (Go/Fiber)  (Java)  (Py/Fast)  (Go/WS)  (Py/Fast)
      │          │          │          │         │          │          │
   Audit &   ATS        LMS       Perform   Postgres  MongoDB   RabbitMQ
  Compl.   (Py/Fast) (Go/Fiber) (Java/SB)     │         │          │
  (Py/Fast)                                    └─────────┴──────────┘
      └──────────────────────────┼─────────────────────────────┘
                            Redis Cache
                              Prometheus
                              + Grafana
```

### Services

| Service | Language | Framework | Database | Port | Purpose |
|---------|----------|-----------|----------|:----:|---------|
| **API Gateway** | Node.js | Express | Redis | 8080 | Central routing, signed internal JWT, RBAC, rate limiting (5/15min login), CSRF Double Submit Cookie, WebSocket proxy, audit proxy, cache invalidation |
| **Auth Service** | Node.js | Express | PostgreSQL | 8010 | User registration, httpOnly refresh cookies, rotated token revocation, MFA (TOTP), device trust with nonce replay protection, SCIM 2.0, SAML SSO, passwordless login, bcrypt cost 8 |
| **Employee Service** | Python | FastAPI | MongoDB | 8001 | Employee CRUD, directory search, multi‑tenant, NoSQL injection protection (field whitelist), atomic duplicate insert, timing attack mitigation |
| **Payroll Service** | Java | Spring Boot | PostgreSQL | 8002 | Salary calc, progressive tax, payroll runs (batch-500), transactional outbox pattern, @PositiveOrZero on all monetary fields |
| **Leave Service** | Java | Spring Boot | PostgreSQL | 8006 | Leave requests, approval workflow, @Version optimistic locking, JPQL overlap detection, state machine transitions, RabbitMQ event publisher |
| **Attendance Service** | Go | Fiber | PostgreSQL | 8005 | Clock in/out, SELECT FOR UPDATE race prevention, UNIQUE(emp, tenant, date) constraint, overtime calc, RabbitMQ event publisher |
| **Analytics Service** | Python | FastAPI | PostgreSQL | 8003 | Dept headcount, payroll trends, AI insights, RabbitMQ consumer for payroll cache invalidation, cross-consistency verification |
| **Notification Service** | Go | net/http | In‑memory | 8004 | WebSocket broadcasting with JWT auth, read/write deadlines, non-blocking select/default broadcast, origin strict check, RabbitMQ consumer |
| **Audit & Compliance** | Python | FastAPI | PostgreSQL | 8011 | Immutable audit log (SHA-256 hash chain), compliance policies, violation detection, GDPR portal, SOC2/ISO27001 readiness reports |
| **ATS** | Python | FastAPI | PostgreSQL | 8012 | Job postings, candidate tracking, file upload RCE prevention (magic bytes, MIME whitelist, 10MB limit), interview overlap constraint |
| **LMS** | Go | Fiber | PostgreSQL | 8013 | Course management, enrollments, certifications, assessments & auto-grading, learning paths, skill matrix with gap analysis |
| **Performance** | Java | Spring Boot | PostgreSQL | 8014 | OKR/goal tracking, performance reviews, 360° feedback, succession planning, peer recognitions |
| **AI Copilot** | Python | FastAPI | in‑memory | 8015 | AI chat assistant, attrition risk prediction, workforce forecasting, resume scoring & parsing, sentiment analysis, strategic insights |
| **Observability** | Python | Library | — | — | Shared library (JSON logging, Prometheus /metrics, correlation IDs, trace propagation) used by all 11 Python services |

---

## Tech Stack

### Frontend
- **Next.js 16** — App Router, React 19, SSR/SSG
- **Tailwind CSS 4** — Utility‑first styling with dark mode + glassmorphism utilities
- **TanStack Query** — Server state management
- **Zustand** — Client state (auth, toasts, workspace)
- **Recharts** — Charts and data visualization
- **Framer Motion** — Animations
- **SheetJS** — Excel (.xlsx) export
- **Radix UI** — Accessible primitives (dialog, dropdown, toast, etc.)
- **Command Palette** — Ctrl+K fuzzy search across 80+ routes
- **Global Search** — AI knowledge search with live results
- **Activity Timeline** — Type-based icons with real-time WebSocket updates
- **Custom Widgets** — Resizable/draggable dashboard widgets with context menus
- **Interactive Charts** — SVG bar & line charts with tooltips
- **Keyboard Shortcuts** — Global `use-keyboard-shortcuts` hook system
- **Smart Filters + Saved Views** — Inline editing and workspace persistence

### Infrastructure
- **Docker / docker compose** — Local orchestration (see `docker-compose.yml` for the full service list; count varies as services are added)
- **RabbitMQ** — Event‑driven messaging (5 exchanges: notifications, audit, live, employee, payroll)
- **Prometheus + Grafana** — Monitoring stack (see `prometheus.yml` for scrape targets and `docker-compose.monitoring.yml` for Grafana)
- **Kubernetes** — Production manifests (k8s/)
- **Observability Library** — Shared `atlas_observability` Python package (editable install)

---

## ✨ Key Features

### Workforce Management
- **Employee Directory** — Searchable, paginated, multi‑tenant
- **Attendance Tracking** — Clock in/out with automatic overtime calculation
- **Leave Management** — Request, approve/reject workflow
- **Payroll Engine** — Salary computation, progressive tax, payslip history

### Real‑Time Capabilities
- **WebSocket Broadcasting** — Live notifications pushed to all connected clients
- **Notification Bell** — Unread badge, dropdown preview, auto‑reconnect
- **Live Attendance** — Real‑time check‑in feed on dashboard

### Analytics & AI
- **Department Headcount** — Live breakdown from employee service
- **Payroll Trends** — Aggregated payroll by period
- **Performance Predictions** — Mock ML scoring model
- **AI‑Powered Insights** — OpenAI integration for strategic HR analysis

### Data Export
- **CSV Export** — One‑click download on all data tables
- **Excel Export** — `.xlsx` with auto‑sized columns
- **JSON Export** — Raw data export on reports page

### Security (Zero-Trust + Defense in Depth)
- **JWT Authentication** — HS256-only with explicit algorithm whitelist; `kid` injection blocked
- **httpOnly Refresh Cookies** — Refresh tokens stored in `SameSite=Strict; Secure; httpOnly` cookies (never in localStorage)
- **Rotated Token Revocation** — Reuse of a rotated refresh token revokes ALL user sessions
- **Device Nonce Replay Protection** — Redis-backed nonce (300s TTL) prevents device fingerprint replay
- **Signed Internal JWT** — Short-lived (10s) `X-Internal-Auth` JWT for inter-service auth, replacing plain header forwarding
- **MFA (TOTP)** — Time-based one-time passwords with backup codes
- **Device Trust** — Fingerprint-based device registration and verification
- **SCIM 2.0** — Automated user provisioning across identity providers (RFC 7643)
- **SAML SSO** — Single sign-on with SAML 2.0 assertion consumer
- **Passwordless Login** — Magic link authentication
- **Session Management** — Active session listing and remote revocation
- **RBAC** — Role‑based access control (admin, hr, manager, employee, recruiter, auditor)
- **Account Lockout** — Rate-limited login with failed attempt tracking (5 attempts → 15 min lockout)
- **Per-User Rate Limiting** — Action-level rate limits with headers (login: 5 req/15min, auth: 30 req/15min)
- **MFA Step-Up** — Cryptographic JWT verification required for sensitive operations
- **CSRF Double Submit Cookie** — Random CSRF token in cookie must match `X-CSRF-Token` header
- **WebSocket Origin Check** — Strict origin whitelist; empty/mismatched origins rejected
- **NoSQL Injection Protection** — Field whitelist + regex param validation for MongoDB queries
- **SQL Injection Prevention** — SQLAlchemy/GORM parameterized queries + `safe_re_match()` pattern limit
- **PAM Role Escalation Guard** — `allowed_requester_roles` enforced on privileged role assignments
- **ReDoS Protection** — 1000-char pattern limit + `re.error` catch wrapper
- **ISO Country Whitelist** — ISO 3166-1 alpha-2 allowed list for country fields
- **File Upload RCE Prevention** — Magic bytes verification + MIME whitelist + 10MB limit + random filenames
- **Geo Coordinate Validation** — Latitude (-90..90) and longitude (-180..180) range checks
- **Face Vector Quality Check** — Min 64-char vector, valid image URL prefix
- **Helmet** — HTTP security headers on all Node.js services
- **1MB Request Body Limit** — Enforced in AI service to prevent OOM

### Talent Acquisition (ATS)
- **Job Postings** — Full lifecycle (draft → publish → close → filled)
- **Candidate Tracking** — Pipeline management with status transitions
- **Application Workflow** — Apply → Screen → Interview → Offer → Hire
- **Interview Scheduling** — Multi-round with feedback and ratings
- **Offer Management** — Salary, equity, benefits with accept/decline
- **Hiring Analytics** — Conversion funnel, time-to-hire, source effectiveness

### Learning & Development (LMS)
- **Course Management** — Catalog with categories, levels, and mandatory flags
- **Enrollments** — Self-enroll and bulk enrollment with progress tracking
- **Certifications** — External cert tracking with expiry alerts
- **Assessments** — Auto-graded quizzes with attempts and scoring
- **Learning Paths** — Curated course sequences for role development
- **Skill Matrix** — Org-wide skill inventory with gap analysis

### Performance Management
- **OKR/Goal Tracking** — Key results with progress bars for individuals and teams
- **Performance Reviews** — Multi-cycle (quarterly/annual) with rating scales
- **360° Feedback** — Peer, manager, subordinate, and self reviews
- **Succession Planning** — Readiness assessment and candidate ranking
- **Peer Recognition** — Badge-based appreciation with points

### AI & Intelligence
- **AI Copilot Chat** — Conversational assistant for HR and workforce questions
- **Attrition Prediction** — ML-based risk scoring with top contributing factors
- **Workforce Forecasting** — Hiring demand and skill gap projections
- **Resume Screening** — Automated scoring and parsing against job requirements
- **Sentiment Analysis** — Employee survey and feedback sentiment detection
- **Strategic Insights** — AI-generated organizational health recommendations

### Compliance & Audit
- **Immutable Audit Log** — SHA-256 hash chain (append-only, tamper-evident)
- **Compliance Policies** — Configurable rules for SOC2, GDPR, ISO27001
- **Violation Detection** — Automated scanning against policy rules
- **GDPR Portal** — Consent management, right to be forgotten, data portability
- **Readiness Reports** — Generated SOC2/GDPR/ISO27001 compliance reports

### Executive Command Center
- **Org Health Score** — Composite metric across retention, performance, engagement, diversity
- **Real-Time Activity Feed** — Live workforce events and changes
- **Department Performance Heatmap** — Cross-department comparison
- **Attrition Risk Alerts** — Proactive notifications for at-risk employees
- **AI Recommendations** — Auto-generated strategic action items

### DevOps
- **CI/CD** — GitHub Actions for all 5 runtimes
- **Docker** — Multi‑stage builds for slim production images
- **Kubernetes** — Ready‑to‑deploy manifests with 14 services
- **Monitoring** — Prometheus metrics + Grafana dashboards
- **k6 Performance Tests** — Smoke, stress, and spike testing
- **Chaos Engineering** — Service failure and network delay injection scripts

---

## API Endpoints

### Auth Service (`:8010`)
- `POST /register` — Create account
- `POST /login` — Sign in (returns JWT + refresh token)
- `POST /refresh` — Rotate tokens
- `POST /logout` — Revoke refresh token

### Employee Service (`:8001`)
- `GET /employees` — Paginated list with search
- `GET /employees/{email}` — Get by email
- `POST /employees` — Create employee
- `PUT /employees/{email}` — Update employee
- `DELETE /employees/{email}` — Delete employee

### Payroll Service (`:8002`)
- `GET /api/payroll` — All payroll records
- `GET /api/payroll/employee/{employeeId}` — By employee
- `POST /api/payroll/run` — Process payroll (admin only)

### Analytics Service (`:8003`)
- `GET /analytics/department` — Headcount breakdown
- `GET /analytics/payroll` — Payroll trends
- `GET /analytics/performance` — Performance prediction
- `POST /analytics/ai-insights` — AI‑powered strategic insights

### Notification Service (`:8004`)
- `GET /api/notifications` — List notifications
- `POST /api/notifications` — Mark as read
- `WS /ws` — WebSocket for live events

### Attendance Service (`:8005`)
- `GET /api/attendance` — All records
- `GET /api/attendance/employee/{employeeId}` — By employee
- `POST /api/attendance/clock-in` — Clock in
- `POST /api/attendance/clock-out` — Clock out

### Leave Service (`:8006`)
- `GET /api/leave` — All requests
- `GET /api/leave/employee/{employeeId}` — By employee
- `POST /api/leave/request` — Submit request
- `PUT /api/leave/{id}/status` — Approve/reject (admin only)

### Audit & Compliance (`:8011`)
- `GET /api/v1/audit/logs` — List audit logs (paginated, filterable)
- `POST /api/v1/audit/log` — Create audit entry (internal)
- `GET /api/v1/audit/verify-chain` — Verify audit hash chain integrity
- `GET /api/v1/compliance/policies` — List compliance policies
- `POST /api/v1/compliance/policies` — Create policy
- `GET /api/v1/compliance/violations` — List violations
- `POST /api/v1/compliance/scan` — Trigger compliance scan
- `GET /api/v1/compliance/reports/{type}` — SOC2/GDPR/ISO27001 readiness report
- `GET /api/v1/gdpr/consents/{employee_id}` — Get consent records
- `POST /api/v1/gdpr/forget/{employee_id}` — Right to be forgotten
- `GET /api/v1/gdpr/data-portability/{employee_id}` — Export employee data

### ATS (`:8012`)
- `GET /api/v1/jobs` — List job postings (paginated, filterable)
- `POST /api/v1/jobs` — Create job
- `POST /api/v1/jobs/{id}/publish` — Publish job
- `GET /api/v1/candidates` — List candidates (paginated)
- `POST /api/v1/candidates` — Create candidate
- `GET /api/v1/applications` — List applications
- `POST /api/v1/applications` — Submit application
- `PUT /api/v1/applications/{id}/status` — Update application status
- `POST /api/v1/interviews` — Schedule interview
- `PUT /api/v1/interviews/{id}/feedback` — Submit interview feedback
- `POST /api/v1/offers` — Create offer
- `POST /api/v1/offers/{id}/send` — Send offer to candidate
- `GET /api/v1/analytics/conversion-funnel` — Hiring pipeline analytics

### LMS (`:8013`)
- `GET /api/v1/courses` — List courses (filterable by category, level)
- `POST /api/v1/courses` — Create course
- `POST /api/v1/enrollments` — Enroll employee
- `PUT /api/v1/enrollments/{id}/progress` — Update course progress
- `PUT /api/v1/enrollments/{id}/complete` — Complete course (generates certificate)
- `GET /api/v1/certifications` — List certifications
- `POST /api/v1/assessments` — Create assessment
- `POST /api/v1/assessments/{id}/attempt` — Start assessment attempt
- `PUT /api/v1/assessments/{id}/attempt` — Submit and auto-grade
- `GET /api/v1/skills/gap-analysis` — Analyze skill gaps
- `GET /api/v1/skills/matrix` — Org-wide skill matrix

### Performance (`:8014`)
- `GET /api/v1/goals` — List goals/OKRs
- `POST /api/v1/goals` — Create goal
- `PUT /api/v1/goals/{id}/progress` — Update key result progress
- `GET /api/v1/reviews` — List performance reviews
- `POST /api/v1/reviews` — Create review cycle
- `PUT /api/v1/reviews/{id}/submit` — Submit completed review
- `POST /api/v1/feedback` — Submit 360° feedback
- `GET /api/v1/succession/plans` — List succession plans
- `POST /api/v1/succession/candidates` — Add candidate to plan
- `POST /api/v1/recognitions` — Give peer recognition
- `GET /api/v1/analytics/department-ratings` — Department performance averages

### AI Copilot (`:8015`)
- `POST /api/v1/copilot/chat` — Chat with AI assistant
- `POST /api/v1/predict/attrition-risk` — Predict employee attrition
- `POST /api/v1/predict/performance` — Forecast performance scores
- `POST /api/v1/forecast/hiring-demand` — Predict hiring needs
- `POST /api/v1/forecast/skill-gap` — Analyze skill gaps
- `POST /api/v1/resume/score` — Score resume against job description
- `POST /api/v1/sentiment/analyze` — Analyze text sentiment

### Auth Security (`:8010`)
- `POST /mfa/setup` — Generate TOTP secret and backup codes
- `POST /mfa/verify` — Verify TOTP during setup
- `POST /mfa/validate` — Validate TOTP during login
- `GET /sessions` — List active sessions
- `DELETE /sessions/{id}` — Revoke session
- `GET /scim/v2/Users` — SCIM list users
- `POST /scim/v2/Users` — SCIM create user
- `POST /saml/acs` — SAML assertion consumer
- `POST /auth/passwordless/request` — Request magic link

---

## Getting Started

### Prerequisites
- **Docker** + **docker compose**
- **Git**
- **Python 3.9+** (for local development of Python services)

### Local Setup (observability library)

```bash
# Install shared observability library (required before running Python services)
pip install -e services/atlas_observability/
```

### Run the Project (Docker)

```bash
git clone https://github.com/Senthil455/Atlas-Workforce-System.git
cd Atlas-Workforce-System
docker compose up --build
```

This starts **18 containers**: postgres, mongodb, redis, rabbitmq + 14 application services.

### Run Monitoring Stack

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

### Access

| Service | URL |
|---------|-----|
| Frontend | `http://localhost:3000` |
| API Gateway | `http://localhost:8080` |
| Auth Service | `http://localhost:8010/docs` |
| Analytics Service | `http://localhost:8003/docs` |
| Audit & Compliance | `http://localhost:8011/docs` |
| ATS | `http://localhost:8012/docs` |
| AI Copilot | `http://localhost:8015/docs` |
| RabbitMQ UI | `http://localhost:15672` (guest/guest) |
| Grafana | `http://localhost:3001` (user `admin`, password from `GRAFANA_ADMIN_PASSWORD` in `.env` — see `docker-compose.monitoring.yml`) |
| Prometheus | `http://localhost:9090` |

### Default Credentials

- **Admin:** `admin@atlas.io` — password is the value of `ADMIN_DEFAULT_PASSWORD` in your `.env` (see `.env.example`). Do not use a default password in production.

---

## Development

### Project Structure

```
Atlas-Workforce-System/
├── frontend/                            # Next.js application (port 3000)
│   ├── src/
│   │   ├── app/                         # App Router pages (31 AI, 23 live, 6 security)
│   │   ├── components/                  # UI components (command palette, global search,
│   │   │                                #   smart filters, saved views, activity timeline,
│   │   │                                #   advanced table, customizable widget, interactive chart)
│   │   ├── hooks/                       # Custom hooks (use-keyboard-shortcuts, use-online-status)
│   │   ├── stores/                      # Zustand stores (auth-store, workspace-store)
│   │   └── lib/                         # API client, auth helpers
│   ├── components/ui/                   # shadcn/ui primitives + ErrorBoundary, OfflineBanner
│   └── globals.css                      # Glassmorphism, WCAG, skeleton, scrollbar utilities
├── services/
│   ├── api-gateway-node/                # Node.js API Gateway (8080)
│   ├── auth-service/                    # Node.js Auth (8010) — MFA, SCIM, SAML, sessions
│   ├── employee-python-service/         # Python FastAPI Employee (8001)
│   ├── payroll-java-service/            # Java Spring Boot Payroll (8002)
│   ├── analytics-python-service/        # Python FastAPI Analytics (8003)
│   ├── notification-go-service/         # Go WebSocket + REST Notifications (8004)
│   ├── attendance-service/              # Go Fiber Attendance (8005)
│   ├── leave-service/                   # Java Spring Boot Leave (8006)
│   ├── audit-compliance-service/        # Python Immutable Audit + Compliance (8011)
│   ├── ats-service/                     # Python Applicant Tracking System (8012)
│   ├── lms-service/                     # Go Learning Management System (8013)
│   ├── performance-service/             # Java OKR/Reviews/Succession (8014)
│   ├── ai-copilot-service/              # Python AI Copilot + Predictions (8015)
│   ├── atlas_observability/             # Shared Python library (logging, metrics, tracing)
│   └── integration-service/             # Python (future)
├── tests/                               # Integration, performance, chaos tests
│   ├── performance/                     # k6 smoke/stress/spike
│   ├── chaos/                           # Service failure + network delay scripts
│   └── integration/                     # End-to-end workflow tests
├── docs/                                # Architecture docs
├── k8s/                                 # Kubernetes manifests (14 services)
├── .github/workflows/                   # CI pipeline (see `ci.yml` for current matrix)
├── docker-compose.yml                   # Main orchestration (see file for service count)
├── docker-compose.monitoring.yml        # Prometheus + Grafana
├── Makefile                             # Dev CLI commands
└── prometheus.yml                       # Metrics config (see file for scrape targets)
```

### Available Commands

```bash
make up          # Start all services
make down        # Stop all services
make logs        # Tail container logs
make test        # Run all unit tests
make build-all   # Force rebuild images
```

---

## Testing

Each service has unit tests:

```bash
# Install observability dependency first
pip install -e services/atlas_observability/

# Node.js services
cd services/auth-service && npm test
cd services/api-gateway-node && npm test

# Python services
cd services/employee-python-service && python -m pytest -v
cd services/analytics-python-service && python -m pytest -v

# Java services
cd services/payroll-java-service && mvn compile
cd services/leave-service && mvn compile

# Go services (build check)
cd services/attendance-service && go build ./...
cd services/notification-go-service && go build ./...

# TypeScript (frontend type check)
cd frontend && npx tsc --noEmit

# E2E (Playwright)
cd frontend && npx playwright test

# Or all at once
make test
```

### QA Status

For current test results see the latest CI runs: `.github/workflows/ci.yml` (frontend type-check, Python syntax and service tests, Go vet/build, Docker builds, and the `ci-coverage-check` gate). Counts in this section are intentionally not hard-coded here — check the Actions tab for the authoritative numbers.

### Known gaps (tracked as issues)

The following areas are known to be incomplete and are tracked as open issues — see the Issues tab for details. They are not asserted as fixed:

- CI coverage for some Go/Python/Java services and Docker images (see CI matrix issue)
- E2E (Playwright) and k6 performance suites not yet run on every PR (see Playwright/k6 issue)
- Integration tests in `tests/integration` not yet wired into CI
- A few services still have skipped or placeholder tests
- Observability tracing (OTel) and schema-per-tenant are roadmap items, not current state (see docs/enterprise-architecture.md)

---

## Monitoring

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

Most application services expose Prometheus metrics — see `prometheus.yml` for the full list of scrape targets (Go/Python services use `/metrics`, Java payroll and leave use `/actuator/prometheus`). Each request is logged with structured JSON (correlation ID, trace ID, duration, status).

- **Prometheus** — `http://localhost:9090`
- **Grafana** — `http://localhost:3001` (user `admin`, password from `GRAFANA_ADMIN_PASSWORD` in `.env`)

## Author

**Senthil Raja R**  
Full Stack Developer | AI Automation Enthusiast

- Email: [senthilrajasen637@gmail.com](mailto:senthilrajasen637@gmail.com)
- LinkedIn: [senthil-raja-r](https://www.linkedin.com/in/senthil-raja-r-a29839329/)

---

## License

MIT
