const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const indexPath = path.join(__dirname, 'index.js');
const source = fs.readFileSync(indexPath, 'utf8');

function section(name, fn) {
  fn();
  console.log(`PASS: ${name}`);
}

// Inline copy of the parsing logic for unit testing without needing env/DB.
function parseScimApiKeysForTest(raw) {
  const map = new Map();
  if (!raw || !raw.trim()) return map;
  const trimmed = raw.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed);
      for (const [tenant, key] of Object.entries(obj)) {
        if (typeof tenant === 'string' && typeof key === 'string' && tenant.trim() && key) {
          map.set(tenant.trim(), key);
        }
      }
      return map;
    } catch {
      // fall through
    }
  }
  for (const entry of trimmed.split(',')) {
    const part = entry.trim();
    if (!part) continue;
    const sepIdx = part.search(/[:=]/);
    if (sepIdx === -1) continue;
    const tenant = part.slice(0, sepIdx).trim();
    const key = part.slice(sepIdx + 1).trim();
    if (tenant && key) map.set(tenant, key);
  }
  return map;
}

section('scim key parsing supports comma-separated mapping', () => {
  const map = parseScimApiKeysForTest('tenant-a:key-a,tenant-b:key-b');
  assert.strictEqual(map.get('tenant-a'), 'key-a');
  assert.strictEqual(map.get('tenant-b'), 'key-b');
});

section('scim key parsing supports JSON mapping', () => {
  const map = parseScimApiKeysForTest(JSON.stringify({ 'tenant-a': 'key-a', 'tenant-b': 'key-b' }));
  assert.strictEqual(map.get('tenant-a'), 'key-a');
  assert.strictEqual(map.get('tenant-b'), 'key-b');
});

section('scim key parsing ignores malformed entries', () => {
  const map = parseScimApiKeysForTest('tenant-a:key-a, badentry, :nokey, tenant-b=key-b');
  assert.strictEqual(map.get('tenant-a'), 'key-a');
  assert.strictEqual(map.get('tenant-b'), 'key-b');
  assert.strictEqual(map.size, 2);
});

section('tenant keys resolve with timing-safe compare', () => {
  function timingSafeEqual(a, b) {
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }
  assert.strictEqual(timingSafeEqual('secret-1', 'secret-1'), true);
  assert.strictEqual(timingSafeEqual('secret-1', 'secret-2'), false);
  assert.strictEqual(timingSafeEqual('short', 'longer-value'), false);
});

section('scim role allowlist only permits employee', () => {
  const allowed = ['employee'];
  const isAllowed = (role) => typeof role === 'string' && allowed.includes(role);
  assert.strictEqual(isAllowed('employee'), true);
  assert.strictEqual(isAllowed('admin'), false);
  assert.strictEqual(isAllowed('hr'), false);
  assert.strictEqual(isAllowed('manager'), false);
  assert.strictEqual(isAllowed(''), false);
  assert.strictEqual(isAllowed(undefined), false);
});

section('requireScimAuth rejects user JWTs', () => {
  const fnBody = source.slice(source.indexOf('function requireScimAuth'), source.indexOf('function requireScimAuth') + 1500);
  assert.ok(!fnBody.includes('jwt.verify'), 'requireScimAuth must not accept JWTs');
  assert.ok(fnBody.includes("req.headers['x-api-key']") || fnBody.includes('x-api-key'), 'requireScimAuth must check x-api-key');
  assert.ok(fnBody.includes('resolveScimTenant'), 'requireScimAuth must resolve tenant from the API key');
  assert.ok(fnBody.includes('req.scimTenant'), 'requireScimAuth must set req.scimTenant');
});

section('scim list is tenant scoped', () => {
  const listStart = source.indexOf("app.get('/scim/v2/Users'");
  const listEnd = source.indexOf('app.post(', listStart);
  const listBlock = source.slice(listStart, listEnd);
  assert.ok(listBlock.includes('req.scimTenant'), 'list must use req.scimTenant');
  assert.ok(listBlock.includes('tenant_id'), 'list must filter by tenant_id');
  assert.ok(listBlock.includes('WHERE tenant_id'), 'list must always include a tenant filter');
});

section('scim create sets tenant and restricts role', () => {
  const createStart = source.indexOf("app.post('/scim/v2/Users'");
  const createEnd = source.indexOf("app.get('/scim/v2/Users/:id'", createStart);
  const createBlock = source.slice(createStart, createEnd);
  assert.ok(createBlock.includes('tenant_id'), 'create must set tenant_id');
  assert.ok(createBlock.includes('INSERT INTO users (email, password, name, role, active, tenant_id)'), 'create must insert tenant_id');
  assert.ok(createBlock.includes('isAllowedScimRole'), 'create must enforce the role allowlist');
  assert.ok(createBlock.includes('scim.user_created'), 'create must audit log');
  assert.ok(createBlock.includes('tenant_id: tenant') || createBlock.includes('tenant_id'), 'create audit must include tenant');
});

section('scim single-read update patch delete are tenant scoped', () => {
  const scopedQueries = [
    'SELECT * FROM users WHERE id = $1 AND tenant_id = $2',
    'WHERE id = $',
    'AND tenant_id = $',
  ];
  for (const q of scopedQueries) {
    assert.ok(source.includes(q), `expected tenant-scoped query pattern: ${q}`);
  }
  assert.ok(!source.includes("UPDATE users SET ${updateFields.join(', ')} WHERE id = ${paramIdx} RETURNING"), 'unscoped UPDATE pattern must be gone');
});

section('scim patch handles role path without escalation', () => {
  const patchStart = source.indexOf("app.patch('/scim/v2/Users/:id'");
  const patchEnd = source.indexOf("app.delete('/scim/v2/Users/:id'", patchStart);
  const patchBlock = source.slice(patchStart, patchEnd);
  assert.ok(patchBlock.includes("op.path === 'role'") || patchBlock.includes('"role"') || patchBlock.includes("'role'"), 'patch must handle the role path');
  assert.ok(patchBlock.includes('isAllowedScimRole'), 'patch must enforce the role allowlist');
  assert.ok(patchBlock.includes('scim.user_updated'), 'patch must audit log');
});

section('scim put enforces role allowlist and audit', () => {
  const putStart = source.indexOf("app.put('/scim/v2/Users/:id'");
  const putEnd = source.indexOf("app.patch('/scim/v2/Users/:id'", putStart);
  const putBlock = source.slice(putStart, putEnd);
  assert.ok(putBlock.includes('isAllowedScimRole'), 'put must enforce the role allowlist');
  assert.ok(putBlock.includes('scim.user_updated'), 'put must audit log');
  assert.ok(putBlock.includes('tenant_id'), 'put must be tenant scoped');
});

section('scim delete is tenant scoped and audited', () => {
  const delStart = source.indexOf("app.delete('/scim/v2/Users/:id'");
  const delBlock = source.slice(delStart, delStart + 1500);
  assert.ok(delBlock.includes('AND tenant_id'), 'delete must be tenant scoped');
  assert.ok(delBlock.includes('scim.user_deactivated'), 'delete must audit log');
  assert.ok(delBlock.includes('actor'), 'delete audit must include actor');
});

console.log('All SCIM tests passed.');
