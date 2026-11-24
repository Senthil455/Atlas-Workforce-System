// Dummy env so the service module can be required without real secrets.
// Keep this block in sync with the fatal startup checks in index.js; the
// module refuses to load (process.exit) when any of them is missing.
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
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const {
  issuerMatchesProvider,
  validateOAuthIdToken,
  computeCacheTtlMs,
  oidcDiscoveryUrlFor,
  normalizeJwksBundle,
  verifyIdTokenSignature,
  verifyOAuthIdTokenSignature,
  verifyOAuthIdToken,
  OIDC_DISCOVERY_DEFAULT_TTL_MS,
} = require('./index');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

// Two independent RSA keys exercise kid selection and rotation without any
// network access: the JWKS documents below are built from their public halves.
const keyPairA = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPairB = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID_A = 'unit-test-kid-a';
const KID_B = 'unit-test-kid-b';
const CLIENT_ID = 'unit-test-client-id';
const NONCE = 'unit-test-nonce-value';
const JWKS_URI = 'https://stub.test/certs';
const DISCOVERY_URL = 'https://accounts.google.com/.well-known/openid-configuration';

function jwksEntry(keyPair, kid) {
  const jwk = keyPair.publicKey.export({ format: 'jwk' });
  return { kty: 'RSA', n: jwk.n, e: jwk.e, kid, use: 'sig', alg: 'RS256' };
}

const jwksA = { keys: [jwksEntry(keyPairA, KID_A)] };
const jwksB = { keys: [jwksEntry(keyPairB, KID_B)] };

function signToken(keyPair, kid, overrides) {
  const payload = {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    email: 'user@example.com',
    email_verified: true,
    nonce: NONCE,
    ...overrides,
  };
  return { token: jwt.sign(payload, keyPair.privateKey, { algorithm: 'RS256', keyid: kid }), payload };
}

function stubFetcher(documents) {
  let index = 0;
  const calls = [];
  return {
    calls,
    fetchJson: async (url) => {
      calls.push(url);
      const document = documents[Math.min(index, documents.length - 1)];
      index += 1;
      return { data: document, headers: { 'cache-control': 'max-age=3600' } };
    },
  };
}

function testIssuerMatching() {
  // Exact hostname matching: prefix and substring tricks must all fail.
  assert.strictEqual(issuerMatchesProvider('https://accounts.google.com', 'google'), true);
  assert.strictEqual(issuerMatchesProvider('accounts.google.com', 'google'), true);
  assert.strictEqual(issuerMatchesProvider('https://accounts.google.com.evil.com', 'google'), false);
  assert.strictEqual(issuerMatchesProvider('https://evil-accounts.google.com', 'google'), false);
  assert.strictEqual(issuerMatchesProvider('http://accounts.google.com', 'google'), false);
  assert.strictEqual(issuerMatchesProvider('https://login.microsoftonline.com/contoso/v2.0', 'microsoft'), true);
  assert.strictEqual(issuerMatchesProvider('https://login.microsoftonline.com.evil.com', 'microsoft'), false);
  assert.strictEqual(issuerMatchesProvider('https://acme.okta.com', 'okta'), true);
  assert.strictEqual(issuerMatchesProvider('https://evil.com/?x=.okta.com', 'okta'), false);
  assert.strictEqual(issuerMatchesProvider('https://acme.okta.com.evil.com', 'okta'), false);
  assert.strictEqual(issuerMatchesProvider('https://okta.com', 'okta'), false);
  assert.strictEqual(issuerMatchesProvider('', 'google'), false);
  assert.strictEqual(issuerMatchesProvider(undefined, 'google'), false);
  console.log('PASS: exact issuer matching');
}

function testClaimValidation() {
  const { token: validToken } = signToken(keyPairA, KID_A, {});
  assert.strictEqual(validateOAuthIdToken(validToken, 'google', CLIENT_ID, 'user@example.com', { nonce: NONCE }).valid, true);

  const { token: noExp } = signToken(keyPairA, KID_A, { exp: undefined });
  assert.strictEqual(validateOAuthIdToken(noExp, 'google', CLIENT_ID, '', {}).reason, 'id_token missing exp claim');

  const { token: expired } = signToken(keyPairA, KID_A, { exp: Math.floor(Date.now() / 1000) - 10 });
  assert.strictEqual(validateOAuthIdToken(expired, 'google', CLIENT_ID, '', {}).reason, 'id_token expired');

  const { token: futureNbf } = signToken(keyPairA, KID_A, { nbf: Math.floor(Date.now() / 1000) + 600 });
  assert.strictEqual(validateOAuthIdToken(futureNbf, 'google', CLIENT_ID, '', {}).reason, 'id_token not yet valid');

  const { token: badNbf } = signToken(keyPairA, KID_A, { nbf: 'soon' });
  assert.strictEqual(validateOAuthIdToken(badNbf, 'google', CLIENT_ID, '', {}).reason, 'id_token malformed nbf claim');

  const { token: noAud } = signToken(keyPairA, KID_A, { aud: undefined });
  assert.strictEqual(validateOAuthIdToken(noAud, 'google', CLIENT_ID, '', {}).reason, 'id_token missing aud claim');

  const { token: audArrayOk } = signToken(keyPairA, KID_A, { aud: ['other-client', CLIENT_ID] });
  assert.strictEqual(validateOAuthIdToken(audArrayOk, 'google', CLIENT_ID, '', {}).valid, true);

  const { token: audArrayBad } = signToken(keyPairA, KID_A, { aud: ['other-client'] });
  assert.strictEqual(validateOAuthIdToken(audArrayBad, 'google', CLIENT_ID, '', {}).reason, 'audience mismatch');

  const { token: badAzp } = signToken(keyPairA, KID_A, { azp: 'another-client' });
  assert.strictEqual(validateOAuthIdToken(badAzp, 'google', CLIENT_ID, '', {}).reason, 'authorized party mismatch');

  const { token: evilIssuer } = signToken(keyPairA, KID_A, { iss: 'https://accounts.google.com.evil.com' });
  assert.ok(validateOAuthIdToken(evilIssuer, 'google', CLIENT_ID, '', {}).reason.startsWith('issuer mismatch'));

  const { token: missingNonce } = signToken(keyPairA, KID_A, { nonce: undefined });
  assert.strictEqual(validateOAuthIdToken(missingNonce, 'google', CLIENT_ID, '', { nonce: NONCE }).reason, 'id_token missing nonce claim');

  const { token: wrongNonce } = signToken(keyPairA, KID_A, { nonce: 'other-nonce' });
  assert.strictEqual(validateOAuthIdToken(wrongNonce, 'google', CLIENT_ID, '', { nonce: NONCE }).reason, 'nonce mismatch');

  const required = validateOAuthIdToken(undefined, 'google', CLIENT_ID, '', { nonce: NONCE });
  assert.strictEqual(required.valid, false);
  assert.ok(required.reason.includes('required'));

  const skipped = validateOAuthIdToken(undefined, 'github', CLIENT_ID, '', {});
  assert.strictEqual(skipped.valid, true);
  assert.strictEqual(skipped.skipped, true);

  const githubToken = validateOAuthIdToken(validToken, 'github', CLIENT_ID, '', {});
  assert.strictEqual(githubToken.valid, false);

  const { token: emailMismatch } = signToken(keyPairA, KID_A, { email: 'other@example.com' });
  assert.strictEqual(validateOAuthIdToken(emailMismatch, 'google', CLIENT_ID, 'user@example.com', {}).reason, 'email mismatch between id_token and userinfo');

  const { token: unverified } = signToken(keyPairA, KID_A, { email_verified: false });
  assert.strictEqual(validateOAuthIdToken(unverified, 'google', CLIENT_ID, '', {}).reason, 'email_verified false in id_token');
  console.log('PASS: id_token claim validation fails closed');
}

function testCacheTtl() {
  assert.strictEqual(computeCacheTtlMs('public, max-age=30'), 60 * 1000, 'below-minimum max-age clamps up');
  assert.strictEqual(computeCacheTtlMs('max-age=7200'), 7200 * 1000);
  assert.strictEqual(computeCacheTtlMs('no-store'), OIDC_DISCOVERY_DEFAULT_TTL_MS, 'missing max-age uses the documented default');
  assert.strictEqual(computeCacheTtlMs(undefined), OIDC_DISCOVERY_DEFAULT_TTL_MS);
  assert.strictEqual(computeCacheTtlMs('max-age=99999999'), 24 * 60 * 60 * 1000, 'absurd max-age clamps down');
  console.log('PASS: discovery cache TTL bounds');
}

function testDiscoveryUrls() {
  assert.strictEqual(oidcDiscoveryUrlFor('google', null), DISCOVERY_URL);
  assert.strictEqual(new URL(oidcDiscoveryUrlFor('microsoft', null)).hostname, 'login.microsoftonline.com');
  assert.strictEqual(oidcDiscoveryUrlFor('okta', 'https://acme.okta.com'), 'https://acme.okta.com/.well-known/openid-configuration');
  assert.strictEqual(oidcDiscoveryUrlFor('okta', null), null, 'okta without a valid base fails closed');
  assert.strictEqual(oidcDiscoveryUrlFor('github', null), null, 'github is plain OAuth2 with no discovery');
  console.log('PASS: discovery URL resolution');
}

function testJwksImportAndSignature() {
  const keys = normalizeJwksBundle(jwksA);
  assert.strictEqual(keys.size, 1);
  assert.ok(keys.get(KID_A).includes('BEGIN PUBLIC KEY'), 'JWK converts to SPKI PEM');

  assert.strictEqual(normalizeJwksBundle({ keys: [{ kty: 'EC', kid: 'x' }, { kty: 'RSA' }] }).size, 0, 'non-RSA and kid-less keys are skipped');
  assert.strictEqual(normalizeJwksBundle(null).size, 0);

  const { token } = signToken(keyPairA, KID_A, {});
  assert.strictEqual(verifyIdTokenSignature(token, jwksA).valid, true);
  assert.strictEqual(verifyIdTokenSignature(token, keys).valid, true);

  const parts = token.split('.');
  const tamperedBody = Buffer.from(JSON.stringify({ sub: 'attacker' })).toString('base64url');
  const tampered = `${parts[0]}.${tamperedBody}.${parts[2]}`;
  assert.strictEqual(verifyIdTokenSignature(tampered, jwksA).valid, false);

  const unknown = verifyIdTokenSignature(token, jwksB);
  assert.strictEqual(unknown.valid, false);
  assert.strictEqual(unknown.unknownKey, true);

  const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', kid: KID_A })).toString('base64url');
  const noneToken = `${noneHeader}.${parts[1]}.`;
  assert.ok(verifyIdTokenSignature(noneToken, jwksA).reason.includes('algorithm'));
  console.log('PASS: JWKS import and signature verification');
}

async function testSignatureCachingAndRotation() {
  const { token: tokenA } = signToken(keyPairA, KID_A, {});
  const { token: tokenB } = signToken(keyPairB, KID_B, {});

  const stub = stubFetcher([jwksA, jwksB]);
  const cache = new Map();

  const first = await verifyOAuthIdTokenSignature(tokenA, JWKS_URI, { fetchJson: stub.fetchJson, cache });
  assert.strictEqual(first.valid, true);
  assert.strictEqual(stub.calls.length, 1, 'first verification fetches the JWKS once');

  const second = await verifyOAuthIdTokenSignature(tokenA, JWKS_URI, { fetchJson: stub.fetchJson, cache });
  assert.strictEqual(second.valid, true);
  assert.strictEqual(stub.calls.length, 1, 'cached bundle is reused');

  // Key rotation: kid B is unknown in the cached bundle, so it is refetched
  // once and the rotated token verifies.
  const rotated = await verifyOAuthIdTokenSignature(tokenB, JWKS_URI, { fetchJson: stub.fetchJson, cache });
  assert.strictEqual(rotated.valid, true, 'rotated key is picked up without a restart');
  assert.strictEqual(stub.calls.length, 2, 'exactly one refetch happens');

  // The old kid is gone after rotation: two lookups then reject.
  const oldToken = await verifyOAuthIdTokenSignature(tokenA, JWKS_URI, { fetchJson: stub.fetchJson, cache });
  assert.strictEqual(oldToken.valid, false);
  assert.strictEqual(stub.calls.length, 3);

  const stableStub = stubFetcher([jwksB]);
  const unknownKid = await verifyOAuthIdTokenSignature(tokenA, JWKS_URI, { fetchJson: stableStub.fetchJson, cache: new Map() });
  assert.strictEqual(unknownKid.valid, false);
  assert.strictEqual(stableStub.calls.length, 2, 'unknown kid refetches once, then fails closed');
  console.log('PASS: JWKS caching and key rotation');
}

async function testFullVerificationWithStubbedDiscovery() {
  const { token } = signToken(keyPairA, KID_A, {});

  const happyFetch = async (url) => {
    if (url === DISCOVERY_URL) {
      return { data: { issuer: 'https://accounts.google.com', jwks_uri: JWKS_URI }, headers: { 'cache-control': 'max-age=1800' } };
    }
    if (url === JWKS_URI) return { data: jwksA, headers: {} };
    throw new Error(`unexpected URL ${url}`);
  };

  const ok = await verifyOAuthIdToken(token, 'google', { client_id: CLIENT_ID }, 'user@example.com', {
    nonce: NONCE,
    fetchJson: happyFetch,
    cache: new Map(),
  });
  assert.strictEqual(ok.valid, true, 'full verification passes with matching nonce and signature');

  const replay = await verifyOAuthIdToken(token, 'google', { client_id: CLIENT_ID }, 'user@example.com', {
    nonce: 'other-nonce',
    fetchJson: happyFetch,
    cache: new Map(),
  });
  assert.strictEqual(replay.valid, false, 'a token minted for another nonce is rejected');
  assert.strictEqual(replay.reason, 'nonce mismatch');

  const discoveryDown = await verifyOAuthIdToken(token, 'google', { client_id: CLIENT_ID }, 'user@example.com', {
    nonce: NONCE,
    fetchJson: async () => { throw new Error('network down'); },
    cache: new Map(),
  });
  assert.strictEqual(discoveryDown.valid, false, 'discovery outage fails closed');
  assert.ok(discoveryDown.reason.includes('JWKS'));

  const malformedDoc = await verifyOAuthIdToken(token, 'google', { client_id: CLIENT_ID }, 'user@example.com', {
    nonce: NONCE,
    fetchJson: async () => ({ data: { issuer: 'https://accounts.google.com' }, headers: {} }),
    cache: new Map(),
  });
  assert.strictEqual(malformedDoc.valid, false, 'document without jwks_uri fails closed');

  const noDiscoveryProvider = await verifyOAuthIdToken(undefined, 'github', { client_id: CLIENT_ID }, '', {});
  assert.strictEqual(noDiscoveryProvider.skipped, true, 'github never consults discovery');
  console.log('PASS: full verification against stubbed discovery and JWKS');
}

function testSourceWiring() {
  assert.ok(source.includes('ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS nonce'), 'state row must carry the nonce');
  assert.ok(source.includes('INSERT INTO oauth_states (state, provider, tenant_id, redirect_to, nonce, expires_at)'), 'nonce is persisted with the state');
  assert.ok(source.includes('verifyOAuthIdToken(idToken, provider, prov, email, { nonce: oauthState.nonce })'), 'callback validates the id_token against the stored nonce');
  assert.ok(source.includes('api.github.com/user/emails'), 'github email comes from the emails API');
  assert.ok(source.includes('entry.primary === true && entry.verified === true'), 'github requires a verified address');
  assert.ok(!source.includes('@${provider}.oauth'), 'synthetic oauth emails are gone');
  assert.ok(!source.includes("endsWith('.oauth')"), 'synthetic oauth email checks are gone');
  assert.ok(source.includes('id_token signature could not be verified against provider JWKS'), 'signature failures fail closed');
  assert.ok(source.includes('normalizeEmail(rawEmail)'), 'callback email is normalized before linking');
  assert.ok(source.includes('normalizeEmail(verifiedEmail.email)'), 'github verified email is normalized');
  console.log('PASS: source wiring for oauth hardening');
}

testIssuerMatching();
testClaimValidation();
testCacheTtl();
testDiscoveryUrls();
testJwksImportAndSignature();
testSourceWiring();
Promise.all([testSignatureCachingAndRotation(), testFullVerificationWithStubbedDiscovery()])
  .then(() => {
    console.log('All oauth hardening tests passed.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('FAILED:', err.message);
    process.exit(1);
  });
