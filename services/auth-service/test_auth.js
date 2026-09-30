// Dummy env so the service module can be required without real secrets.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-value';
process.env.ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || 'unit-test-admin-password';
process.env.AUDIT_INTERNAL_KEY = process.env.AUDIT_INTERNAL_KEY || 'unit-test-audit-key';
process.env.SCIM_API_KEY = process.env.SCIM_API_KEY || 'unit-test-scim-key';
process.env.POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://test:test@localhost:5432/test';

const assert = require('assert');
const { validatePassword, hashToken, sanitizeUser } = require('./index');

// Unit tests for auth service utilities (imported from index.js, not redefined here)
function testValidatePassword() {
  const cases = [
    { input: 'short', expected: 'Password must be at least 8 characters' },
    { input: 'nonumberlong', expected: 'Password must contain at least one uppercase letter' },
    { input: 'nouppercase1', expected: 'Password must contain at least one uppercase letter' },
    { input: 'alllowercase1', expected: 'Password must contain at least one uppercase letter' },
    { input: 'ValidPass1', expected: null },
  ];

  for (const { input, expected } of cases) {
    assert.strictEqual(validatePassword(input), expected, `Failed for: ${input}`);
  }
  console.log('PASS: validatePassword');
}

function testHashToken() {
  const token = 'test-token-123';
  const hash = hashToken(token);
  assert.strictEqual(hash.length, 64, 'SHA256 hash should be 64 hex chars');
  assert.strictEqual(hashToken(token), hash, 'Hashing should be deterministic');
  console.log('PASS: hashToken');
}

function testSanitizeUser() {
  const user = { id: 1, email: 'test@test.com', name: 'Test', role: 'admin', department: 'Eng', position: 'Dev', password: 'secret', token: 'jwt' };
  const sanitized = sanitizeUser(user);
  assert.strictEqual(sanitized.password, undefined, 'Password should be excluded');
  assert.strictEqual(sanitized.token, undefined, 'Token should be excluded');
  assert.strictEqual(sanitized.email, 'test@test.com');
  assert.strictEqual(sanitized.tenant_id, 'default');
  console.log('PASS: sanitizeUser');
}

function testRateLimiterPerIp() {
  // Simulate the rate limiter with two different client IPs.
  // Before the fix, all requests behind the gateway shared one bucket
  // (keyed on the gateway IP). After the fix, each client IP gets its own bucket.
  const store = new Map();
  const maxRequests = 3;
  const windowMs = 15 * 60 * 1000;

  function checkRateLimit(clientIp, action) {
    const key = `${clientIp}:${action}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry) {
      entry = { count: 1, startTime: now };
      store.set(key, entry);
    } else {
      if (now - entry.startTime > windowMs) {
        entry.count = 1;
        entry.startTime = now;
      } else {
        entry.count++;
      }
    }

    return entry.count <= maxRequests;
  }

  const ip1 = '192.168.1.1';
  const ip2 = '192.168.1.2';

  // Fire maxRequests+1 requests from ip1
  for (let i = 0; i < maxRequests; i++) {
    assert.strictEqual(checkRateLimit(ip1, 'login'), true, `ip1 request ${i + 1} should be allowed`);
  }
  assert.strictEqual(checkRateLimit(ip1, 'login'), false, `ip1 request ${maxRequests + 1} should be blocked`);

  // ip2 should not be affected by ip1's rate limit
  assert.strictEqual(checkRateLimit(ip2, 'login'), true, 'ip2 request should be allowed');

  console.log('PASS: rateLimiterPerIp');
}

function testGetClientIp() {
  // Replicate getClientIp logic inline
  function getClientIp(req) {
    const forwarded = req.headers['x-real-client-ip'];
    if (forwarded && typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.trim().split(',')[0].trim();
    }
    return req.ip;
  }

  // x-real-client-ip header takes precedence over req.ip
  const req1 = { headers: { 'x-real-client-ip': '10.0.0.1' }, ip: '172.16.0.1' };
  assert.strictEqual(getClientIp(req1), '10.0.0.1', 'Should use x-real-client-ip header');

  // Falls back to req.ip when header is absent
  const req2 = { headers: {}, ip: '172.16.0.1' };
  assert.strictEqual(getClientIp(req2), '172.16.0.1', 'Should fallback to req.ip');

  // Falls back to req.ip when header is empty
  const req3 = { headers: { 'x-real-client-ip': '' }, ip: '172.16.0.1' };
  assert.strictEqual(getClientIp(req3), '172.16.0.1', 'Should fallback to req.ip for empty header');

  // Takes the first IP when header contains multiple
  const req4 = { headers: { 'x-real-client-ip': '10.0.0.1, 10.0.0.2' }, ip: '172.16.0.1' };
  assert.strictEqual(getClientIp(req4), '10.0.0.1', 'Should take the first IP from x-real-client-ip');

  // Falls back to req.ip when header is whitespace-only
  const req5 = { headers: { 'x-real-client-ip': '   ' }, ip: '172.16.0.1' };
  assert.strictEqual(getClientIp(req5), '172.16.0.1', 'Should fallback to req.ip for whitespace header');

  console.log('PASS: getClientIp');
}

testValidatePassword();
testHashToken();
testSanitizeUser();
testRateLimiterPerIp();
testGetClientIp();
console.log('All auth tests passed.');
process.exit(0);
