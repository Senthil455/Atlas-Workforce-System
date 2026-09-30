const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function testNoSharedKeyForAudit() {
  const auditPosts = [];
  let idx = 0;
  while (true) {
    const at = source.indexOf('/api/v1/audit/log', idx);
    if (at === -1) break;
    auditPosts.push(source.slice(Math.max(0, at - 200), at + 200));
    idx = at + 1;
  }
  assert.ok(auditPosts.length >= 2, 'gateway must post audit events directly and from the retry worker');
  for (const ctx of auditPosts) {
    assert.ok(!ctx.includes('X-Internal-Key'), 'audit posts must not use X-Internal-Key');
  }
  console.log('PASS: gateway audit posts do not use X-Internal-Key');
}

function testWriterToken() {
  assert.ok(source.includes("AUDIT_WRITER_AUDIENCE = 'audit-writer'"), 'writer audience must be audit-writer');
  assert.ok(source.includes('mintAuditWriterToken'), 'must mint a dedicated audit writer token');
  assert.ok(source.includes('auditWriterHeaders()'), 'audit posts must send the writer token');
  console.log('PASS: gateway audit writes use x-internal-auth with audit-writer audience');
}

function testRetryVisible() {
  assert.ok(source.includes('atlas_audit_delivery_failures_total'), 'must expose audit delivery failure metric');
  assert.ok(source.includes('atlas_audit_retry_queue_depth'), 'retry queue depth must stay visible');
  assert.ok(source.includes('atlas_audit_retry_dlq_depth'), 'retry DLQ depth must stay visible');
  console.log('PASS: audit failures and retry queue stay visible in metrics');
}

testNoSharedKeyForAudit();
testWriterToken();
testRetryVisible();
console.log('All gateway audit auth tests passed.');
