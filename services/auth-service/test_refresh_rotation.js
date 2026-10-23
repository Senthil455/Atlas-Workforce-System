// Dummy env so the service module can be required without real secrets.
// Keep this block in sync with the fatal startup checks in index.js.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-value';
process.env.ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD || 'unit-test-admin-password';
process.env.AUDIT_INTERNAL_KEY = process.env.AUDIT_INTERNAL_KEY || 'unit-test-audit-key';
process.env.SCIM_API_KEY = process.env.SCIM_API_KEY || 'unit-test-scim-key';
process.env.POSTGRES_URL = process.env.POSTGRES_URL || 'postgresql://test:test@localhost:5432/test';
process.env.ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || 'http://localhost:3000';
process.env.AUDIT_SERVICE_URL = process.env.AUDIT_SERVICE_URL || 'http://localhost:8011';
process.env.INTERNAL_JWT_SECRET = process.env.INTERNAL_JWT_SECRET || 'unit-test-internal-secret-value';
process.env.MFA_STEPUP_SECRET = process.env.MFA_STEPUP_SECRET || 'unit-test-mfa-stepup-secret-value';
process.env.OAUTH_ENCRYPTION_KEY = process.env.OAUTH_ENCRYPTION_KEY || 'unit-test-oauth-encryption-key-value';
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

const assert = require('assert');
const { hashToken, rotateRefreshToken, revokeRefreshTokenForLogout } = require('./index');

const DAY_MS = 24 * 60 * 60 * 1000;

// In-memory stand-in for the pg Pool that reproduces the two Postgres
// behaviours the rotation relies on under READ COMMITTED:
//  - writes are private to their transaction until COMMIT;
//  - UPDATE / DELETE / SELECT ... FOR UPDATE lock each row they touch until
//    the transaction ends, and a statement that waited on a lock re-checks the
//    row against the now-committed version before acting on it.
// Every statement yields to the event loop first so concurrent callers
// interleave, and unknown SQL throws so the test tracks the real queries.
function createFakeDb() {
  const tables = { refresh_tokens: new Map(), rotated_tokens: new Map(), sessions: new Map(), users: new Map() };
  const locks = new Map();
  let nextRotatedId = 1;
  let openClients = 0;

  const rowKey = (table, key) => `${table}:${key}`;

  class Tx {
    constructor() {
      this.pending = new Map();
      this.held = new Set();
    }

    read(table, key) {
      const k = rowKey(table, key);
      if (this.pending.has(k)) return this.pending.get(k);
      return tables[table].get(key) || null;
    }

    rows(table) {
      const keys = new Set(tables[table].keys());
      for (const k of this.pending.keys()) {
        if (k.startsWith(`${table}:`)) keys.add(k.slice(table.length + 1));
      }
      return [...keys].map((key) => [key, this.read(table, key)]).filter(([, row]) => row);
    }

    async lock(table, key) {
      const k = rowKey(table, key);
      for (;;) {
        const held = locks.get(k);
        if (!held || held.owner === this) break;
        await held.released;
      }
      if (!locks.has(k)) {
        let release;
        const released = new Promise((resolve) => { release = resolve; });
        locks.set(k, { owner: this, released, release });
        this.held.add(k);
      }
    }

    write(table, key, row) {
      this.pending.set(rowKey(table, key), row);
    }

    end(commit) {
      if (commit) {
        for (const [k, row] of this.pending) {
          const sep = k.indexOf(':');
          const table = k.slice(0, sep);
          const key = k.slice(sep + 1);
          if (row) tables[table].set(key, row);
          else tables[table].delete(key);
        }
      }
      this.pending.clear();
      for (const k of this.held) {
        const held = locks.get(k);
        locks.delete(k);
        held.release();
      }
      this.held.clear();
    }
  }

  async function lockMatching(tx, table, pred) {
    const matched = [];
    for (const [key, row] of tx.rows(table)) {
      if (!pred(row)) continue;
      await tx.lock(table, key);
      const latest = tx.read(table, key);
      if (latest && pred(latest)) matched.push([key, latest]);
    }
    return matched;
  }

  async function del(tx, table, pred, returning) {
    const matched = await lockMatching(tx, table, pred);
    for (const [key] of matched) tx.write(table, key, null);
    return { rows: returning ? matched.map(([, row]) => returning(row)) : [], rowCount: matched.length };
  }

  async function update(tx, table, pred, patch) {
    const matched = await lockMatching(tx, table, pred);
    for (const [key, row] of matched) tx.write(table, key, { ...row, ...patch });
    return { rows: [], rowCount: matched.length };
  }

  const now = () => Date.now();
  const statements = {
    'DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id': (tx, [hash]) =>
      del(tx, 'refresh_tokens', (r) => r.token_hash === hash && r.expires_at > now(), (r) => ({ user_id: r.user_id })),
    'DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING user_id': (tx, [hash]) =>
      del(tx, 'refresh_tokens', (r) => r.token_hash === hash, (r) => ({ user_id: r.user_id })),
    'DELETE FROM refresh_tokens WHERE user_id = $1': (tx, [userId]) =>
      del(tx, 'refresh_tokens', (r) => r.user_id === userId),
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)': async (tx, [userId, hash, expiresAt]) => {
      await tx.lock('refresh_tokens', hash);
      tx.write('refresh_tokens', hash, { user_id: userId, token_hash: hash, expires_at: expiresAt.getTime() });
      return { rows: [], rowCount: 1 };
    },
    'INSERT INTO rotated_tokens (token_hash, user_id) VALUES ($1, $2)': async (tx, [hash, userId]) => {
      const key = String(nextRotatedId++);
      await tx.lock('rotated_tokens', key);
      tx.write('rotated_tokens', key, { token_hash: hash, user_id: userId, created_at: now() });
      return { rows: [], rowCount: 1 };
    },
    'DELETE FROM rotated_tokens WHERE token_hash = $1 RETURNING user_id': (tx, [hash]) =>
      del(tx, 'rotated_tokens', (r) => r.token_hash === hash, (r) => ({ user_id: r.user_id })),
    "DELETE FROM rotated_tokens WHERE created_at < NOW() - INTERVAL '1 hour'": (tx) =>
      del(tx, 'rotated_tokens', (r) => r.created_at < now() - 60 * 60 * 1000),
    'SELECT id, is_active FROM sessions WHERE token_hash = $1 AND user_id = $2 FOR UPDATE': async (tx, [hash, userId]) => {
      const matched = await lockMatching(tx, 'sessions', (r) => r.token_hash === hash && r.user_id === userId);
      return { rows: matched.map(([, r]) => ({ id: r.id, is_active: r.is_active })) };
    },
    'UPDATE sessions SET token_hash = $1 WHERE id = $2': (tx, [hash, id]) =>
      update(tx, 'sessions', (r) => r.id === id, { token_hash: hash }),
    'UPDATE sessions SET is_active = false WHERE user_id = $1': (tx, [userId]) =>
      update(tx, 'sessions', (r) => r.user_id === userId, { is_active: false }),
    'UPDATE sessions SET is_active = false WHERE token_hash = $1 AND user_id = $2': (tx, [hash, userId]) =>
      update(tx, 'sessions', (r) => r.token_hash === hash && r.user_id === userId, { is_active: false }),
    'SELECT id, email, name, role, department, position, tenant_id FROM users WHERE id = $1': async (tx, [userId]) => ({
      rows: tx.rows('users').map(([, r]) => r).filter((r) => r.id === userId),
    }),
  };

  async function exec(tx, sql, params) {
    const handler = statements[sql];
    if (!handler) throw new Error(`fake db: unexpected SQL: ${sql}`);
    return handler(tx, params);
  }

  async function autocommit(sql, params) {
    const tx = new Tx();
    try {
      const result = await exec(tx, sql, params);
      tx.end(true);
      return result;
    } catch (err) {
      tx.end(false);
      throw err;
    }
  }

  const normalize = (text) => text.replace(/\s+/g, ' ').trim();
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  const db = {
    tables,
    locks,
    barrier: null,
    get openClients() { return openClients; },
    async query(text, params = []) {
      await tick();
      return autocommit(normalize(text), params);
    },
    async connect() {
      openClients++;
      let tx = null;
      return {
        async query(text, params = []) {
          const sql = normalize(text);
          await tick();
          if (sql === 'BEGIN') {
            tx = new Tx();
            if (db.barrier) await db.barrier.arrive();
            return { rows: [] };
          }
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            if (tx) tx.end(sql === 'COMMIT');
            tx = null;
            return { rows: [] };
          }
          return tx ? exec(tx, sql, params) : autocommit(sql, params);
        },
        release() {
          assert.strictEqual(tx, null, 'client released with an open transaction');
          openClients--;
        },
      };
    },
  };
  return db;
}

// Holds every caller at BEGIN until `parties` of them have arrived, so the
// transactions under test genuinely overlap. Callers resume in arrival order.
function createBarrier(parties) {
  let arrived = 0;
  let open;
  const opened = new Promise((resolve) => { open = resolve; });
  return {
    async arrive() {
      arrived++;
      if (arrived >= parties) open();
      await opened;
    },
  };
}

const LAPTOP_TOKEN = 'laptop-refresh-token';
const PHONE_TOKEN = 'phone-refresh-token';
const OTHER_USER_TOKEN = 'other-user-refresh-token';

// User 7 has two signed-in devices; user 8 is a bystander whose session must
// survive anything that happens to user 7.
function seed(db) {
  const { users, sessions, refresh_tokens: refreshTokens } = db.tables;
  users.set('7', { id: 7, email: 'ana@example.com', name: 'Ana', role: 'employee', department: 'Eng', position: 'Dev', tenant_id: 't1' });
  users.set('8', { id: 8, email: 'ben@example.com', name: 'Ben', role: 'employee', department: 'Ops', position: 'SRE', tenant_id: 't1' });
  for (const [sessionId, userId, token] of [['sess-laptop', 7, LAPTOP_TOKEN], ['sess-phone', 7, PHONE_TOKEN], ['sess-other', 8, OTHER_USER_TOKEN]]) {
    const tokenHash = hashToken(token);
    sessions.set(sessionId, { id: sessionId, user_id: userId, token_hash: tokenHash, is_active: true });
    refreshTokens.set(tokenHash, { user_id: userId, token_hash: tokenHash, expires_at: Date.now() + DAY_MS });
  }
}

function freshDb() {
  const db = createFakeDb();
  seed(db);
  return db;
}

const sessionsOf = (db, userId) => [...db.tables.sessions.values()].filter((s) => s.user_id === userId);
const tokensOf = (db, userId) => [...db.tables.refresh_tokens.values()].filter((t) => t.user_id === userId);
const rotatedHashes = (db) => [...db.tables.rotated_tokens.values()].map((r) => r.token_hash);

function assertQuiescent(db) {
  assert.strictEqual(db.openClients, 0, 'every pooled client must be released');
  assert.strictEqual(db.locks.size, 0, 'no row lock may outlive its transaction');
}

function assertFamilyRevoked(db, userId) {
  assert.ok(sessionsOf(db, userId).every((s) => s.is_active === false), 'every session of the user must be revoked');
  assert.strictEqual(tokensOf(db, userId).length, 0, 'no refresh token of the user may remain');
}

function assertBystanderUntouched(db) {
  const [other] = sessionsOf(db, 8);
  assert.strictEqual(other.is_active, true, 'another user must keep their session');
  assert.strictEqual(tokensOf(db, 8).length, 1, 'another user must keep their refresh token');
}

async function testConcurrentRefreshCannotBothSucceed() {
  const db = freshDb();
  db.barrier = createBarrier(2);
  const results = await Promise.all([
    rotateRefreshToken(db, LAPTOP_TOKEN),
    rotateRefreshToken(db, LAPTOP_TOKEN),
  ]);
  db.barrier = null;

  assert.deepStrictEqual(results.map((r) => r.status).sort(), ['ok', 'reused'], 'exactly one refresh may succeed');
  const reused = results.find((r) => r.status === 'reused');
  assert.strictEqual(reused.userId, 7);
  // The winner's freshly minted token belongs to the same family and must go too.
  assertFamilyRevoked(db, 7);
  assertBystanderUntouched(db);
  assertQuiescent(db);
  console.log('PASS: concurrent refreshes with one token yield one success and one reuse that revokes the family');
}

async function testSequentialReplayIsReuse() {
  const db = freshDb();
  const first = await rotateRefreshToken(db, LAPTOP_TOKEN);
  assert.strictEqual(first.status, 'ok');
  const replay = await rotateRefreshToken(db, LAPTOP_TOKEN);
  assert.deepStrictEqual(replay, { status: 'reused', userId: 7 });
  assertFamilyRevoked(db, 7);
  assertBystanderUntouched(db);

  // The rotated record is consumed by the first detection.
  assert.ok(!rotatedHashes(db).includes(hashToken(LAPTOP_TOKEN)));
  assert.deepStrictEqual(await rotateRefreshToken(db, LAPTOP_TOKEN), { status: 'invalid' });
  assertQuiescent(db);
  console.log('PASS: replaying a rotated refresh token is detected as reuse');
}

async function testRotationReplacesTokenOnSession() {
  const db = freshDb();
  const result = await rotateRefreshToken(db, LAPTOP_TOKEN);
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.sessionId, 'sess-laptop');
  assert.strictEqual(result.user.email, 'ana@example.com');
  assert.strictEqual(result.user.tenant_id, 't1');

  const newHash = hashToken(result.newRefreshToken);
  assert.notStrictEqual(result.newRefreshToken, LAPTOP_TOKEN);
  assert.ok(!db.tables.refresh_tokens.has(hashToken(LAPTOP_TOKEN)), 'old token must be gone');
  assert.strictEqual(db.tables.refresh_tokens.get(newHash).user_id, 7, 'new token must be stored for the user');
  assert.strictEqual(db.tables.sessions.get('sess-laptop').token_hash, newHash, 'session must point at the new token');
  assert.strictEqual(db.tables.sessions.get('sess-laptop').is_active, true);
  assert.ok(rotatedHashes(db).includes(hashToken(LAPTOP_TOKEN)), 'old token must be recorded for reuse detection');
  assert.strictEqual(db.tables.sessions.get('sess-phone').is_active, true, 'other devices are unaffected');

  const next = await rotateRefreshToken(db, result.newRefreshToken);
  assert.strictEqual(next.status, 'ok', 'the replacement token must itself be usable');
  assertQuiescent(db);
  console.log('PASS: rotation swaps the token on the session and records the old one');
}

async function testInactiveSessionIsRejectedWithoutConsumingToken() {
  const db = freshDb();
  db.tables.sessions.get('sess-laptop').is_active = false;
  assert.deepStrictEqual(await rotateRefreshToken(db, LAPTOP_TOKEN), { status: 'invalid' });
  assert.ok(db.tables.refresh_tokens.has(hashToken(LAPTOP_TOKEN)), 'rejected token must not be consumed');
  assert.ok(!rotatedHashes(db).includes(hashToken(LAPTOP_TOKEN)), 'rejected token must not be marked rotated');
  assertQuiescent(db);
  console.log('PASS: refresh on a revoked session is rejected and changes nothing');
}

async function testExpiredAndUnknownTokens() {
  const db = freshDb();
  db.tables.refresh_tokens.get(hashToken(PHONE_TOKEN)).expires_at = Date.now() - 1000;
  assert.deepStrictEqual(await rotateRefreshToken(db, PHONE_TOKEN), { status: 'invalid' });
  assert.deepStrictEqual(await rotateRefreshToken(db, 'never-issued'), { status: 'invalid' });
  assert.deepStrictEqual(await revokeRefreshTokenForLogout(db, 'never-issued'), { status: 'none' });
  assert.strictEqual(sessionsOf(db, 7).filter((s) => s.is_active).length, 2, 'unknown tokens must not revoke anything');
  assertQuiescent(db);
  console.log('PASS: expired and unknown tokens are rejected without side effects');
}

async function testLogoutRevokesItsSession() {
  const db = freshDb();
  assert.deepStrictEqual(await revokeRefreshTokenForLogout(db, LAPTOP_TOKEN), { status: 'revoked', userId: 7 });
  assert.strictEqual(db.tables.sessions.get('sess-laptop').is_active, false);
  assert.ok(!db.tables.refresh_tokens.has(hashToken(LAPTOP_TOKEN)));
  assert.strictEqual(db.tables.sessions.get('sess-phone').is_active, true, 'logout ends only its own session');
  assertQuiescent(db);
  console.log('PASS: logout revokes the token and deactivates its session only');
}

async function testLogoutRacingRefreshLeavesNoLiveSession() {
  // Refresh claims the token first: the logout finds it rotated and treats it as reuse.
  {
    const db = freshDb();
    db.barrier = createBarrier(2);
    const [refresh, logout] = await Promise.all([
      rotateRefreshToken(db, LAPTOP_TOKEN),
      revokeRefreshTokenForLogout(db, LAPTOP_TOKEN),
    ]);
    db.barrier = null;
    assert.strictEqual(refresh.status, 'ok');
    assert.deepStrictEqual(logout, { status: 'reused', userId: 7 });
    assertFamilyRevoked(db, 7);
    assertBystanderUntouched(db);
    assertQuiescent(db);
  }
  // Logout claims the token first: the refresh finds nothing to rotate.
  {
    const db = freshDb();
    db.barrier = createBarrier(2);
    const [logout, refresh] = await Promise.all([
      revokeRefreshTokenForLogout(db, LAPTOP_TOKEN),
      rotateRefreshToken(db, LAPTOP_TOKEN),
    ]);
    db.barrier = null;
    assert.deepStrictEqual(logout, { status: 'revoked', userId: 7 });
    assert.deepStrictEqual(refresh, { status: 'invalid' });
    assert.strictEqual(db.tables.sessions.get('sess-laptop').is_active, false);
    assert.strictEqual(tokensOf(db, 7).length, 1, 'only the other device keeps a token');
    assertQuiescent(db);
  }
  console.log('PASS: logout racing refresh never leaves the session alive');
}

(async () => {
  await testConcurrentRefreshCannotBothSucceed();
  await testSequentialReplayIsReuse();
  await testRotationReplacesTokenOnSession();
  await testInactiveSessionIsRejectedWithoutConsumingToken();
  await testExpiredAndUnknownTokens();
  await testLogoutRevokesItsSession();
  await testLogoutRacingRefreshLeavesNoLiveSession();
  console.log('All refresh rotation tests passed.');
  process.exit(0);
})().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
