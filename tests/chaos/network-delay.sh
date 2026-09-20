#!/usr/bin/env bash
set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
POSTGRES_CONTAINER="${1:-atlas-postgres}"
DELAY_MS="${2:-200}"
JITTER_MS="${3:-20}"
NETWORK_NAME="${4:-atlas-workforce-system_atlas-network}"
DURATION_SEC="${5:-60}"
API_GATEWAY="${API_GATEWAY:-http://localhost:8080}"
AUTH_EMAIL="${AUTH_EMAIL:-admin@atlas.io}"
AUTH_PASS="${AUTH_PASS:-ChangeMe123!}"
AUTH_URL="${AUTH_URL:-http://localhost:8010}"

# ── Colors ─────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()   { echo -e "${GREEN}[PASS]${NC}  $*"; }
log_fail() { echo -e "${RED}[FAIL]${NC}  $*"; FAILED=1; }
log_warn() { echo -e "${YELLOW}[WARN]${NC}  $*"; }

FAILED=0

# ── Helpers ────────────────────────────────────────────────────────────────

get_token() {
  local res
  res=$(curl -sf -X POST "$AUTH_URL/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$AUTH_EMAIL\",\"password\":\"$AUTH_PASS\"}") || return 1
  echo "$res" | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])" 2>/dev/null || return 1
}

check_endpoint() {
  local url="$1"
  local desc="$2"
  local token="$3"
  local code
  code=$(curl -so /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$url" 2>/dev/null || echo "000")
  echo "$code"
}

check_http_code() {
  local url="$1" expected="$2" desc="$3" token="$4"
  local code
  code=$(check_endpoint "$url" "$desc" "$token")
  local matched=false
  for e in $expected; do
    [ "$code" = "$e" ] && matched=true
  done
  if $matched; then
    log_ok "$desc — returned $code"
  else
    log_fail "$desc — returned $code (expected one of: $expected)"
  fi
}

# ── Main ───────────────────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "   Chaos Test: Network Latency Injection"
echo "   Target: $POSTGRES_CONTAINER"
echo "   Delay: ${DELAY_MS}ms ± ${JITTER_MS}ms"
echo "   Duration: ${DURATION_SEC}s"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# 1. Ensure we have Docker and required tools
log_info "Step 1: Checking prerequisites..."
if ! command -v docker &> /dev/null; then
  log_fail "Docker is required but not found"
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "$POSTGRES_CONTAINER"; then
  log_warn "Container $POSTGRES_CONTAINER not found. Searching..."
  POSTGRES_CONTAINER=$(docker ps --format '{{.Names}}' | grep -i postgres | head -1) || true
  if [ -z "$POSTGRES_CONTAINER" ]; then
    log_fail "No postgres container found"
    exit 1
  fi
  log_info "Found postgres container: $POSTGRES_CONTAINER"
else
  log_ok "Container $POSTGRES_CONTAINER is running"
fi

# 2. Obtain auth token for service health checks
log_info "Step 2: Obtaining auth token..."
TOKEN=$(get_token) || { log_fail "Could not obtain auth token (services may not be up)"; TOKEN=""; }
if [ -n "$TOKEN" ]; then
  log_ok "Auth token obtained"
fi

# 3. Measure baseline latency
echo ""
log_info "Step 3: Measuring baseline latency..."
BASELINE_START=$(date +%s%N)

if [ -n "$TOKEN" ]; then
  BASELINE_CODE=$(check_endpoint "$API_GATEWAY/api/employee/employees?page=1&page_size=1" "employee" "$TOKEN")
  log_info "  Baseline employee endpoint code: $BASELINE_CODE"
else
  BASELINE_CODE=$(curl -so /dev/null -w '%{http_code}' "$API_GATEWAY/health" 2>/dev/null || echo "000")
  log_info "  Baseline gateway health code: $BASELINE_CODE"
fi

BASELINE_END=$(date +%s%N)
BASELINE_MS=$(( (BASELINE_END - BASELINE_START) / 1000000 ))
log_info "  Baseline request took ~${BASELINE_MS}ms"

# 4. Inject network delay using tc (traffic control)
echo ""
log_info "Step 4: Injecting ${DELAY_MS}ms network delay to $POSTGRES_CONTAINER..."

if ! docker exec "$POSTGRES_CONTAINER" sh -c "command -v tc" 2>/dev/null; then
  log_info "Installing iproute2..."
  docker exec "$POSTGRES_CONTAINER" sh -c "
    if command -v apk >/dev/null 2>&1; then
      apk add -q iproute2 2>/dev/null || true
    elif command -v apt-get >/dev/null 2>&1; then
      apt-get update -qq && apt-get install -y -qq iproute2 2>/dev/null || true
    elif command -v yum >/dev/null 2>&1; then
      yum install -y -q iproute 2>/dev/null || true
    elif command -v dnf >/dev/null 2>&1; then
      dnf install -y -q iproute 2>/dev/null || true
    fi
  " || true
fi

INJECT_RESULT=$(docker exec "$POSTGRES_CONTAINER" sh -c "
  tc qdisc add dev eth0 root netem delay ${DELAY_MS}ms ${JITTER_MS}ms 2>&1
") || true

if echo "$INJECT_RESULT" | grep -q "RTNETLINK answers: File exists"; then
  REPLACE_RESULT=$(docker exec "$POSTGRES_CONTAINER" sh -c "tc qdisc replace dev eth0 root netem delay ${DELAY_MS}ms ${JITTER_MS}ms" 2>&1) || true
  if [ -z "$REPLACE_RESULT" ]; then
    log_ok "Delay rule replaced"
  else
    log_fail "Failed to replace delay rule: $REPLACE_RESULT"
  fi
elif [ -z "$INJECT_RESULT" ]; then
  log_ok "Delay injected successfully"
else
  log_fail "Delay injection failed: $INJECT_RESULT"
fi

sleep 2

# 5. Verify services handle gracefully
echo ""
log_info "Step 5: Verifying graceful handling under latency..."

if [ -n "$TOKEN" ]; then
  TEST_START=$(date +%s%N)
  DELAY_CODE=$(check_endpoint "$API_GATEWAY/api/employee/employees?page=1&page_size=1" "employee" "$TOKEN")
  TEST_END=$(date +%s%N)
  TEST_MS=$(( (TEST_END - TEST_START) / 1000000 ))
  log_info "  Request with delay took ~${TEST_MS}ms"
  log_info "  Response code: $DELAY_CODE"

  check_http_code "$API_GATEWAY/api/employee/employees?page=1&page_size=1" "200 401 403" "Employee endpoint under delay" "$TOKEN"
  check_http_code "$API_GATEWAY/api/leave" "200 401 403" "Leave endpoint under delay" "$TOKEN"
else
  TEST_START=$(date +%s%N)
  DELAY_CODE=$(curl -so /dev/null -w '%{http_code}' "$API_GATEWAY/health" 2>/dev/null || echo "000")
  TEST_END=$(date +%s%N)
  TEST_MS=$(( (TEST_END - TEST_START) / 1000000 ))
  log_info "  Request with delay (health) took ~${TEST_MS}ms (no token)"
  log_info "  Response code: $DELAY_CODE"
fi

# Assert latency actually increased - otherwise tc netem was not applied
EXPECTED_MIN=$((BASELINE_MS + DELAY_MS / 2))
if [ "$TEST_MS" -ge "$EXPECTED_MIN" ]; then
  log_ok "Latency increased as expected (baseline ${BASELINE_MS}ms -> ${TEST_MS}ms, expected >= ${EXPECTED_MIN}ms)"
else
  log_fail "Latency did not increase sufficiently (baseline ${BASELINE_MS}ms -> ${TEST_MS}ms, expected >= ${EXPECTED_MIN}ms) - tc netem may not have been applied"
fi

sleep 2

# 6. Remove delay
echo ""
log_info "Step 6: Removing network delay..."
REMOVE_RESULT=$(docker exec "$POSTGRES_CONTAINER" sh -c "tc qdisc del dev eth0 root netem 2>&1") || true
if [ -z "$REMOVE_RESULT" ] || echo "$REMOVE_RESULT" | grep -q "RTNETLINK answers: No such file"; then
  log_ok "Network delay removed"
else
  log_fail "Failed to remove network delay: $REMOVE_RESULT"
fi

sleep 2

# 7. Verify recovery
echo ""
log_info "Step 7: Verifying recovery after delay removal..."
if [ -n "$TOKEN" ]; then
  check_http_code "$API_GATEWAY/api/employee/employees?page=1&page_size=1" "200 401 403" "Recovery check" "$TOKEN"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "   Chaos Test Complete"
echo "═══════════════════════════════════════════════════════════════"
exit $FAILED
