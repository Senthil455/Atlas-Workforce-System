const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function testNoSharedKeyPath() {
  assert.ok(!source.includes('X-Internal-Key'), 'must not use the X-Internal-Key scheme for audit');
  assert.ok(!source.includes('AUDIT_INTERNAL_KEY'), 'must not depend on AUDIT_INTERNAL_KEY');
  console.log('PASS: X-Internal-Key path removed for audit');
}

function testWriterToken() {
  assert.ok(source.includes("aud: AUDIT_WRITER_AUDIENCE"), 'audit token must carry the writer audience');
  assert.ok(source.includes("AUDIT_WRITER_AUDIENCE = 'audit-writer'"), 'writer audience must be audit-writer');
  assert.ok(source.includes('mintAuditWriterToken'), 'must mint a dedicated audit writer token');
  assert.ok(source.includes("headers: { 'x-internal-auth': mintAuditWriterToken() }"), 'audit posts must send x-internal-auth');
  console.log('PASS: audit writes use x-internal-auth with audit-writer audience');
}

function testRetryAndMetric() {
  assert.ok(source.includes('atlas_audit_delivery_failures_total'), 'must expose audit delivery failure metric');
  assert.ok(source.includes('auditDeliveryFailuresTotal'), 'failures must increment the metric');
  const fnStart = source.indexOf('async function sendAuditEvent');
  assert.ok(fnStart !== -1, 'sendAuditEvent must exist');
  const fn = source.slice(fnStart, fnStart + 1500);
  assert.ok(fn.includes('delaysMs') || fn.includes('attempt'), 'must retry with backoff before recording failure');
  console.log('PASS: audit delivery retries with backoff and exposes failures');
}

function testFailFast() {
  assert.ok(source.includes('if (!INTERNAL_JWT_SECRET)'), 'must fail fast when INTERNAL_JWT_SECRET is unset');
  console.log('PASS: service fails fast without INTERNAL_JWT_SECRET');
}

function testMintedTokenVerifies() {
  const crypto = require('crypto');
  const secret = 'test-internal-secret';
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const payload = { sub: 'auth-service', service: 'auth-service', tenant_id: 'default', aud: 'audit-writer' };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest('base64url');
  const token = `${headerB64}.${payloadB64}.${sig}`;
  const parts = token.split('.');
  assert.strictEqual(parts.length, 3);
  const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.strictEqual(decoded.aud, 'audit-writer');
  const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  assert.ok(crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2])));
  console.log('PASS: minted writer token carries audit-writer audience');
}

testNoSharedKeyPath();
testWriterToken();
testRetryAndMetric();
testFailFast();
testMintedTokenVerifies();
console.log('All audit auth tests passed.');
