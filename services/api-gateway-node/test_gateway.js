const http = require('http');
const assert = require('assert');
const { app, csrfMiddleware, rbacMiddleware, services, isPublicOrAuthPath } = require('./index');

// Health check test - fails when gateway is unreachable
function testHealthEndpoint() {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:8080/health', (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          assert.strictEqual(res.statusCode, 200);
          const body = JSON.parse(data);
          assert.ok(body.status.includes('API Gateway'));
          console.log('PASS: /health returns 200');
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', (err) => {
      reject(new Error('Gateway not reachable: ' + err.message));
    });
  });
}

// CSRF middleware tests
function testCsrfMiddleware() {
  // Test 1: GET request should pass through without CSRF check
  let called = false;
  const req1 = { method: 'GET', path: '/api/employee', cookies: {}, headers: {} };
  const res1 = { statusCode: 200, setHeader: () => {}, cookie: () => {} };
  csrfMiddleware(req1, res1, () => { called = true; });
  assert.strictEqual(called, true, 'GET should pass CSRF check');
  console.log('PASS: csrfMiddleware allows GET requests');

  // Test 2: Public auth paths should bypass CSRF
  called = false;
  const req2 = { method: 'POST', path: '/api/auth/login', cookies: {}, headers: {} };
  csrfMiddleware(req2, res1, () => { called = true; });
  assert.strictEqual(called, true, 'Public auth paths should bypass CSRF');
  console.log('PASS: csrfMiddleware allows public auth paths');

  // Test 3: POST without CSRF cookie should pass (API clients)
  called = false;
  const req3 = { method: 'POST', path: '/api/employee', cookies: {}, headers: {} };
  csrfMiddleware(req3, res1, () => { called = true; });
  assert.strictEqual(called, true, 'POST without CSRF cookie should pass');
  console.log('PASS: csrfMiddleware allows POST without CSRF cookie');

  // Test 4: POST with CSRF cookie but no header token should be blocked
  called = false;
  let blocked = false;
  const req4 = { method: 'POST', path: '/api/employee', cookies: { csrf_token: 'abc123' }, headers: {} };
  const res4 = {
    statusCode: 200,
    setHeader: () => {},
    cookie: () => {},
    status(code) { this.statusCode = code; return this; },
    json(data) { blocked = true; return this; }
  };
  csrfMiddleware(req4, res4, () => { called = true; });
  assert.strictEqual(called, false, 'POST with cookie but no header should be blocked');
  assert.strictEqual(blocked, true, 'Should return 403 JSON response');
  console.log('PASS: csrfMiddleware blocks POST with cookie but no header token');

  // Test 5: POST with matching CSRF cookie and header should pass
  called = false;
  const req5 = { method: 'POST', path: '/api/employee', cookies: { csrf_token: 'abc123' }, headers: { 'x-csrf-token': 'abc123' } };
  csrfMiddleware(req5, res1, () => { called = true; });
  assert.strictEqual(called, true, 'POST with matching cookie and header should pass');
  console.log('PASS: csrfMiddleware allows POST with matching CSRF tokens');

  // Test 6: POST with mismatched CSRF cookie and header should be blocked
  called = false;
  blocked = false;
  const req6 = { method: 'POST', path: '/api/employee', cookies: { csrf_token: 'abc123' }, headers: { 'x-csrf-token': 'xyz789' } };
  csrfMiddleware(req6, res4, () => { called = true; });
  assert.strictEqual(called, false, 'POST with mismatched tokens should be blocked');
  assert.strictEqual(blocked, true, 'Should return 403 JSON response');
  console.log('PASS: csrfMiddleware blocks POST with mismatched CSRF tokens');
}

// RBAC middleware tests
function testRbacMiddleware() {
  // Test 1: Admin should access payroll
  let called = false;
  const req1 = { path: '/api/payroll', method: 'GET', user: { role: 'admin' } };
  const res1 = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json() { return this; } };
  rbacMiddleware(req1, res1, () => { called = true; });
  assert.strictEqual(called, true, 'Admin should access payroll');
  console.log('PASS: rbacMiddleware allows admin to access payroll');

  // Test 2: Employee should NOT access payroll
  called = false;
  let blocked = false;
  const req2 = { path: '/api/payroll', method: 'GET', user: { role: 'employee' } };
  const res2 = { statusCode: 200, status(code) { this.statusCode = code; blocked = true; return this; }, json() { return this; } };
  rbacMiddleware(req2, res2, () => { called = true; });
  assert.strictEqual(called, false, 'Employee should not access payroll');
  assert.strictEqual(blocked, true, 'Should return 403');
  console.log('PASS: rbacMiddleware blocks employee from payroll');

  // Test 3: Manager should access analytics
  called = false;
  const req3 = { path: '/api/analytics', method: 'GET', user: { role: 'manager' } };
  rbacMiddleware(req3, res1, () => { called = true; });
  assert.strictEqual(called, true, 'Manager should access analytics');
  console.log('PASS: rbacMiddleware allows manager to access analytics');

  // Test 4: Employee should NOT access analytics
  called = false;
  blocked = false;
  const req4 = { path: '/api/analytics', method: 'GET', user: { role: 'employee' } };
  rbacMiddleware(req4, res2, () => { called = true; });
  assert.strictEqual(called, false, 'Employee should not access analytics');
  assert.strictEqual(blocked, true, 'Should return 403');
  console.log('PASS: rbacMiddleware blocks employee from analytics');

  // Test 5: Public paths should bypass RBAC
  called = false;
  const req5 = { path: '/api/auth/login', method: 'POST', user: { role: 'employee' } };
  rbacMiddleware(req5, res1, () => { called = true; });
  assert.strictEqual(called, true, 'Public paths should bypass RBAC');
  console.log('PASS: rbacMiddleware allows public auth paths');

  // Test 6: HR should access employee modification
  called = false;
  const req6 = { path: '/api/employee', method: 'POST', user: { role: 'hr' } };
  rbacMiddleware(req6, res1, () => { called = true; });
  assert.strictEqual(called, true, 'HR should modify employees');
  console.log('PASS: rbacMiddleware allows HR to modify employees');

  // Test 7: Employee should NOT modify employees
  called = false;
  blocked = false;
  const req7 = { path: '/api/employee', method: 'POST', user: { role: 'employee' } };
  rbacMiddleware(req7, res2, () => { called = true; });
  assert.strictEqual(called, false, 'Employee should not modify employees');
  assert.strictEqual(blocked, true, 'Should return 403');
  console.log('PASS: rbacMiddleware blocks employee from modifying employees');
}

// Proxy rewrite table tests
function testProxyRewriteTable() {
  // Test that all expected services are in the rewrite table
  const expectedServices = [
    'auth', 'employee', 'payroll', 'analytics', 'notification',
    'attendance', 'leave', 'ats', 'lms', 'performance',
    'copilot', 'audit', 'compliance', 'integration', 'lifecycle',
    'security', 'ai', 'live', 'workforce'
  ];

  for (const svc of expectedServices) {
    assert.ok(services[svc], `Service "${svc}" should be in the rewrite table`);
    assert.ok(services[svc].startsWith('http'), `Service "${svc}" should have a valid URL`);
  }
  console.log('PASS: proxy rewrite table contains all expected services');

  // Test specific rewrite rules
  assert.strictEqual(services.auth, 'http://auth-service:8010');
  assert.strictEqual(services.employee, 'http://employee-service:8001');
  assert.strictEqual(services.payroll, 'http://payroll-service:8002');
  assert.strictEqual(services.analytics, 'http://analytics-service:8003');
  assert.strictEqual(services.notification, 'http://notification-service:8004');
  assert.strictEqual(services.attendance, 'http://attendance-service:8005');
  assert.strictEqual(services.leave, 'http://leave-service:8006');
  assert.strictEqual(services.audit, 'http://audit-compliance-service:8011');
  assert.strictEqual(services.workforce, 'http://workforce-planning-service:8017');
  console.log('PASS: proxy rewrite table has correct URLs');
}

// Public path detection tests
function testPublicPathDetection() {
  assert.strictEqual(isPublicOrAuthPath('/health'), true, '/health should be public');
  assert.strictEqual(isPublicOrAuthPath('/api/auth/login'), true, '/api/auth/login should be public');
  assert.strictEqual(isPublicOrAuthPath('/api/auth/register'), true, '/api/auth/register should be public');
  assert.strictEqual(isPublicOrAuthPath('/api/employee'), false, '/api/employee should not be public');
  assert.strictEqual(isPublicOrAuthPath('/api/payroll'), false, '/api/payroll should not be public');
  console.log('PASS: public path detection works correctly');
}

async function run() {
  // Run unit tests that don't need a live server
  testCsrfMiddleware();
  testRbacMiddleware();
  testProxyRewriteTable();
  testPublicPathDetection();

  // Run integration test that needs a live server
  await testHealthEndpoint();

  console.log('All gateway tests passed.');
}

run().catch((e) => {
  console.error('Test failed:', e.message);
  process.exit(1);
});
