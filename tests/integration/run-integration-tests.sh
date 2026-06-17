#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════
#  Atlas Workforce Platform — Integration Test Suite
#  Tests: Auth, Employee CRUD, ATS Pipeline, LMS, Audit, AI Copilot
# ═══════════════════════════════════════════════════════════════════════════

# ── Configuration ──────────────────────────────────────────────────────────
API_GATEWAY="${API_GATEWAY:-http://localhost:8080}"
AUTH_URL="${AUTH_URL:-http://localhost:8010}"
COMPOSE_DIR="${COMPOSE_DIR:-$(dirname "$0")/../..}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-atlas-workforce-system}"
MAX_RETRIES=30
RETRY_INTERVAL=5

# ── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

PASS=0
FAIL=0
TESTS=()

report_pass() { PASS=$((PASS + 1)); echo -e "  ${GREEN}✓ PASS${NC}  $1"; }
report_fail() { FAIL=$((FAIL + 1)); echo -e "  ${RED}✗ FAIL${NC}  $1"; }
log_info()   { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_step()   { echo ""; echo -e "${BOLD}─── $* ───${NC}"; }
log_banner() { echo ""; echo "════════════════════════════════════════════════════"; echo "  $*"; echo "════════════════════════════════════════════════════"; }

cleanup() {
  log_info "Cleaning up..."
  docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" down --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait_for_health() {
  local url="$1"
  local name="$2"
  local retries=0
  while [ $retries -lt $MAX_RETRIES ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      report_pass "$name is healthy"
      return 0
    fi
    retries=$((retries + 1))
    sleep "$RETRY_INTERVAL"
  done
  report_fail "$name failed health check after $((MAX_RETRIES * RETRY_INTERVAL))s"
  return 1
}

# ────────────────────────────────────────────────────────────────────────────
#  1. Start services
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 1: Starting all services"

cd "$COMPOSE_DIR"
log_info "Running: docker compose -p $COMPOSE_PROJECT -f $COMPOSE_FILE up -d"
docker compose -p "$COMPOSE_PROJECT" -f "$COMPOSE_FILE" up -d

log_info "Waiting for infrastructure (postgres, mongodb, redis, rabbitmq)..."
sleep 15

log_info "Waiting for service health checks..."
wait_for_health "$API_GATEWAY/health" "API Gateway" || true
wait_for_health "$AUTH_URL/health" "Auth Service" || true

log_info "Giving services time to initialize..."
sleep 10

# ────────────────────────────────────────────────────────────────────────────
#  2. Authentication Flow
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 2: Authentication Flow Test"

TOKEN=""
TESTS+=("Register new user")
REGISTER_RES=$(curl -sf -X POST "$AUTH_URL/register" \
  -H 'Content-Type: application/json' \
  -d '{"email":"inttest@atlas.io","password":"TestPass123!","name":"Integration Tester","department":"QA","position":"Test Engineer"}') || true

if echo "$REGISTER_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if d.get('message','').startswith('User registered') else 1)" 2>/dev/null; then
  report_pass "Register new user — $REGISTER_RES"
else
  if echo "$REGISTER_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'already exists' in d.get('message','') else 1)" 2>/dev/null; then
    report_pass "Register new user — user already exists (ok)"
  else
    echo "  Register response: $REGISTER_RES"
    report_fail "Register new user"
  fi
fi

TESTS+=("Login with valid credentials")
LOGIN_RES=$(curl -sf -X POST "$AUTH_URL/login" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@atlas.io","password":"ChangeMe123!"}') || { report_fail "Login with valid credentials"; LOGIN_RES=""; }

if [ -n "$LOGIN_RES" ]; then
  TOKEN=$(echo "$LOGIN_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null) || TOKEN=""
  REFRESH_TOKEN=$(echo "$LOGIN_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['refreshToken'])" 2>/dev/null) || REFRESH_TOKEN=""
  USER_ID=$(echo "$LOGIN_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['user']['id'])" 2>/dev/null) || USER_ID=""
  if [ -n "$TOKEN" ]; then
    report_pass "Login with valid credentials"
  else
    report_fail "Login — no token in response"
  fi
fi

TESTS+=("Access protected resource")
if [ -n "$TOKEN" ]; then
  PROTECTED_RES=$(curl -so /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$API_GATEWAY/api/employee/employees?page=1&page_size=1") || PROTECTED_RES="000"
  if [ "$PROTECTED_RES" = "200" ] || [ "$PROTECTED_RES" = "403" ]; then
    report_pass "Access protected resource (code: $PROTECTED_RES)"
  else
    report_fail "Access protected resource (code: $PROTECTED_RES)"
  fi
else
  report_fail "Access protected resource — no token"
fi

TESTS+=("Token refresh")
if [ -n "$REFRESH_TOKEN" ]; then
  REFRESH_RES=$(curl -sf -X POST "$AUTH_URL/refresh" \
    -H 'Content-Type: application/json' \
    -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}") || REFRESH_RES=""
  NEW_TOKEN=$(echo "$REFRESH_RES" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null) || NEW_TOKEN=""
  if [ -n "$NEW_TOKEN" ]; then
    report_pass "Token refresh"
    TOKEN="$NEW_TOKEN"
  else
    report_fail "Token refresh"
  fi
else
  report_fail "Token refresh — no refresh token"
fi

# ────────────────────────────────────────────────────────────────────────────
#  3. Employee CRUD Flow
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 3: Employee CRUD Test"

AUTH_HEADER="Authorization: Bearer $TOKEN"
TENANT_HEADER="X-Tenant-Id: default"

TESTS+=("Create employee")
EMP_EMAIL="emp-$(date +%s)@atlas.io"
EMP_RES=$(curl -sf -X POST "$API_GATEWAY/api/employee/employees" \
  -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "$TENANT_HEADER" \
  -d "{\"name\":\"Jane Smith\",\"department\":\"Engineering\",\"position\":\"Backend Developer\",\"email\":\"$EMP_EMAIL\"}") || EMP_RES=""
EMP_ID=$(echo "$EMP_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('_id','') or d.get('id',''))" 2>/dev/null) || EMP_ID=""
if [ -n "$EMP_ID" ]; then
  report_pass "Create employee (id: $EMP_ID)"
else
  report_fail "Create employee — response: $(echo "$EMP_RES" | head -c 200)"
fi

TESTS+=("Read employee")
if [ -n "$EMP_ID" ]; then
  READ_RES=$(curl -sf -H "$AUTH_HEADER" -H "$TENANT_HEADER" "$API_GATEWAY/api/employee/employees/$EMP_EMAIL") || READ_RES=""
  READ_NAME=$(echo "$READ_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('name',''))" 2>/dev/null) || READ_NAME=""
  if [ "$READ_NAME" = "Jane Smith" ]; then
    report_pass "Read employee"
  else
    report_fail "Read employee — name mismatch: $READ_NAME"
  fi
fi

TESTS+=("Update employee")
if [ -n "$EMP_EMAIL" ]; then
  UPDATE_RES=$(curl -sf -X PUT "$API_GATEWAY/api/employee/employees/$EMP_EMAIL" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d '{"position":"Senior Backend Developer"}') || UPDATE_RES=""
  UPDATE_POS=$(echo "$UPDATE_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('position',''))" 2>/dev/null) || UPDATE_POS=""
  if [ "$UPDATE_POS" = "Senior Backend Developer" ]; then
    report_pass "Update employee"
  else
    report_fail "Update employee"
  fi
fi

TESTS+=("Delete employee")
if [ -n "$EMP_EMAIL" ]; then
  DEL_CODE=$(curl -so /dev/null -w '%{http_code}' -X DELETE \
    -H "$AUTH_HEADER" \
    -H "$TENANT_HEADER" \
    "$API_GATEWAY/api/employee/employees/$EMP_EMAIL") || DEL_CODE="000"
  if [ "$DEL_CODE" = "200" ] || [ "$DEL_CODE" = "204" ]; then
    report_pass "Delete employee"
  else
    report_fail "Delete employee (code: $DEL_CODE)"
  fi
fi

# ────────────────────────────────────────────────────────────────────────────
#  4. ATS Pipeline Test
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 4: ATS Pipeline Test"

TESTS+=("Create ATS job")
ATS_JOB_RES=$(curl -sf -X POST "$API_GATEWAY/api/ats/jobs" \
  -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "$TENANT_HEADER" \
  -d '{"title":"Integration Test Engineer","department":"QA","location":"Remote","employment_type":"FULL_TIME","description":"Integration test role","requirements":"Scripting, CI/CD"}') || ATS_JOB_RES=""
JOB_ID=$(echo "$ATS_JOB_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || JOB_ID=""
if [ -n "$JOB_ID" ]; then
  report_pass "Create ATS job (id: $JOB_ID)"
else
  report_fail "Create ATS job"
fi

TESTS+=("Create candidate")
CAND_RES=$(curl -sf -X POST "$API_GATEWAY/api/ats/candidates" \
  -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "$TENANT_HEADER" \
  -d '{"first_name":"Alice","last_name":"Johnson","email":"alice.j@example.com","source":"LINKEDIN","skills":["Python","Docker"]}') || CAND_RES=""
CAND_ID=$(echo "$CAND_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || CAND_ID=""
if [ -n "$CAND_ID" ]; then
  report_pass "Create candidate (id: $CAND_ID)"
else
  report_fail "Create candidate"
fi

TESTS+=("Submit application")
APP_RES=""
if [ -n "$JOB_ID" ] && [ -n "$CAND_ID" ]; then
  APP_RES=$(curl -sf -X POST "$API_GATEWAY/api/ats/applications" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d "{\"job_id\":\"$JOB_ID\",\"candidate_id\":\"$CAND_ID\",\"notes\":\"Integration test application\"}") || APP_RES=""
  APP_ID=$(echo "$APP_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || APP_ID=""
  if [ -n "$APP_ID" ]; then
    report_pass "Submit application (id: $APP_ID)"
  else
    report_fail "Submit application"
    APP_ID=""
  fi
else
  report_fail "Submit application — missing job_id or candidate_id"
  APP_ID=""
fi

TESTS+=("Schedule interview")
INTERVIEW_ID=""
if [ -n "$APP_ID" ]; then
  FUTURE_DATE=$(python3 -c "from datetime import datetime, timedelta; print((datetime.utcnow() + timedelta(days=7)).isoformat() + 'Z')")
  INT_RES=$(curl -sf -X POST "$API_GATEWAY/api/ats/interviews" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d "{\"application_id\":\"$APP_ID\",\"interview_type\":\"VIDEO\",\"scheduled_at\":\"$FUTURE_DATE\",\"duration_minutes\":60}") || INT_RES=""
  INTERVIEW_ID=$(echo "$INT_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || INTERVIEW_ID=""
  if [ -n "$INTERVIEW_ID" ]; then
    report_pass "Schedule interview (id: $INTERVIEW_ID)"
  else
    report_fail "Schedule interview"
  fi
else
  report_fail "Schedule interview — no application id"
fi

TESTS+=("Create offer")
OFFER_ID=""
if [ -n "$APP_ID" ]; then
  OFFER_RES=$(curl -sf -X POST "$API_GATEWAY/api/ats/offers" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d "{\"application_id\":\"$APP_ID\",\"base_salary\":120000,\"signing_bonus\":10000,\"benefits\":\"Health, Dental, 401k\"}") || OFFER_RES=""
  OFFER_ID=$(echo "$OFFER_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || OFFER_ID=""
  if [ -n "$OFFER_ID" ]; then
    report_pass "Create offer (id: $OFFER_ID)"
  else
    report_fail "Create offer"
  fi
else
  report_fail "Create offer — no application id"
fi

TESTS+=("Accept offer")
if [ -n "$OFFER_ID" ]; then
  ACC_RES=$(curl -sf -X POST "$API_GATEWAY/api/ats/offers/$OFFER_ID/accept" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER") || ACC_RES=""
  ACC_STATUS=$(echo "$ACC_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null) || ACC_STATUS=""
  if [ -n "$ACC_STATUS" ]; then
    report_pass "Accept offer (status: $ACC_STATUS)"
  else
    report_fail "Accept offer"
  fi
else
  report_fail "Accept offer — no offer id"
fi

# ────────────────────────────────────────────────────────────────────────────
#  5. LMS Test
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 5: LMS Test"

TESTS+=("Create course")
COURSE_RES=$(curl -sf -X POST "$API_GATEWAY/api/lms/courses" \
  -H "$AUTH_HEADER" \
  -H 'Content-Type: application/json' \
  -H "$TENANT_HEADER" \
  -d '{"title":"Security Awareness Training","description":"Enterprise security fundamentals","category":"Compliance","level":"beginner","duration":"2 hours","instructor":"Security Team"}') || COURSE_RES=""
COURSE_ID=$(echo "$COURSE_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || COURSE_ID=""
if [ -n "$COURSE_ID" ]; then
  report_pass "Create course (id: $COURSE_ID)"
else
  report_fail "Create course"
fi

TESTS+=("Enroll in course")
ENROLL_ID=""
if [ -n "$COURSE_ID" ]; then
  ENROLL_RES=$(curl -sf -X POST "$API_GATEWAY/api/lms/enrollments" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d "{\"courseId\":\"$COURSE_ID\",\"employeeId\":\"admin@atlas.io\"}") || ENROLL_RES=""
  ENROLL_ID=$(echo "$ENROLL_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || ENROLL_ID=""
  if [ -n "$ENROLL_ID" ]; then
    report_pass "Enroll in course (id: $ENROLL_ID)"
  else
    report_fail "Enroll in course"
  fi
else
  report_fail "Enroll in course — no course id"
fi

TESTS+=("Complete course")
if [ -n "$ENROLL_ID" ]; then
  COMPLETE_RES=$(curl -sf -X PUT "$API_GATEWAY/api/lms/enrollments/$ENROLL_ID/complete" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d '{"grade":95}') || COMPLETE_RES=""
  COMPLETE_STATUS=$(echo "$COMPLETE_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null) || COMPLETE_STATUS=""
  if [ -n "$COMPLETE_STATUS" ]; then
    report_pass "Complete course (status: $COMPLETE_STATUS)"
  else
    report_fail "Complete course"
  fi
else
  report_fail "Complete course — no enrollment id"
fi

TESTS+=("Generate certificate")
if [ -n "$COURSE_ID" ] && [ -n "$ENROLL_ID" ]; then
  CERT_RES=$(curl -sf -X POST "$API_GATEWAY/api/lms/certifications" \
    -H "$AUTH_HEADER" \
    -H 'Content-Type: application/json' \
    -H "$TENANT_HEADER" \
    -d "{\"name\":\"Security Awareness Certified\",\"employeeId\":\"admin@atlas.io\",\"courseId\":\"$COURSE_ID\",\"status\":\"active\"}") || CERT_RES=""
  CERT_ID=$(echo "$CERT_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || CERT_ID=""
  if [ -n "$CERT_ID" ]; then
    report_pass "Generate certificate (id: $CERT_ID)"
  else
    report_fail "Generate certificate"
  fi
else
  report_fail "Generate certificate — missing course or enrollment"
fi

# ────────────────────────────────────────────────────────────────────────────
#  6. Audit Log Test
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 6: Audit Log Test"

AUDIT_SERVICE_URL="${AUDIT_SERVICE_URL:-http://localhost:8011}"
AUDIT_KEY="${AUDIT_KEY:-svc-audit-compliance-secret-key-change-in-production}"

TESTS+=("Create audit log entry")
AUDIT_RES=$(curl -sf -X POST "$AUDIT_SERVICE_URL/api/v1/audit/log" \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Key: $AUDIT_KEY" \
  -d '{"event_type":"integration.test","actor_id":"admin@atlas.io","action":"run","resource_type":"test","details":{"test":"integration-suite"}}') || AUDIT_RES=""
AUDIT_ID=$(echo "$AUDIT_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))" 2>/dev/null) || AUDIT_ID=""
if [ -n "$AUDIT_ID" ]; then
  report_pass "Create audit log entry (id: $AUDIT_ID)"
else
  report_fail "Create audit log entry"
fi

TESTS+=("Query audit logs")
AUDIT_LOGS=$(curl -sf "$AUDIT_SERVICE_URL/api/v1/audit/logs?page=1&page_size=5" \
  -H "X-Internal-Key: $AUDIT_KEY") || AUDIT_LOGS=""
AUDIT_COUNT=$(echo "$AUDIT_LOGS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('items',d.get('results',[]))))" 2>/dev/null) || AUDIT_COUNT="0"
if [ "$AUDIT_COUNT" -gt 0 ]; then
  echo "  ${GREEN}PASS${NC}  Found $AUDIT_COUNT audit log entries"
  PASS=$((PASS + 1))
else
  echo "  ${RED}FAIL${NC}  No audit log entries found (expected at least 1)"
  exit 1
fi

# ────────────────────────────────────────────────────────────────────────────
#  7. AI Copilot Chat Test
# ────────────────────────────────────────────────────────────────────────────
log_banner "Phase 7: AI Copilot Chat Test"

COPILOT_URL="${COPILOT_URL:-http://localhost:8015}"

TESTS+=("AI Copilot chat message")
COPI_RES=$(curl -sf -X POST "$COPILOT_URL/api/v1/copilot/chat" \
  -H 'Content-Type: application/json' \
  -d '{"message":"What is the current workforce headcount?","context":{"employee_id":"admin@atlas.io","department":"Engineering"}}') || COPI_RES=""
COPI_REPLY=$(echo "$COPI_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('reply',''))" 2>/dev/null) || COPI_REPLY=""
COPI_SESSION=$(echo "$COPI_RES" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null) || COPI_SESSION=""
if [ -n "$COPI_REPLY" ] && [ -n "$COPI_SESSION" ]; then
  report_pass "AI Copilot chat message"
else
  report_fail "AI Copilot chat message"
fi

# ────────────────────────────────────────────────────────────────────────────
#  Summary
# ────────────────────────────────────────────────────────────────────────────
log_banner "Integration Test Summary"
echo ""
echo "  ${GREEN}Passed: $PASS${NC}"
echo "  ${RED}Failed: $FAIL${NC}"
echo "  Total:  $((PASS + FAIL))"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}All integration tests passed!${NC}"
else
  echo -e "  ${RED}${BOLD}$FAIL integration test(s) failed${NC}"
fi

echo ""
exit "$FAIL"
