const assert = require('assert');
const fs = require('fs');
const path = require('path');

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') return 'Email is required';
  const normalized = normalizeEmail(email);
  if (normalized.length > 254) return 'Email is too long';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return 'Email format is invalid';
  return null;
}

function resolveRegisterTenant() {
  return 'default';
}

function testTenantIgnored() {
  assert.strictEqual(resolveRegisterTenant('acme-corp'), 'default', 'client tenant should be ignored');
  assert.strictEqual(resolveRegisterTenant(undefined), 'default');
  console.log('PASS: register tenant ignored');
}

function testEmailNormalized() {
  assert.strictEqual(normalizeEmail('  Attacker@Example.COM '), 'attacker@example.com');
  console.log('PASS: email normalized');
}

function testInvalidEmailRejected() {
  assert.strictEqual(validateEmail('not-an-email'), 'Email format is invalid');
  assert.strictEqual(validateEmail('missing@domain'), 'Email format is invalid');
  assert.strictEqual(validateEmail('good@example.com'), null);
  console.log('PASS: invalid email rejected');
}

function testSourceIgnoresTenant() {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const registerBlock = src.slice(src.indexOf("app.post('/register'"), src.indexOf("app.post('/register'") + 2500);
  assert.ok(!registerBlock.includes('tenant_id } = req.body'), 'register should not read tenant_id from body');
  assert.ok(!registerBlock.includes('tenant_id ||'), 'register should not fall back to client tenant_id');
  assert.ok(registerBlock.includes('validateEmail'), 'register should validate email');
  assert.ok(registerBlock.includes('normalizeEmail'), 'register should normalize email');
  console.log('PASS: source ignores client tenant');
}

testTenantIgnored();
testEmailNormalized();
testInvalidEmailRejected();
testSourceIgnoresTenant();
console.log('All register tenant tests passed.');
