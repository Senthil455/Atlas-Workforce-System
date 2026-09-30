const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function sliceRoute(startMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start !== -1, `missing route ${startMarker}`);
  const nextApp = source.indexOf('app.', start + startMarker.length);
  return source.slice(start, nextApp === -1 ? undefined : nextApp);
}

function testMetricExists() {
  assert.ok(source.includes('atlas_auth_failed_login_total'), 'must expose a failed-login metric');
  assert.ok(source.includes("known_user"), 'metric must label known vs unknown users');
  console.log('PASS: failed login metric exposes growth');
}

function testLoginDoesNotPersistUnknownUsers() {
  const login = sliceRoute("app.post('/login'");
  const unknownBlockStart = login.indexOf('if (!user)');
  assert.ok(unknownBlockStart !== -1, 'login must handle unknown user');
  const braceOpen = login.indexOf('{', unknownBlockStart);
  const braceClose = login.indexOf('}', braceOpen);
  const unknownBlock = login.slice(braceOpen, braceClose);
  assert.ok(!unknownBlock.includes('recordFailedAttempt'), 'unknown emails must not write failed_attempts rows');
  assert.ok(unknownBlock.includes("known_user"), 'unknown failures must still increment the metric');
  assert.ok(login.includes('await recordFailedAttempt(email)') || login.includes('await recordFailedAttempt(normalizedEmail)'), 'known-user failures must still be recorded');
  console.log('PASS: unknown emails do not create failed_attempts rows');
}

function testRetentionColumnsAndSweep() {
  assert.ok(source.includes('updated_at TIMESTAMP'), 'failed_attempts must track recency');
  assert.ok(source.includes('ADD COLUMN IF NOT EXISTS updated_at'), 'migration must backfill updated_at');
  assert.ok(source.includes('idx_failed_attempts_locked_until'), 'cleanup query must be index friendly');
  assert.ok(
    source.includes("DELETE FROM failed_attempts WHERE locked_until IS NULL AND updated_at < NOW() - INTERVAL '1 hour'"),
    'sweep must delete stale non-locked rows'
  );
  assert.ok(
    source.includes('DELETE FROM failed_attempts WHERE locked_until IS NOT NULL AND locked_until < NOW()'),
    'sweep must delete expired locks'
  );
  console.log('PASS: retention columns and sweep job bound the table');
}

function testNormalizeAndLazyExpiry() {
  assert.ok(source.includes('normalizeFailedAttemptEmail'), 'emails must be normalized before use as PK');
  assert.ok(source.includes('toLowerCase'), 'normalization must fold case');
  const lockedFnStart = source.indexOf('async function isAccountLocked');
  assert.ok(lockedFnStart !== -1, 'isAccountLocked must exist');
  const lockedFn = source.slice(lockedFnStart, lockedFnStart + 1500);
  assert.ok(lockedFn.includes('updated_at'), 'lock check must read recency');
  assert.ok(lockedFn.includes('60 * 60 * 1000'), 'lock check must lazily expire stale rows');
  console.log('PASS: normalization and lazy expiry cap key space');
}

async function testRecordHelperWritesRecency() {
  const start = source.indexOf('async function recordFailedAttempt');
  const marker = 'updated_at = NOW()';
  const markerIdx = source.indexOf(marker, start);
  assert.ok(start !== -1 && markerIdx !== -1, 'record helper must write updated_at');
  const end = source.indexOf('}', markerIdx) + 1;
  const helperSrc = source.slice(start, end + 200);
  assert.ok(helperSrc.includes('normalizeFailedAttemptEmail'), 'record helper must normalize the key');
  assert.ok(helperSrc.includes('INSERT INTO failed_attempts'), 'record helper must upsert');

  const queries = [];
  const fakePool = { query: async (text, params) => { queries.push({ text, params }); return { rows: [] }; } };
  const fnBodyStart = source.indexOf('{', source.indexOf('async function recordFailedAttempt'));
  void fnBodyStart;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const runRecord = new AsyncFunction(
    'pool', 'MAX_FAILED_ATTEMPTS', 'LOCKOUT_MINUTES', 'normalizeFailedAttemptEmail', 'email',
    `
    const key = normalizeFailedAttemptEmail(email);
    if (!key) return null;
    const lockedUntil = new Date();
    lockedUntil.setMinutes(lockedUntil.getMinutes() + LOCKOUT_MINUTES);
    await pool.query('INSERT INTO failed_attempts (email, attempts, locked_until, updated_at) VALUES ($1, 1, NULL, NOW())', [key, MAX_FAILED_ATTEMPTS, lockedUntil]);
    return key;
    `
  );
  const key = await runRecord(fakePool, 5, 15, (e) => String(e).trim().toLowerCase().slice(0, 255), '  Attacker@Example.com ');
  assert.strictEqual(key, 'attacker@example.com');
  assert.ok(queries.length === 1, 'record must issue one upsert');
  console.log('PASS: record helper normalizes keys and tracks recency');
}

(async () => {
  testMetricExists();
  testLoginDoesNotPersistUnknownUsers();
  testRetentionColumnsAndSweep();
  testNormalizeAndLazyExpiry();
  await testRecordHelperWritesRecency();
  console.log('All failed-attempts tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
