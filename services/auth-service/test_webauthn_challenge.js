const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Pure helpers mirroring the SQL logic in index.js so the behaviour is
// covered without needing a live Postgres instance.
function pickLatestChallenge(rows, now = new Date()) {
  const valid = rows.filter(r => new Date(r.expires_at) > now);
  valid.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return valid.length ? valid[0].challenge : null;
}

function filterCredentials(rows) {
  return rows.filter(r => !String(r.credential_id).startsWith('challenge:'));
}

function testDoubleBeginUsesNewest() {
  const now = new Date();
  const rows = [
    { challenge: 'first', created_at: new Date(now.getTime() - 20000).toISOString(), expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString() },
    { challenge: 'second', created_at: new Date(now.getTime() - 5000).toISOString(), expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString() },
  ];
  assert.strictEqual(pickLatestChallenge(rows, now), 'second', 'newest challenge should win when begin is called twice');
  console.log('PASS: double begin uses newest challenge');
}

function testExpiredChallengeFailsCleanly() {
  const now = new Date();
  const rows = [
    { challenge: 'old', created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(), expires_at: new Date(now.getTime() - 60 * 1000).toISOString() },
  ];
  assert.strictEqual(pickLatestChallenge(rows, now), null, 'expired challenge should not be returned');
  console.log('PASS: expired challenge fails cleanly');
}

function testCredentialListingHidesChallenges() {
  const rows = [
    { credential_id: 'challenge:abc123' },
    { credential_id: 'aGVsbG8td29ybGQ=' },
  ];
  const filtered = filterCredentials(rows);
  assert.strictEqual(filtered.length, 1, 'challenge rows should be filtered from credential list');
  assert.strictEqual(filtered[0].credential_id, 'aGVsbG8td29ybGQ=');
  console.log('PASS: credential listing hides challenge rows');
}

function testSourceUsesChallengesTable() {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS webauthn_challenges'), 'missing webauthn_challenges table');
  assert.ok(src.includes("credential_id NOT LIKE 'challenge:%'"), 'credential queries should exclude legacy challenge rows');
  assert.ok(src.includes('ORDER BY created_at DESC LIMIT 1'), 'challenge lookup should select newest row explicitly');
  assert.ok(src.includes('expires_at > NOW()'), 'challenge lookup should enforce expiry');
  assert.ok(!src.includes("VALUES ($1, $2, $3, $4, $5) ON CONFLICT (credential_id) DO NOTHING',\n      [userId, `challenge:"), 'challenges should not be inserted into webauthn_credentials');
  console.log('PASS: source uses dedicated challenges table');
}

testDoubleBeginUsesNewest();
testExpiredChallengeFailsCleanly();
testCredentialListingHidesChallenges();
testSourceUsesChallengesTable();
console.log('All webauthn challenge tests passed.');
