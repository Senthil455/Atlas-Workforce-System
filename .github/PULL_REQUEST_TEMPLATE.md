## Summary

> What does this PR change?

Closes #<!-- issue number -->

## Sprint 26 checklist (required for `osn-sprint-26` PRs)

- [ ] I read `CONTRIBUTING.md` (Sprint workflow & Definition of Done) and `CODE_OF_CONDUCT.md`
- [ ] I was **assigned** this issue before opening this PR (no unassigned PRs)
- [ ] This PR is scoped to the linked issue only (no unrelated changes)
- [ ] I asked mentors on WhatsApp/Discord if stuck (did not DM maintainer)

## Type of change

- [ ] fix
- [ ] feat
- [ ] docs
- [ ] test / ci
- [ ] chore / refactor / perf

## Service(s) touched

<!-- e.g. frontend / auth-service:8010 / ats-service:8012 / docs only -->

## Definition of Done (DoD) Checklist

### 1. Tests
- [ ] Automated tests added or updated for new/modified code
- [ ] Regression test included for bug fixes; edge cases and negative cases covered
- [ ] Multi-tenant isolation verified (operations scoped to `tenant_id` where applicable)
- [ ] Local tests pass cleanly (`make test` / service test commands)

### 2. Documentation & Changelog
- [ ] Documentation updated under `docs/` or `README.md` if public API, CLI, or behavior changed
- [ ] `.env.example` updated if new configuration or environment variables were added
- [ ] Changelog fragment / summary of user-facing or breaking changes included below

### 3. Security & Zero-Trust
- [ ] No secrets, credentials, tokens, or `.env` files committed
- [ ] RBAC permissions & auth guards enforced
- [ ] All database queries parameterized; input validated/sanitized
- [ ] `npm audit --audit-level=high` clean (if Node/frontend touched)

### 4. Database & Migrations (if applicable)
- [ ] Schema changes are backward-compatible with safe defaults/nullability
- [ ] Migration scripts (Flyway/Alembic/Prisma) included and tested
- [ ] Rollback instructions documented
- [ ] N/A — no database schema changes

### 5. DoD Escape Hatch
- [ ] All applicable DoD criteria are fully satisfied in this PR
- [ ] Follow-up issue created for non-critical deferred item (mentor-approved): #<!-- issue number -->

## How to test

```bash
# commands you ran, e.g.:
# cd frontend && npm run lint && npx tsc --noEmit && npm test
# cd services/<service> && pytest -v | go test ./... | mvn clean test
```

## Proof & Reproduction Evidence

<!-- screenshots for UI changes, curl/API response snippets, or test execution logs -->

## Mentor / maintainer notes

<!-- anything mentors should inspect first -->
