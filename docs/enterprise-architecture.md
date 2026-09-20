# Atlas Workforce Intelligence Platform — Enterprise Architecture

## Domain-Driven Design: Bounded Contexts

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        ATLAS WORKFORCE INTELLIGENCE PLATFORM                │
│                                                                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │  IAM &   │ │  Core HR │ │   ATS    │ │   LMS    │ │  Performance &   │  │
│  │ Security │ │          │ │          │ │          │ │  Succession       │  │
│  │          │ │          │ │          │ │          │ │                   │  │
│  │ • AuthN  │ │ • Employ │ │ • Reqs   │ │ • Course │ │ • Goals/OKRs     │  │
│  │ • AuthZ  │ │ • Org   │ │ • Candid │ │ • Enroll │ │ • Reviews        │  │
│  │ • MFA    │ │ • Payrl │ │ • Hire   │ │ • Track  │ │ • 360° Feedback  │  │
│  │ • SCIM   │ │ • Leave │ │ • Offer  │ │ • Cert   │ │ • Succession     │  │
│  │ • Audit  │ │ • Attend│ │ • Onbrd  │ │ • Skill  │ │ • Skills Matrix  │  │
│  └────┬─────┘ └────┬────┘ └────┬─────┘ └────┬─────┘ └────────┬─────────┘  │
│       └────────────┼───────────┼─────────────┼────────────────┘            │
│                    ▼           ▼             ▼                              │
│  ┌──────────────────────────────────────────────────────────────────┐      │
│  │                    EVENT BUS (RabbitMQ)                          │      │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │      │
│  │  │employee  │ │payroll   │ │candidate │ │performance       │   │      │
│  │  │.created  │ │.processed│ │.hired    │ │.review.completed │   │      │
│  │  │leave     │ │clock     │ │course    │ │skill.updated     │   │      │
│  │  │.approved │ │.in       │ │.enrolled │ │                  │   │      │
│  └──────────────────────────────────────────────────────────────────┘      │
│       │            │            │            │                             │
│       ▼            ▼            ▼            ▼                             │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐              │
│  │   AI     │ │Analytics │ │ Notifi-  │ │  Compliance      │              │
│  │ Copilot  │ │ & Fore-  │ │ cation   │ │  & Audit         │              │
│  │          │ │ casting  │ │ Service  │ │                  │              │
│  │ • Chat   │ │          │ │          │ │ • Immutable Log  │              │
│  │ • Predict│ │ • Trends │ │ • Push   │ │ • SOC2 Controls  │              │
│  │ • Resume │ │ • ML     │ │ • Email  │ │ • GDPR Portal    │              │
│  │ • Summar │ │ • Plan   │ │ • SMS    │ │ • ISO27001       │              │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Enterprise CQRS Event Schemas

### Domain Events (Published to RabbitMQ)

```json
// employee.created
{ "eventType": "employee.created", "version": 1, "tenantId": "t1",
  "data": { "employeeId": "uuid", "email": "...", "departmentId": "uuid", "role": "engineer" },
  "metadata": { "correlationId": "uuid", "userId": "uuid", "timestamp": "ISO8601" } }

// candidate.hired
{ "eventType": "candidate.hired", "version": 1, "tenantId": "t1",
  "data": { "candidateId": "uuid", "jobId": "uuid", "offerAcceptedAt": "ISO8601",
            "startDate": "ISO8601", "employeeId": "uuid" } }

// performance.review.completed
{ "eventType": "performance.review.completed", "version": 1, "tenantId": "t1",
  "data": { "employeeId": "uuid", "reviewerId": "uuid", "period": "2026-Q2",
            "overallScore": 4.5, "goalAchievementRate": 0.85 } }

// compliance.policy.violation
{ "eventType": "compliance.policy.violation", "version": 1, "tenantId": "t1",
  "data": { "employeeId": "uuid", "policyId": "uuid", "severity": "HIGH",
            "description": "...", "detectedAt": "ISO8601" } }

// audit.access.sensitive
{ "eventType": "audit.access.sensitive", "version": 1, "tenantId": "t1",
  "data": { "userId": "uuid", "resourceType": "payroll_record", "resourceId": "uuid",
            "action": "READ", "ipAddress": "..." },
  "metadata": { "deviceId": "uuid", "sessionId": "uuid" } }
```

## Zero-Trust Security Model

```
┌────────────────────────────────────────────────────────────────┐
│                     ZERO TRUST ARCHITECTURE                     │
│                                                                │
│  User → Device Trust → MFA → Gateway → Service → Data         │
│    │        │           │       │         │        │           │
│    │   Fingerprint    TOTP   JWT+     mTLS    Field-          │
│    │   /mTLS         /Web-  RBAC             Level            │
│    │                  Authn                      Encryption    │
│    ▼                                                    │
│  Session + Risk Score → Continuous Verification       │
└────────────────────────────────────────────────────────┘
```

## Multi-Tenant SaaS Architecture

- **Isolation mode:** Single database with `tenant_id` column/field (PostgreSQL `tenant_id` column, MongoDB `tenant_id` field; see `services/*/main.py` and `MONGO_DB=atlas_db`). Schema-per-tenant and collection-per-tenant are roadmap items, not current.
- **Tenant context:** Propagated via HTTP headers (X-Tenant-Id), JWT claims, and event metadata
- **SCIM 2.0:** /scim/v2/Users, /scim/v2/Groups for automated provisioning
- **Billing tiers:** Free, Pro, Enterprise — feature flags per tier (roadmap)

## Immutable Audit Log (Append-Only)

- **Storage:** PostgreSQL with INSERT-only privileges (no UPDATE/DELETE)
- **Hash chain:** Each entry contains SHA-256 hash of previous entry
- **Fields:** event_id, tenant_id, timestamp, actor_id, action, resource_type, resource_id, old_value, new_value, ip_address, user_agent, session_id, device_fingerprint, hash, previous_hash
- **Retention:** 7 years for SOC2 / GDPR compliance

## Observability (current and roadmap)

- **Metrics:** Prometheus exporter → Grafana dashboards (see `prometheus.yml`)
- **Logs:** Structured JSON logging via `atlas_observability` (JSON logging, correlation IDs)
- **Traces / OTel (roadmap):** `atlas_observability` currently exposes `AtlasTracingMiddleware` but no service registers it and there is no OTLP exporter, Jaeger/Tempo, Loki or auto-discovered service map yet. The OTLP → Jaeger/Tempo and Loki pipeline are planned, not current.

## RBAC Matrix (Enterprise)

| Role         | Employees | Payroll | ATS  | LMS  | Perf  | Reports | Settings | Audit |
|-------------|:---------:|:-------:|:----:|:----:|:-----:|:-------:|:--------:|:-----:|
| Super Admin |    CRUD   |  CRUD   | CRUD | CRUD |  CRUD |   CRUD  |   CRUD   |  CRUD |
| HR Admin    |    CRUD   |  CRUD   | CRUD | CRUD |  CRUD |   CRUD  |   R/U    |  R    |
| HR Manager  |    CRU    |  R      | CRUD | R    |  CRUD |   R     |   R      |  R    |
| Manager     |    R      |  R      | -    | R    |  RU   |   R     |   -      |  -    |
| Employee    |    R      |  R      | -    | CRU  |  R    |   R     |   RU     |  -    |
| Recruiter   |    R      |  -      | CRUD | -    |  -    |   R     |   -      |  -    |
| Auditor     |    R      |  R      | R    | R    |  R    |   R     |   R      |  R    |
| System      |    -      |  -      | -    | -    |  -    |   -     |   -      |  W    |

## Phase Delivery Roadmap

| Phase | Theme | Services | Timeline |
|-------|-------|----------|----------|
| 0 | Foundations | IAM + Audit + OTel | Now |
| 1 | Talent Acquisition | ATS + Candidate Portal | Sprint 1-2 |
| 2 | Learning & Growth | LMS + Skills | Sprint 3-4 |
| 3 | Performance | OKRs + 360° + Succession | Sprint 5-6 |
| 4 | Intelligence | AI Copilot + Forecasting | Sprint 7-8 |
| 5 | UX | Command Center + Mobile | Sprint 9-10 |
| 6 | Operations | K8s DR + Blue/Green | Sprint 11-12 |

## Testing Strategy

| Layer | Tool | Focus |
|-------|------|-------|
| Unit | jest/pytest/JUnit | Domain logic, validators |
| Integration | supertest/httpx/WebMvcTest | API contracts, DB queries |
| Contract | Pact | Service-to-service agreements |
| E2E | Playwright | Critical user journeys |
| Performance | k6 | Latency < 200ms p95 |
| Security | OWASP ZAP | Penetration testing |
| Chaos | Chaos Mesh | Fault tolerance |
