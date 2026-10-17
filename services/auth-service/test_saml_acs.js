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
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const {
  normalizeEmail,
  validateEmail,
  generateSamlRequestId,
  buildSamlAuthnRequest,
  extractSamlInResponseTo,
  SAML_AUTHN_REQUEST_ID_PATTERN,
  SAML_AUTHN_REQUEST_TTL_MINUTES,
} = require('./index');

const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function section(name, fn) {
  fn();
  console.log(`PASS: ${name}`);
}

function parse(xml) {
  return new DOMParser().parseFromString(xml, 'text/xml');
}

const NS_PROTOCOL = 'urn:oasis:names:tc:SAML:2.0:protocol';
const NS_ASSERTION = 'urn:oasis:names:tc:SAML:2.0:assertion';

section('AuthnRequest ids are opaque, unpredictable and single-use shaped', () => {
  const id = generateSamlRequestId();
  assert.ok(SAML_AUTHN_REQUEST_ID_PATTERN.test(id), `id must match the issued-id pattern: ${id}`);
  const other = generateSamlRequestId();
  assert.notStrictEqual(id, other, 'ids must not repeat');
  assert.ok(SAML_AUTHN_REQUEST_TTL_MINUTES > 0 && SAML_AUTHN_REQUEST_TTL_MINUTES <= 30,
    'AuthnRequest TTL must be short (<= 30 minutes)');
});

section('AuthnRequest XML carries the id the ACS later verifies', () => {
  const requestId = generateSamlRequestId();
  const xml = buildSamlAuthnRequest({
    requestId,
    issueInstant: '2026-10-17T09:00:00.000Z',
    entityId: 'https://sp.atlas.test/saml/metadata',
    acsUrl: 'https://sp.atlas.test/saml/acs',
    idpSsoUrl: 'https://idp.atlas.test/sso',
  });
  assert.ok(xml.includes(`ID="${requestId}"`), 'request must embed the generated id');
  assert.ok(xml.includes(`IssueInstant="2026-10-17T09:00:00.000Z"`), 'request must embed its issue instant');
  assert.ok(xml.includes(`Destination="https://idp.atlas.test/sso"`), 'request must target the IdP SSO URL');
  assert.ok(xml.includes(`AssertionConsumerServiceURL="https://sp.atlas.test/saml/acs"`), 'request must name the ACS URL');
  assert.ok(xml.includes('nameid-format:emailAddress'), 'request must ask for the email NameID format');
  assert.ok(xml.includes(`xmlns:samlp="${NS_PROTOCOL}"`), 'request must declare the SAML protocol namespace');
});

section('InResponseTo is read from the Response and the SubjectConfirmationData', () => {
  const responseLevel = `<samlp:Response xmlns:samlp="${NS_PROTOCOL}" InResponseTo="_aabbccddeeff00112233445566778899"></samlp:Response>`;
  assert.strictEqual(
    extractSamlInResponseTo(parse(responseLevel)),
    '_aabbccddeeff00112233445566778899',
    'response-level InResponseTo must be found'
  );

  const subjectLevel = `<samlp:Response xmlns:samlp="${NS_PROTOCOL}" xmlns:saml="${NS_ASSERTION}">
    <saml:Subject><saml:SubjectConfirmation><saml:SubjectConfirmationData InResponseTo="_00112233445566778899aabbccddeeff"/></saml:SubjectConfirmation></saml:Subject>
  </samlp:Response>`;
  assert.strictEqual(
    extractSamlInResponseTo(parse(subjectLevel)),
    '_00112233445566778899aabbccddeeff',
    'SubjectConfirmationData-level InResponseTo must be found'
  );

  const missing = `<samlp:Response xmlns:samlp="${NS_PROTOCOL}"></samlp:Response>`;
  assert.strictEqual(extractSamlInResponseTo(parse(missing)), '', 'missing InResponseTo must yield an empty string');
});

section('asserted email variants collapse to one account identity', () => {
  const raw = '  Alice.Roe@Example.COM  ';
  assert.strictEqual(normalizeEmail(raw), 'alice.roe@example.com');
  assert.strictEqual(validateEmail(raw), null);
  assert.strictEqual(normalizeEmail(raw), normalizeEmail('alice.roe@example.com'),
    'mixed-case and whitespace variants must map to the same lookup key');
});

section('malformed asserted emails are rejected before lookup or creation', () => {
  assert.ok(validateEmail(normalizeEmail('not-an-email')));
  assert.ok(validateEmail(normalizeEmail('no@domain')));
  assert.ok(validateEmail(normalizeEmail('')));
  assert.ok(validateEmail(normalizeEmail(`${'a'.repeat(250)}@example.com`)), 'over-long emails must be rejected');
});

section('AuthnRequest ids are persisted at generation', () => {
  const tableAt = source.indexOf('CREATE TABLE IF NOT EXISTS saml_authn_requests');
  assert.ok(tableAt !== -1, 'initDB must create the saml_authn_requests table');
  const tableBlock = source.slice(tableAt, tableAt + 600);
  assert.ok(tableBlock.includes('request_id'), 'tracking table must key on request_id');
  assert.ok(tableBlock.includes('expires_at'), 'tracking table must carry an expiry');
  assert.ok(tableBlock.includes('consumed_at'), 'tracking table must record one-time consumption');

  const loginAt = source.indexOf("app.post('/saml/login'");
  const loginBlock = source.slice(loginAt, source.indexOf("app.post('/auth/passwordless/request'", loginAt));
  assert.ok(loginBlock.includes('recordSamlAuthnRequest'), 'saml/login must persist the issued request id');
  assert.ok(loginBlock.includes('buildSamlAuthnRequest'), 'saml/login must build the request from the tracked id');
  assert.ok(tableAt < source.indexOf('initDB().catch'), 'schema must be part of initDB');
});

section('ACS requires InResponseTo and consumes it exactly once', () => {
  const acsAt = source.indexOf("app.post('/saml/acs'");
  const acsBlock = source.slice(acsAt, source.indexOf("app.get('/saml/metadata'", acsAt));
  assert.ok(acsBlock.includes('extractSamlInResponseTo'), 'ACS must read InResponseTo');
  assert.ok(acsBlock.includes('SAML_AUTHN_REQUEST_ID_PATTERN'), 'ACS must reject malformed InResponseTo values');
  assert.ok(acsBlock.includes('consumeSamlAuthnRequest'), 'ACS must redeem the request id');
  assert.ok(acsBlock.includes('replay'), 'ACS must reject replays with a clear answer');

  const consumeAt = source.indexOf('async function consumeSamlAuthnRequest');
  const consumeBlock = source.slice(consumeAt, consumeAt + 600);
  assert.ok(consumeBlock.includes('consumed_at IS NULL'), 'redemption must be conditional on unused state (atomic)');
  assert.ok(consumeBlock.includes('expires_at > NOW()'), 'redemption must reject expired request ids');
  assert.ok(consumeBlock.includes('UPDATE saml_authn_requests'), 'redemption must be a single atomic UPDATE');
});

section('ACS rejects unsigned responses and bad asserted emails before provisioning', () => {
  const acsAt = source.indexOf("app.post('/saml/acs'");
  const acsBlock = source.slice(acsAt, source.indexOf("app.get('/saml/metadata'", acsAt));
  assert.ok(acsBlock.includes('SAML response is not signed'), 'unsigned responses must be rejected');
  assert.ok(acsBlock.includes('signatureNodes.length === 0'), 'signature presence must be checked');
  assert.ok(!acsBlock.includes('signatureNodes.length === 0) {\n      signatureVerified = true'),
    'missing signatures must never bypass verification');
  assert.ok(acsBlock.indexOf('validateEmail') < acsBlock.indexOf('INSERT INTO users'),
    'email validation must run before any account creation');
});

section('SAML provisioning pins tenant, role and active explicitly', () => {
  const insertAt = source.indexOf('INSERT INTO users (email, password, name, role, department, position, tenant_id, active)');
  assert.ok(insertAt !== -1, 'SAML provisioning insert must set role, tenant_id and active explicitly');
  const insertBlock = source.slice(insertAt, insertAt + 400);
  assert.ok(insertBlock.includes("'employee'"), 'provisioned accounts must get the least-privileged role');
  assert.ok(insertBlock.includes('SAML_TENANT_ID'), 'provisioned accounts must carry the pinned tenant');
  assert.ok(insertBlock.includes('true'), 'provisioned accounts must be explicitly active');
  assert.ok(source.includes('saml_user_provisioned'), 'JIT provisioning must be audited');
});

console.log('All SAML ACS tests passed.');
process.exit(0);
