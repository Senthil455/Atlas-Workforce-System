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

function extractHelper() {
  const helperStart = source.indexOf('async function issueLoginSession(user, req, res)');
  assert.ok(helperStart !== -1, 'issueLoginSession helper must exist');
  const returnMarker = 'return { sessionId, accessToken, refreshToken };';
  const returnIdx = source.indexOf(returnMarker, helperStart);
  assert.ok(returnIdx !== -1, 'helper must return session tokens');
  const closeIdx = source.indexOf('}', returnIdx + returnMarker.length);
  assert.ok(closeIdx !== -1, 'helper must close');
  return source.slice(helperStart, closeIdx + 1);
}

function testHelperExists() {
  const helper = extractHelper();
  assert.ok(helper.includes('signAccessToken(user, sessionId)'), 'helper must issue access token with session id');
  assert.ok(helper.includes('await createRefreshToken(user.id)'), 'helper must create refresh token');
  assert.ok(helper.includes('INSERT INTO sessions'), 'helper must write a sessions row');
  assert.ok(helper.includes("res.cookie('refreshToken'"), 'helper must set the refresh cookie');
  console.log('PASS: issueLoginSession helper writes session row and sets cookie');
}

function testLoginRoutesUseHelper() {
  const login = sliceRoute("app.post('/login'");
  const passwordless = sliceRoute("app.post('/auth/passwordless/verify'");
  const webauthn = sliceRoute("app.post('/webauthn/authenticate/complete'");
  const refresh = sliceRoute("app.post('/refresh'");

  for (const [name, body] of [['/login', login], ['/auth/passwordless/verify', passwordless], ['/webauthn/authenticate/complete', webauthn]]) {
    assert.ok(body.includes('issueLoginSession'), `${name} must call issueLoginSession`);
    assert.ok(!body.includes('await createRefreshToken(user.id);') || body.includes('issueLoginSession'), `${name} must not create orphan refresh tokens`);
    console.log(`PASS: ${name} uses shared login session helper`);
  }

  assert.ok(!passwordless.includes('await createRefreshToken(user.id);\n\n    await sendAuditEvent'), 'passwordless must not use the old orphan-token path');
  assert.ok(!webauthn.includes('await createRefreshToken(user.id);'), 'webauthn must not create a refresh token without a cookie');

  assert.ok(passwordless.includes('session_id'), 'passwordless response must include session_id');
  assert.ok(webauthn.includes('session_id'), 'webauthn response must include session_id');
  console.log('PASS: passwordless and webauthn responses include session_id');

  assert.ok(refresh.includes('req.cookies?.refreshToken'), 'refresh must read the refresh cookie');
  assert.ok(refresh.includes("res.cookie('refreshToken'"), 'refresh must rotate and re-set the refresh cookie');
  assert.ok(refresh.includes('token,'), 'refresh response must include the new access token');
  console.log('PASS: POST /refresh reads cookie, rotates it, and returns new access token');
}

async function testHelperSetsCookieAndSessionRow() {
  const helperSrc = extractHelper();

  const queries = [];
  let cookie = null;
  const fakePool = {
    query: async (text, params) => {
      queries.push({ text, params });
      return { rows: [] };
    },
  };
  const fakeReq = { headers: { 'x-device-id': 'test-device', 'user-agent': 'test-agent' }, ip: '127.0.0.1' };
  const fakeRes = {
    cookie: (name, value, opts) => {
      cookie = { name, value, opts };
    },
  };

  const runHelper = new Function(
    'pool',
    'hashToken',
    'signAccessToken',
    'createRefreshToken',
    'uuidv4',
    'REFRESH_EXPIRY_DAYS',
    'NODE_ENV',
    'user',
    'req',
    'res',
    `${helperSrc}\nreturn issueLoginSession(user, req, res);`
  );

  const result = await runHelper(
    fakePool,
    (t) => `hash:${t}`,
    () => 'access-token',
    async () => 'refresh-token',
    () => 'session-id-123',
    7,
    'test',
    { id: 42 },
    fakeReq,
    fakeRes
  );

  assert.strictEqual(result.sessionId, 'session-id-123');
  assert.strictEqual(result.accessToken, 'access-token');
  assert.strictEqual(result.refreshToken, 'refresh-token');
  assert.ok(cookie, 'helper must set a cookie');
  assert.strictEqual(cookie.name, 'refreshToken');
  assert.strictEqual(cookie.value, 'refresh-token');
  assert.strictEqual(cookie.opts.httpOnly, true);
  const sessionInsert = queries.find((q) => q.text.includes('INSERT INTO sessions'));
  assert.ok(sessionInsert, 'helper must insert a sessions row');
  assert.strictEqual(sessionInsert.params[0], 'session-id-123');
  assert.strictEqual(sessionInsert.params[1], 42);
  console.log('PASS: helper delivers refresh cookie and session row, refresh can follow');
}

(async () => {
  testHelperExists();
  testLoginRoutesUseHelper();
  await testHelperSetsCookieAndSessionRow();
  console.log('All login session tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
