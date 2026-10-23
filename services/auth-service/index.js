require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { authenticator } = require('otplib');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const redis = require('redis');
const { DOMParser } = require('@xmldom/xmldom');
const { SignedXml } = require('xml-crypto');
const { rateLimit } = require('express-rate-limit');
const { subtle } = crypto.webcrypto;
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const promClient = require('prom-client');

const httpRequestCount = new promClient.Counter({
  name: 'atlas_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'path', 'status_code'],
});

const httpRequestDuration = new promClient.Histogram({
  name: 'atlas_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
});

const httpRequestsInProgress = new promClient.Gauge({
  name: 'atlas_http_requests_in_progress',
  help: 'Number of HTTP requests in progress',
  labelNames: ['method', 'path'],
});

const auditDeliveryFailuresTotal = new promClient.Counter({
  name: 'atlas_audit_delivery_failures_total',
  help: 'Total audit log delivery failures from auth-service',
  labelNames: ['event_type'],
});
const authFailedLoginTotal = new promClient.Counter({
  name: 'atlas_auth_failed_login_total',
  help: 'Total failed login attempts',
  labelNames: ['known_user'],
});

// Auth-store (Redis) degradations. The fail-closed paths below increment this
// whenever a request is withheld because the store could not answer.
const redisDegradedTotal = new promClient.Counter({
  name: 'atlas_auth_redis_degraded_total',
  help: 'Fail-closed refusals caused by the auth store (Redis) being unavailable',
  labelNames: ['check'],
});

promClient.collectDefaultMetrics();

const app = express();
app.use(helmet());
// Cookie-authenticated unsafe routes (/refresh, /logout) enforce
// double-submit CSRF tokens (see requireCsrfDoubleSubmit): they require the
// readable csrf_token cookie echoed in the x-csrf-token header and fail closed
// when it is missing. Requests that authenticate with a Bearer header are
// exempt because browsers never attach that header cross-site; every other
// state-changing route authenticates with Bearer JWTs, which are immune to
// CSRF. All cookies are SameSite=strict.
// codeql[js/missing-token-validation]
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

const NODE_ENV = process.env.NODE_ENV || 'production';
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
if (!allowedOriginsEnv || !allowedOriginsEnv.trim()) {
  console.error('FATAL: ALLOWED_ORIGINS environment variable is required (comma-separated, no localhost fallback)');
  process.exit(1);
}
const allowedOrigins = allowedOriginsEnv
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (NODE_ENV === 'production' && allowedOrigins.some((o) => o.includes('localhost') || o.startsWith('http://'))) {
  console.error('FATAL: refusing to start with insecure ALLOWED_ORIGINS in production (localhost/HTTP); use explicit HTTPS origins');
  process.exit(1);
}

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
  })
);

function metricsMiddleware(req, res, next) {
  if (req.path === '/metrics' || req.path === '/health') {
    return next();
  }
  const path = req.path.replace(/\/[0-9a-fA-F-]{36}|\/\d+/g, '/:param');
  httpRequestsInProgress.labels({ method: req.method, path }).inc();
  const start = Date.now();
  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    httpRequestsInProgress.labels({ method: req.method, path }).dec();
    httpRequestCount.labels({ method: req.method, path, status_code: res.statusCode }).inc();
    httpRequestDuration.labels({ method: req.method, path, status_code: res.statusCode }).observe(duration);
  });
  next();
}
app.use(metricsMiddleware);

// Baseline abuse protection on every route. The stricter per-route custom
// limiters (createUserRateLimiter, Redis-backed) stay in place for
// credential-bearing endpoints; this global limiter is defense in depth.
const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // The gateway passes the real client IP in x-real-client-ip; never trust
  // X-Forwarded-For. Using it here also avoids trust-proxy misconfiguration.
  keyGenerator: (req) => getClientIp(req),
  message: { message: 'Too many requests. Please try again later.' },
});
app.use(globalRateLimiter);

const PORT = process.env.PORT || 8010;
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD;
const ACCESS_EXPIRY = '15m';
const REFRESH_EXPIRY_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const AUDIT_SERVICE_URL = process.env.AUDIT_SERVICE_URL;
if (!AUDIT_SERVICE_URL) {
  console.error('FATAL: AUDIT_SERVICE_URL environment variable is required');
  process.exit(1);
}
const INTERNAL_JWT_SECRET = process.env.INTERNAL_JWT_SECRET;
const AUDIT_WRITER_AUDIENCE = 'audit-writer';
const SAML_IDP_SSO_URL = process.env.SAML_IDP_SSO_URL || '';
const SAML_IDP_ENTITY_ID = process.env.SAML_IDP_ENTITY_ID || '';
const SAML_IDP_CERT = (process.env.SAML_IDP_CERT || '').replace(/\\n/g, '\n');
// Tenant assigned to accounts provisioned Just-In-Time by a SAML login. The
// flow carries no tenant hint from the IdP, so the SP pins it server-side.
const SAML_TENANT_ID = process.env.SAML_TENANT_ID || 'default';
// AuthnRequest identifiers are persisted for a short window so the ACS can
// match InResponseTo, enforce one-time consumption, and reject replayed
// assertions even when their own conditions are still inside their lifetime.
const SAML_AUTHN_REQUEST_TTL_MINUTES = 10;
const SAML_AUTHN_REQUEST_ID_PATTERN = /^_[0-9a-f]{32}$/;
const SCIM_API_KEY = process.env.SCIM_API_KEY;
const SCIM_ALLOWED_ROLES = ['employee'];

function parseScimApiKeys() {
  const raw = process.env.SCIM_API_KEYS || '';
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
      // Fall through to comma-separated parsing
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

const SCIM_TENANT_KEYS = parseScimApiKeys();

if (SCIM_TENANT_KEYS.size === 0) {
  console.warn('WARNING: SCIM_API_KEYS is not set; legacy SCIM_API_KEY is scoped to the default tenant only. Set SCIM_API_KEYS to provision other tenants.');
}

function scimTimingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

function resolveScimTenant(providedKey) {
  if (!providedKey || typeof providedKey !== 'string') return null;
  for (const [tenant, key] of SCIM_TENANT_KEYS.entries()) {
    if (scimTimingSafeEqual(providedKey, key)) return tenant;
  }
  if (SCIM_API_KEY && scimTimingSafeEqual(providedKey, SCIM_API_KEY)) {
    return 'default';
  }
  return null;
}

function getScimKeyId(providedKey, tenant) {
  try {
    // Keyed fingerprint for log correlation only (never a password hash and
    // never used for authentication). HMAC avoids an unsalted fast hash of
    // the raw provisioning secret.
    const hmacKey = INTERNAL_JWT_SECRET || JWT_SECRET;
    // codeql[js/insufficient-password-hash]
    const hash = crypto.createHmac('sha256', hmacKey).update(String(providedKey)).digest('hex').slice(0, 16);
    return `scim:${tenant || 'unknown'}:${hash}`;
  } catch {
    return `scim:${tenant || 'unknown'}`;
  }
}

function isAllowedScimRole(role) {
  return typeof role === 'string' && SCIM_ALLOWED_ROLES.includes(role);
}

// ---- Scoped API keys (issue #472) ----

// Format: atlas_<16-hex key id>_<64-hex secret>. The key id is a public
// lookup handle stored in the row; only the secret is bcrypt hashed, so a
// database dump does not yield usable credentials.
const API_KEY_PREFIX = 'atlas';
const API_KEY_SCOPES = ['scim:read', 'scim:write'];
const API_KEY_DEFAULT_EXPIRY_DAYS = 90;
const API_KEY_MAX_EXPIRY_DAYS = 730;
const API_KEY_SECRET_BYTES = 32;

function generateApiKey() {
  const keyId = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(API_KEY_SECRET_BYTES).toString('hex');
  return { keyId, secret, apiKey: `${API_KEY_PREFIX}_${keyId}_${secret}` };
}

function parseApiKeyFormat(apiKey) {
  const match = String(apiKey || '').match(/^atlas_([0-9a-f]{16})_([0-9a-f]{64})$/);
  if (!match) return null;
  return { keyId: match[1], secret: match[2] };
}

function validateApiKeyScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return 'scopes must be a non-empty array';
  }
  const unknown = [...new Set(scopes)].filter((scope) => !API_KEY_SCOPES.includes(scope));
  if (unknown.length > 0) {
    return `Unsupported scope: ${unknown[0]}`;
  }
  return null;
}

// Scope required for a SCIM request: reads need scim:read, everything else
// (create/update/patch/delete) needs scim:write.
function scimScopeForRequest(method) {
  const upper = String(method || '').toUpperCase();
  return upper === 'GET' || upper === 'HEAD' ? 'scim:read' : 'scim:write';
}

// scim:write implies scim:read: a key trusted to modify users can list them.
function apiKeyHasScope(scopes, required) {
  const list = Array.isArray(scopes) ? scopes : [];
  if (list.includes(required)) return true;
  if (required === 'scim:read' && list.includes('scim:write')) return true;
  return false;
}

// pg returns jsonb as a JS array; tolerate a stringified array from older
// drivers or fixtures.
function normalizeApiKeyScopes(scopes) {
  if (Array.isArray(scopes)) return scopes;
  if (typeof scopes === 'string') {
    try {
      const parsed = JSON.parse(scopes);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

// State error for an authenticated key, or null when usable. Revocation wins
// over expiry so an explicitly revoked key reports the stronger signal.
function apiKeyStateError(keyRow, now = Date.now()) {
  if (!keyRow) return 'Invalid API key';
  if (keyRow.revoked_at) return 'API key has been revoked';
  if (keyRow.expires_at && new Date(keyRow.expires_at).getTime() <= now) return 'API key has expired';
  return null;
}

function isValidScimUserId(id) {
  const s = String(id || '');
  if (/^[0-9]+$/.test(s)) return true;
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);
}

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}

if (!ADMIN_DEFAULT_PASSWORD) {
  console.error('FATAL: ADMIN_DEFAULT_PASSWORD environment variable is required');
  process.exit(1);
}

if (!INTERNAL_JWT_SECRET) {
  console.error('FATAL: INTERNAL_JWT_SECRET environment variable is required');
  process.exit(1);
}

if (!SCIM_API_KEY) {
  console.error('FATAL: SCIM_API_KEY environment variable is required');
  process.exit(1);
}

// Refuse known default secrets in every environment (including development).
// The guard must not be conditional on NODE_ENV; otherwise docker-compose
// defaults make it inert and every `docker compose up` would run with
// forgeable secrets with zero warnings.
const KNOWN_DEFAULT_SECRETS = new Set([
  'change-me-to-a-long-random-string',
  'ChangeMe123!',
  'atlas-internal-jwt-secret-change-me',
  'atlas-mfa-stepup-secret-change-me',
  'change-me-to-a-long-random-string-for-mfa-stepup',
  'change-me-to-a-long-random-string-for-oauth-encryption',
  'change-scim-api-key-in-production',
  'change-me-to-slack-signing-secret',
  'change-me-to-long-random-secret',
]);
const KNOWN_DEFAULT_URLS = new Set([
  'https://idp.example.com/sso',
  'https://idp.example.com/metadata',
  'https://dev-000000.okta.com',
]);
if (
  KNOWN_DEFAULT_SECRETS.has(JWT_SECRET) ||
  KNOWN_DEFAULT_SECRETS.has(ADMIN_DEFAULT_PASSWORD) ||
  (INTERNAL_JWT_SECRET && KNOWN_DEFAULT_SECRETS.has(INTERNAL_JWT_SECRET)) ||
  (SCIM_API_KEY && KNOWN_DEFAULT_SECRETS.has(SCIM_API_KEY)) ||
  (process.env.MFA_STEPUP_SECRET && KNOWN_DEFAULT_SECRETS.has(process.env.MFA_STEPUP_SECRET)) ||
  (process.env.MFA_JWT_SECRET && KNOWN_DEFAULT_SECRETS.has(process.env.MFA_JWT_SECRET)) ||
  (process.env.OAUTH_ENCRYPTION_KEY && KNOWN_DEFAULT_SECRETS.has(process.env.OAUTH_ENCRYPTION_KEY)) ||
  KNOWN_DEFAULT_URLS.has(process.env.SAML_IDP_SSO_URL || '') ||
  KNOWN_DEFAULT_URLS.has(process.env.SAML_IDP_ENTITY_ID || '')
) {
  console.error('FATAL: refusing to start with known default secrets/URLs (JWT_SECRET / ADMIN_DEFAULT_PASSWORD / INTERNAL_JWT_SECRET / SCIM_API_KEY / MFA_STEPUP_SECRET / OAUTH_ENCRYPTION_KEY / SAML_IDP_*); set strong values via .env');
  process.exit(1);
}
if (JWT_SECRET === 'change-me-to-a-long-random-string' || ADMIN_DEFAULT_PASSWORD === 'ChangeMe123!') {
  console.error('FATAL: refusing to start with known default secrets (JWT_SECRET / ADMIN_DEFAULT_PASSWORD); set strong values via .env');
  process.exit(1);
}

const jwtSecret = JWT_SECRET;

const MFA_STEPUP_SECRET = process.env.MFA_STEPUP_SECRET || process.env.MFA_JWT_SECRET;
if (!MFA_STEPUP_SECRET) {
  console.error('FATAL: MFA_STEPUP_SECRET environment variable is required (no fallback to JWT_SECRET)');
  process.exit(1);
}
if (MFA_STEPUP_SECRET === JWT_SECRET) {
  console.error('FATAL: MFA_STEPUP_SECRET must be distinct from JWT_SECRET');
  process.exit(1);
}
const MFA_STEPUP_AUD = 'mfa-step-up';
const MFA_STEPUP_ISS = 'atlas-auth';

const MFA_CHALLENGE_AUD = 'mfa-challenge';
const MFA_CHALLENGE_ISS = 'atlas-auth';

// OAuth at-rest encryption for sensitive provider secrets and tokens.
// OAUTH_ENCRYPTION_KEY is required and must be distinct from JWT_SECRET;
// falling back to the session secret would couple token encryption to
// session signing and defeat key separation.
const OAUTH_ENCRYPTION_KEY_RAW = process.env.OAUTH_ENCRYPTION_KEY;
if (!OAUTH_ENCRYPTION_KEY_RAW) {
  console.error('FATAL: OAUTH_ENCRYPTION_KEY environment variable is required (no fallback to JWT_SECRET)');
  process.exit(1);
}
if (OAUTH_ENCRYPTION_KEY_RAW === JWT_SECRET) {
  console.error('FATAL: OAUTH_ENCRYPTION_KEY must be distinct from JWT_SECRET');
  process.exit(1);
}

function getOAuthEncryptionKey() {
  return crypto.createHash('sha256').update(OAUTH_ENCRYPTION_KEY_RAW).digest();
}

function encryptOAuthSecret(plaintext) {
  if (!plaintext) return plaintext;
  const key = getOAuthEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptOAuthSecret(ciphertextB64) {
  if (!ciphertextB64) return ciphertextB64;
  try {
    const key = getOAuthEncryptionKey();
    const data = Buffer.from(ciphertextB64, 'base64');
    if (data.length < 28) return ciphertextB64;
    const iv = data.subarray(0, 12);
    const tag = data.subarray(12, 28);
    const encrypted = data.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  } catch {
    return ciphertextB64;
  }
}

function isEncryptedOAuthSecret(value) {
  if (!value || typeof value !== 'string') return false;
  if (value.length < 40) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  try {
    const data = Buffer.from(value, 'base64');
    return data.length >= 28;
  } catch {
    return false;
  }
}

// Build an Okta base URL from tenant-configured provider data. The subdomain
// is strictly validated so attacker-controlled provider config cannot smuggle
// an arbitrary host into authorize/token/userinfo URLs (e.g. a client_id of
// "evil.com/.okta.com" must not produce "https://evil.okta.com...").
// Fail closed: unknown shapes return null and callers must reject instead of
// falling back to a placeholder IdP.
function resolveOktaBaseUrl(clientId) {
  const match = String(clientId || '').match(/^([a-zA-Z0-9-]{1,63})\.okta\.com$/);
  if (match) {
    return `https://${match[1]}.okta.com`;
  }
  return null;
}

// Exact issuer matching: a prefix/substring test would accept
// "https://accounts.google.com.evil.com" and "https://evil.com/?x=.okta.com".
function issuerMatchesProvider(iss, provider) {
  if (!iss || typeof iss !== 'string') return false;
  // Google historically issues both the bare host and the https URL.
  if (provider === 'google' && iss === 'accounts.google.com') return true;
  let parsed;
  try {
    parsed = new URL(iss);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  switch (provider) {
    case 'google':
      return host === 'accounts.google.com' || host === 'oauth2.googleapis.com';
    case 'microsoft':
      return host === 'login.microsoftonline.com';
    case 'okta':
      // Hostname-suffix check on the parsed URL: a substring test would accept
      // "https://evil.com/?x=.okta.com" as a genuine Okta issuer.
      return host.endsWith('.okta.com');
    default:
      return false;
  }
}

// Claim-level id_token validation. Fail closed on missing expiry/audience:
// an attacker-supplied token must not pass by simply omitting claims. When a
// nonce was sent in the authorize request, the token must echo it.
function validateOAuthIdToken(idToken, provider, expectedClientId, expectedEmail, options = {}) {
  const expectedNonce = options.nonce || null;
  const now = options.now || Date.now();
  if (!idToken) {
    // An id_token is mandatory whenever a nonce was sent (every OIDC
    // provider); GitHub's plain OAuth2 flow has neither.
    if (expectedNonce) return { valid: false, reason: 'id_token required because a nonce was sent' };
    return { valid: true, skipped: true };
  }
  if (provider === 'github') {
    return { valid: false, reason: 'GitHub OAuth2 does not issue id_token' };
  }
  let payload;
  try {
    payload = jwt.decode(idToken);
    if (!payload || typeof payload !== 'object') {
      return { valid: false, reason: 'invalid id_token structure' };
    }
  } catch {
    return { valid: false, reason: 'id_token decode failed' };
  }
  if (typeof payload.exp !== 'number') return { valid: false, reason: 'id_token missing exp claim' };
  if (now >= payload.exp * 1000) {
    return { valid: false, reason: 'id_token expired' };
  }
  if (payload.nbf !== undefined) {
    if (typeof payload.nbf !== 'number') return { valid: false, reason: 'id_token malformed nbf claim' };
    if (now < payload.nbf * 1000) {
      return { valid: false, reason: 'id_token not yet valid' };
    }
  }
  if (!issuerMatchesProvider(payload.iss, provider)) {
    return { valid: false, reason: 'issuer mismatch: ' + String(payload.iss || '') };
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : (payload.aud === undefined ? [] : [payload.aud]);
  if (audiences.length === 0) return { valid: false, reason: 'id_token missing aud claim' };
  if (!audiences.some((aud) => aud === expectedClientId)) {
    return { valid: false, reason: 'audience mismatch' };
  }
  if (payload.azp !== undefined && payload.azp !== expectedClientId) {
    return { valid: false, reason: 'authorized party mismatch' };
  }
  if (expectedNonce) {
    if (payload.nonce === undefined) return { valid: false, reason: 'id_token missing nonce claim' };
    if (payload.nonce !== expectedNonce) return { valid: false, reason: 'nonce mismatch' };
  }
  if (payload.email && expectedEmail && String(payload.email).toLowerCase() !== String(expectedEmail).toLowerCase()) {
    return { valid: false, reason: 'email mismatch between id_token and userinfo' };
  }
  if (payload.email_verified !== undefined) {
    const ev = payload.email_verified;
    if (ev !== true && ev !== 'true') {
      return { valid: false, reason: 'email_verified false in id_token' };
    }
  }
  return { valid: true };
}

// ---- OIDC discovery and JWKS verification (fail closed) ----

// Refresh interval for cached discovery documents and JWKS bundles. A
// provider Cache-Control max-age overrides this inside sane bounds; before it
// expires a rotated key is picked up by the unknown-kid refetch in
// verifyOAuthIdTokenSignature, so no restart or cache flush is needed.
const OIDC_DISCOVERY_DEFAULT_TTL_MS = 60 * 60 * 1000;
const OIDC_DISCOVERY_MIN_TTL_MS = 60 * 1000;
const OIDC_DISCOVERY_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const OIDC_HTTP_TIMEOUT_MS = 5000;
const OIDC_SIGNING_ALGORITHMS = ['RS256', 'RS384', 'RS512'];

// Built-in OIDC providers resolve endpoints from their discovery document;
// GitHub is plain OAuth2 with no discovery. A generic per-tenant OIDC
// provider (issuer configured per tenant) is slice two of this issue.
const OIDC_DISCOVERY_URLS = {
  google: 'https://accounts.google.com/.well-known/openid-configuration',
  microsoft: 'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
};

function oidcDiscoveryUrlFor(provider, oktaBase) {
  if (provider === 'okta') {
    return oktaBase ? `${oktaBase}/.well-known/openid-configuration` : null;
  }
  return OIDC_DISCOVERY_URLS[provider] || null;
}

function computeCacheTtlMs(cacheControlHeader, now = Date.now()) {
  const match = String(cacheControlHeader || '').match(/max-age\s*=\s*(\d+)/i);
  if (!match) return OIDC_DISCOVERY_DEFAULT_TTL_MS;
  const seconds = parseInt(match[1], 10);
  if (!Number.isFinite(seconds)) return OIDC_DISCOVERY_DEFAULT_TTL_MS;
  return Math.min(Math.max(seconds * 1000, OIDC_DISCOVERY_MIN_TTL_MS), OIDC_DISCOVERY_MAX_TTL_MS);
}

async function defaultOidcFetchJson(url) {
  const response = await axios.get(url, { timeout: OIDC_HTTP_TIMEOUT_MS, headers: { Accept: 'application/json' } });
  return { data: response.data, headers: response.headers || {} };
}

const oidcDiscoveryCache = new Map();
const oidcJwksCache = new Map();

async function fetchDiscoveryDocument(url, options = {}) {
  const fetchJson = options.fetchJson || defaultOidcFetchJson;
  const cache = options.cache || oidcDiscoveryCache;
  const now = options.now || Date.now();
  const cached = cache.get(url);
  if (!options.force && cached && cached.expiresAt > now) return cached.document;
  const response = await fetchJson(url);
  const document = response && response.data;
  if (!document || typeof document !== 'object' || typeof document.jwks_uri !== 'string' || !document.jwks_uri) {
    throw new Error('OIDC discovery document is missing jwks_uri');
  }
  const expiresAt = now + computeCacheTtlMs(response.headers && response.headers['cache-control'], now);
  cache.set(url, { document, fetchedAt: now, expiresAt });
  return document;
}

function jwkToPem(jwk) {
  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) throw new Error('unsupported JWK');
  return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' })
    .export({ type: 'spki', format: 'pem' });
}

// Map kid -> PEM. Keys must be RSA and carry a kid: rotation matching is by
// kid, and a key without one can never be selected deterministically.
function normalizeJwksBundle(document) {
  const keys = new Map();
  const list = document && Array.isArray(document.keys) ? document.keys : [];
  for (const jwk of list) {
    if (!jwk || jwk.kty !== 'RSA' || !jwk.kid) continue;
    if (jwk.use && jwk.use !== 'sig') continue;
    try {
      keys.set(String(jwk.kid), jwkToPem(jwk));
    } catch { /* skip malformed key material */ }
  }
  return keys;
}

function verifyIdTokenSignature(idToken, jwks, options = {}) {
  let header = null;
  try {
    const decoded = jwt.decode(idToken, { complete: true });
    header = decoded && decoded.header;
  } catch {
    header = null;
  }
  if (!header) return { valid: false, reason: 'id_token header decode failed' };
  if (!OIDC_SIGNING_ALGORITHMS.includes(header.alg)) {
    return { valid: false, reason: 'unsupported id_token signature algorithm' };
  }
  if (!header.kid) return { valid: false, reason: 'id_token missing kid header' };
  const keys = jwks instanceof Map ? jwks : normalizeJwksBundle(jwks);
  const pem = keys.get(String(header.kid));
  if (!pem) return { valid: false, reason: 'signing key not found for kid', unknownKey: true };
  try {
    jwt.verify(idToken, pem, { algorithms: [header.alg], clockTolerance: 30 });
  } catch {
    return { valid: false, reason: 'id_token signature verification failed' };
  }
  return { valid: true };
}

async function getSigningKeys(jwksUri, options = {}) {
  const fetchJson = options.fetchJson || defaultOidcFetchJson;
  const cache = options.cache || oidcJwksCache;
  const now = options.now || Date.now();
  const cached = cache.get(jwksUri);
  if (!options.force && cached && cached.expiresAt > now) return cached.keys;
  const response = await fetchJson(jwksUri);
  const keys = normalizeJwksBundle(response && response.data);
  if (keys.size === 0) throw new Error('JWKS contains no usable RSA signing keys');
  const expiresAt = now + computeCacheTtlMs(response.headers && response.headers['cache-control'], now);
  cache.set(jwksUri, { keys, fetchedAt: now, expiresAt });
  return keys;
}

// Verify an id_token signature against the provider's JWKS. When the kid is
// unknown (key rotation between cache refreshes) the bundle is fetched once
// more before failing, so a rotation does not lock users out.
async function verifyOAuthIdTokenSignature(idToken, jwksUri, options = {}) {
  let keys = await getSigningKeys(jwksUri, options);
  let result = verifyIdTokenSignature(idToken, keys, options);
  if (!result.valid && result.unknownKey) {
    keys = await getSigningKeys(jwksUri, { ...options, force: true });
    result = verifyIdTokenSignature(idToken, keys, options);
  }
  return result;
}

// Full id_token verification used by the callback: claim checks (expiry,
// exact issuer, audience, nonce, email) first, then signature against the
// discovery document's JWKS. Anything that cannot be verified - discovery
// unreachable, malformed document, unknown key - fails closed.
async function verifyOAuthIdToken(idToken, provider, providerConfig, expectedEmail, options = {}) {
  const payloadCheck = validateOAuthIdToken(idToken, provider, providerConfig.client_id, expectedEmail, {
    nonce: options.nonce || null,
    now: options.now,
  });
  if (!payloadCheck.valid) return payloadCheck;
  if (payloadCheck.skipped) return payloadCheck;
  const oktaBase = provider === 'okta' ? resolveOktaBaseUrl(providerConfig.client_id) : null;
  const discoveryUrl = oidcDiscoveryUrlFor(provider, oktaBase);
  if (!discoveryUrl) return { valid: false, reason: 'no discovery document configured for provider' };
  try {
    const document = await fetchDiscoveryDocument(discoveryUrl, options);
    const signatureCheck = await verifyOAuthIdTokenSignature(idToken, document.jwks_uri, options);
    if (!signatureCheck.valid) return signatureCheck;
    return { valid: true, jwks_uri: document.jwks_uri };
  } catch (err) {
    safeLog(console.error, `OIDC discovery/JWKS verification failed for ${provider} (failing closed):`, err);
    return { valid: false, reason: 'id_token signature could not be verified against provider JWKS' };
  }
}

if (!process.env.POSTGRES_URL) {
  console.error('FATAL: POSTGRES_URL environment variable is required');
  process.exit(1);
}

const sslConfig = process.env.POSTGRES_SSL === 'false'
  ? false
  : { rejectUnauthorized: true };

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: sslConfig,
});

const REDIS_URL = process.env.REDIS_URL;
if (!REDIS_URL) {
  console.error('FATAL: REDIS_URL environment variable is required');
  process.exit(1);
}
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.log('Auth Redis Client Error', err));
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    safeLog(console.error, 'Auth Redis connection failed, nonce check disabled:', err);
  }
})();

// Fail-closed policy for auth-store (Redis) reads and writes: when the store
// is unavailable the caller must refuse the operation instead of skipping the
// check, because skipping silently disables revocation or replay protection.
// The client is a parameter so the policy is testable with fake stores.
function authStoreUnavailable(res, check) {
  redisDegradedTotal.labels({ check }).inc();
  safeLog(console.error, `Auth store unavailable (${check}): refusing request`);
  return res.status(503).json({
    code: 'auth_store_unavailable',
    retryable: true,
    message: 'Authentication temporarily unavailable, please retry shortly'
  });
}

async function storeMfaChallengeJti(redis, jti, userId) {
  if (!redis || !redis.isOpen) return false;
  try {
    await redis.set(`mfa_challenge:${jti}`, String(userId), { EX: 300, NX: true });
    return true;
  } catch (err) {
    safeLog(console.error, 'Failed to store MFA challenge jti', err);
    return false;
  }
}

// Returns true when the jti is present, false when it was consumed or expired,
// and null when the store cannot answer (caller must refuse the request).
async function mfaChallengeJtiExists(redis, jti) {
  if (!redis || !redis.isOpen) return null;
  try {
    const exists = await redis.get(`mfa_challenge:${jti}`);
    return Boolean(exists);
  } catch (err) {
    safeLog(console.error, 'Failed to check MFA challenge jti', err);
    return null;
  }
}

async function consumeMfaChallengeJti(redis, jti) {
  if (!redis || !redis.isOpen) return false;
  try {
    await redis.del(`mfa_challenge:${jti}`);
    return true;
  } catch (err) {
    safeLog(console.error, 'Failed to consume MFA challenge jti', err);
    return false;
  }
}

// Resolve the real client IP. The gateway passes it in x-real-client-ip;
// we never trust X-Forwarded-For because clients can spoof it.
function getClientIp(req) {
  const forwarded = req.headers['x-real-client-ip'];
  if (forwarded && typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.trim().split(',')[0].trim();
  }
  return req.ip;
}

const BCRYPT_COST = 12;

function sanitizeForLogs(obj) {
  const sensitiveKeys = new Set(['password', 'token', 'secret', 'authorization', 'cookie', 'mfa_secret', 'backup_codes', 'client_secret', 'access_token', 'refresh_token']);
  if (!obj || typeof obj !== 'object') return obj;
  const sanitized = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const [key, value] of Object.entries(sanitized)) {
    if (sensitiveKeys.has(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = sanitizeForLogs(value);
    }
  }
  return sanitized;
}

function safeLog(logFn, msg, data) {
  if (data) {
    logFn(msg, sanitizeForLogs(data));
  } else {
    logFn(msg);
  }
}

// ---- Per-tenant password policy ----

// The hard floor is compiled in and can never be configured away: a tenant
// may tighten its policy above it, never below it.
const PASSWORD_HARD_FLOOR = 8;
const PASSWORD_MIN_LENGTH_CAP = 128;
const PASSWORD_HISTORY_MAX_RETENTION = 24;
const PASSWORD_MAX_AGE_DAYS_CAP = 730;

// Pinned embedded denylist of very common passwords. This is a best-effort
// stop for the obvious cases (exact entry or entry plus trailing digits or
// punctuation), not a substitute for a breached-password service; the list
// version is returned by the policy API and recorded in error messages so a
// future list update is auditable.
const COMMON_PASSWORD_LIST_VERSION = '2026.10';
const COMMON_PASSWORDS = new Set([
  '1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890',
  '111111', '000000', '1q2w3e4r', 'qazwsx', 'asdfghjkl', 'zaq12wsx', 'qwerty',
  'qwerty1', 'qwerty12', 'qwerty123', 'abc123', 'abcd1234', '1234abcd',
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssw0rd', 'p@ssword', 'letmein', 'letmein1', 'welcome',
  'welcome1', 'welcome123', 'admin', 'admin1', 'admin123', 'administrator',
  'root', 'toor', 'guest', 'changeme', 'changeit', 'secret', 'secret1',
  'secret123', 'default', 'iloveyou', 'monkey', 'monkey1', 'dragon', 'dragon1',
  'football', 'baseball', 'basketball', 'soccer', 'sunshine', 'princess',
  'superman', 'batman', 'starwars', 'trustno1', 'master', 'shadow', 'michael',
  'jennifer', 'jessica', 'michelle', 'mustang', 'access', 'flower',
  'whatever', 'computer', 'charlie', 'daniel', 'thomas', 'hunter', 'harley',
  'ranger', 'buster', 'test123', 'test1234',
]);

// Secure defaults that reproduce the pre-policy behavior: 8 characters (the
// hard floor), uppercase and a digit required, lowercase/symbol optional,
// no expiry and no history requirement. Tenants opt up from here.
const DEFAULT_PASSWORD_POLICY = Object.freeze({
  min_length: PASSWORD_HARD_FLOOR,
  require_upper: true,
  require_lower: false,
  require_digit: true,
  require_symbol: false,
  history_count: 0,
  max_age_days: null,
});

function isCommonPassword(password) {
  if (!password || typeof password !== 'string') return false;
  const candidate = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(candidate)) return true;
  // Also reject a listed base word with trailing digits/punctuation appended,
  // e.g. "qwerty" -> "qwerty2026!" - the cheapest way of "changing" a password.
  const stripped = candidate.replace(/[0-9!@#$%^&*._\-]+$/, '');
  return stripped.length >= 6 && COMMON_PASSWORDS.has(stripped);
}

// Normalize a stored policy row (or an untrusted value) into a valid policy.
// Defense in depth: even if a row somehow holds an out-of-range value, the
// effective policy is clamped back inside the compiled bounds.
function clampPasswordPolicy(raw) {
  const policy = { ...DEFAULT_PASSWORD_POLICY };
  if (!raw || typeof raw !== 'object') return policy;
  const toInt = (value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return parseInt(value, 10);
    return null;
  };
  const minLength = toInt(raw.min_length);
  if (minLength !== null) {
    policy.min_length = Math.min(Math.max(minLength, PASSWORD_HARD_FLOOR), PASSWORD_MIN_LENGTH_CAP);
  }
  for (const key of ['require_upper', 'require_lower', 'require_digit', 'require_symbol']) {
    if (typeof raw[key] === 'boolean') policy[key] = raw[key];
  }
  const historyCount = toInt(raw.history_count);
  if (historyCount !== null) {
    policy.history_count = Math.min(Math.max(historyCount, 0), PASSWORD_HISTORY_MAX_RETENTION);
  }
  if (raw.max_age_days === null) {
    policy.max_age_days = null;
  } else {
    const maxAgeDays = toInt(raw.max_age_days);
    if (maxAgeDays !== null) {
      policy.max_age_days = maxAgeDays <= 0 ? null : Math.min(maxAgeDays, PASSWORD_MAX_AGE_DAYS_CAP);
    }
  }
  return policy;
}

// Strict input validation for the admin policy API. Unlike clampPasswordPolicy
// this reports bad input instead of silently coercing it.
function validatePasswordPolicyInput(body) {
  const errors = {};
  const isInt = (value) => typeof value === 'number' && Number.isInteger(value);
  if ('min_length' in body && (!isInt(body.min_length) || body.min_length < PASSWORD_HARD_FLOOR || body.min_length > PASSWORD_MIN_LENGTH_CAP)) {
    errors.min_length = `min_length must be an integer between ${PASSWORD_HARD_FLOOR} and ${PASSWORD_MIN_LENGTH_CAP}`;
  }
  for (const key of ['require_upper', 'require_lower', 'require_digit', 'require_symbol']) {
    if (key in body && typeof body[key] !== 'boolean') {
      errors[key] = `${key} must be a boolean`;
    }
  }
  if ('history_count' in body && (!isInt(body.history_count) || body.history_count < 0 || body.history_count > PASSWORD_HISTORY_MAX_RETENTION)) {
    errors.history_count = `history_count must be an integer between 0 and ${PASSWORD_HISTORY_MAX_RETENTION}`;
  }
  if ('max_age_days' in body && body.max_age_days !== null
      && (!isInt(body.max_age_days) || body.max_age_days < 0 || body.max_age_days > PASSWORD_MAX_AGE_DAYS_CAP)) {
    errors.max_age_days = `max_age_days must be null (disabled) or an integer between 1 and ${PASSWORD_MAX_AGE_DAYS_CAP}`;
  }
  return Object.keys(errors).length ? errors : null;
}

function validatePassword(password, policy) {
  const effective = clampPasswordPolicy(policy || DEFAULT_PASSWORD_POLICY);
  if (!password || password.length < effective.min_length) {
    return `Password must be at least ${effective.min_length} characters`;
  }
  if (effective.require_upper && !/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (effective.require_lower && !/[a-z]/.test(password)) {
    return 'Password must contain at least one lowercase letter';
  }
  if (effective.require_digit && !/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  if (effective.require_symbol && !/[^A-Za-z0-9]/.test(password)) {
    return 'Password must contain at least one symbol';
  }
  if (isCommonPassword(password)) {
    return `Password is too common; choose a different password (denylist ${COMMON_PASSWORD_LIST_VERSION})`;
  }
  return null;
}

// Days-until-expiry status for a password change. Expiry is advisory: an
// expired password still logs in and the client is prompted to rotate, which
// is what existing tenants expect (no behavior change until max_age_days is
// configured above the default of null).
function passwordExpiryStatus(passwordChangedAt, maxAgeDays, now = Date.now()) {
  const disabled = { max_age_days: null, expires_at: null, expired: false, days_until_expiry: null };
  if (!maxAgeDays || !passwordChangedAt) return disabled;
  const changedAtMs = new Date(passwordChangedAt).getTime();
  if (Number.isNaN(changedAtMs)) return disabled;
  const expiresAtMs = changedAtMs + maxAgeDays * 24 * 60 * 60 * 1000;
  return {
    max_age_days: maxAgeDays,
    expires_at: new Date(expiresAtMs).toISOString(),
    expired: now >= expiresAtMs,
    days_until_expiry: Math.max(0, Math.ceil((expiresAtMs - now) / (24 * 60 * 60 * 1000))),
  };
}

async function getPasswordPolicyForTenant(tenantId) {
  const tid = String(tenantId || 'default').trim() || 'default';
  try {
    const result = await pool.query('SELECT * FROM password_policies WHERE tenant_id = $1', [tid]);
    if (result.rows[0]) return clampPasswordPolicy(result.rows[0]);
  } catch (err) {
    // Fall back to the compiled defaults (never below the hard floor) rather
    // than blocking every credential change on a policy read.
    safeLog(console.error, 'Failed to load password policy; using secure defaults:', err);
  }
  return { ...DEFAULT_PASSWORD_POLICY };
}

async function isPasswordReused(password, passwordHashes) {
  for (const hash of passwordHashes) {
    if (hash && await bcrypt.compare(password, hash)) return true;
  }
  return false;
}

// Reject a password found among the user's last N stored hashes. Returns an
// error message or null; a DB failure propagates so the caller fails closed.
async function enforcePasswordHistory(userId, newPassword, historyCount) {
  const limit = Math.min(Math.max(Number(historyCount) || 0, 0), PASSWORD_HISTORY_MAX_RETENTION);
  if (!limit) return null;
  const result = await pool.query(
    'SELECT password_hash FROM password_history WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2',
    [userId, limit]
  );
  if (await isPasswordReused(newPassword, result.rows.map((row) => row.password_hash))) {
    return `Password was used recently; choose a password you have not used in your last ${limit} changes`;
  }
  return null;
}

// Record a new hash and trim the row set to the retention cap. History is
// bookkeeping for reuse checks: failures are logged, not fatal, because the
// password change itself already succeeded.
async function recordPasswordHistory(userId, passwordHash) {
  try {
    await pool.query('INSERT INTO password_history (user_id, password_hash) VALUES ($1, $2)', [userId, passwordHash]);
    await pool.query(
      `DELETE FROM password_history
       WHERE user_id = $1 AND id NOT IN (
         SELECT id FROM password_history WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2
       )`,
      [userId, PASSWORD_HISTORY_MAX_RETENTION]
    );
  } catch (err) {
    safeLog(console.error, 'Failed to record password history:', err);
  }
}

async function setUserPassword(userId, plaintextPassword) {
  const hashedPassword = await bcrypt.hash(plaintextPassword, BCRYPT_COST);
  await pool.query(
    'UPDATE users SET password = $1, password_changed_at = NOW(), updated_at = NOW() WHERE id = $2',
    [hashedPassword, userId]
  );
  await recordPasswordHistory(userId, hashedPassword);
  return hashedPassword;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function validateEmail(email) {
  if (!email || typeof email !== 'string') {
    return 'Email is required';
  }
  const normalized = normalizeEmail(email);
  if (normalized.length > 254) {
    return 'Email is too long';
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return 'Email format is invalid';
  }
  return null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user, sessionId) {
  const jti = uuidv4();
  const payload = { id: user.id, email: user.email, role: user.role, tenant_id: user.tenant_id || 'default', jti };
  if (sessionId) payload.sid = String(sessionId);
  return jwt.sign(payload, jwtSecret, { algorithm: 'HS256', expiresIn: ACCESS_EXPIRY });
}

function signMfaToken(user) {
  const userId = typeof user === 'object' ? (user.id ?? user.user_id ?? user.sub) : user;
  const tenantId = typeof user === 'object' ? (user.tenant_id ?? user.tenantId ?? 'default') : 'default';
  const jti = uuidv4();
  return jwt.sign(
    {
      sub: String(userId),
      user_id: String(userId),
      id: String(userId),
      tenant_id: String(tenantId),
      mfa_validated: true,
      purpose: 'mfa_step_up',
      aud: MFA_STEPUP_AUD,
      iss: MFA_STEPUP_ISS,
      jti,
    },
    MFA_STEPUP_SECRET,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

function signMfaChallengeToken(user) {
  const userId = typeof user === 'object' ? (user.id ?? user.user_id ?? user.sub) : user;
  const tenantId = typeof user === 'object' ? (user.tenant_id ?? user.tenantId ?? 'default') : 'default';
  const email = typeof user === 'object' ? (user.email ?? '') : '';
  const jti = uuidv4();
  // Challenge token is short-lived (5m), single-use via Redis, and must not be usable as a session token.
  // It is signed with the main JWT secret but carries purpose=mfa_challenge and aud=mfa-challenge so
  // session verification can reject it. Verification in /mfa/validate checks purpose/audience and jti single-use.
  return jwt.sign(
    {
      sub: String(userId),
      user_id: String(userId),
      id: String(userId),
      tenant_id: String(tenantId),
      email: String(email),
      purpose: 'mfa_challenge',
      aud: MFA_CHALLENGE_AUD,
      iss: MFA_CHALLENGE_ISS,
      jti,
    },
    jwtSecret,
    { algorithm: 'HS256', expiresIn: '5m' }
  );
}

async function createRefreshToken(userId, db = pool) {
  const token = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_EXPIRY_DAYS);

  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );

  return token;
}

async function revokeAllUserSessions(userId, db = pool) {
  await db.query('UPDATE sessions SET is_active = false WHERE user_id = $1', [userId]);
  await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}

// A refresh token that is no longer live but still sits in rotated_tokens was
// presented after it had been rotated: treat it as stolen and revoke every
// session of its owner. The DELETE ... RETURNING claims the record, so two
// replays racing each other trigger the revocation once.
async function revokeOnRotatedTokenReuse(db, tokenHash) {
  const rotated = await db.query(
    'DELETE FROM rotated_tokens WHERE token_hash = $1 RETURNING user_id',
    [tokenHash]
  );
  if (!rotated.rows[0]) return null;
  const userId = rotated.rows[0].user_id;
  await revokeAllUserSessions(userId, db);
  return userId;
}

// Rotate a refresh token. The old token is claimed with a single
// DELETE ... RETURNING, so of two requests presenting the same token only one
// gets the row back; the other blocks on the row lock until the winner
// commits, sees zero rows, and is handled as reuse. The rotated_tokens record,
// the replacement token and the session update commit in the same
// transaction, so the loser always finds the rotation it lost to.
async function rotateRefreshToken(db, refreshToken) {
  const oldTokenHash = hashToken(refreshToken);
  const client = await db.connect();
  let result = null;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      'DELETE FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW() RETURNING user_id',
      [oldTokenHash]
    );
    const userId = claimed.rows[0]?.user_id;
    if (userId !== undefined) {
      const sessRes = await client.query(
        'SELECT id, is_active FROM sessions WHERE token_hash = $1 AND user_id = $2 FOR UPDATE',
        [oldTokenHash, userId]
      );
      const session = sessRes.rows[0];
      const userRes = await client.query(
        'SELECT id, email, name, role, department, position, tenant_id FROM users WHERE id = $1',
        [userId]
      );
      const user = userRes.rows[0];
      if (user && !(session && session.is_active === false)) {
        await client.query(
          'INSERT INTO rotated_tokens (token_hash, user_id) VALUES ($1, $2)',
          [oldTokenHash, userId]
        );
        const newRefreshToken = await createRefreshToken(userId, client);
        if (session) {
          await client.query('UPDATE sessions SET token_hash = $1 WHERE id = $2', [hashToken(newRefreshToken), session.id]);
        }
        result = { status: 'ok', user, sessionId: session?.id || null, newRefreshToken };
      }
    }
    // Anything short of a full rotation leaves the stored token untouched.
    await client.query(result ? 'COMMIT' : 'ROLLBACK');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (result) {
    await db.query("DELETE FROM rotated_tokens WHERE created_at < NOW() - INTERVAL '1 hour'");
    return result;
  }
  const reusedBy = await revokeOnRotatedTokenReuse(db, oldTokenHash);
  return reusedBy === null ? { status: 'invalid' } : { status: 'reused', userId: reusedBy };
}

// Revoke the refresh token presented at logout and deactivate its session.
// Claimed the same way as rotateRefreshToken, so a logout racing a refresh
// cannot miss the session: if the refresh won, the token is found in
// rotated_tokens and handled as reuse, which revokes every session.
async function revokeRefreshTokenForLogout(db, refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const client = await db.connect();
  let userId;
  try {
    await client.query('BEGIN');
    const claimed = await client.query(
      'DELETE FROM refresh_tokens WHERE token_hash = $1 RETURNING user_id',
      [tokenHash]
    );
    userId = claimed.rows[0]?.user_id;
    if (userId !== undefined) {
      await client.query(
        'UPDATE sessions SET is_active = false WHERE token_hash = $1 AND user_id = $2',
        [tokenHash, userId]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  if (userId !== undefined) return { status: 'revoked', userId };
  const reusedBy = await revokeOnRotatedTokenReuse(db, tokenHash);
  return reusedBy === null ? { status: 'none' } : { status: 'reused', userId: reusedBy };
}

function normalizeFailedAttemptEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 255);
}
async function issueLoginSession(user, req, res) {
  const sessionId = uuidv4();
  const accessToken = signAccessToken(user, sessionId);
  const refreshToken = await createRefreshToken(user.id);
  const deviceId = req.headers?.['x-device-id'] || null;
  await pool.query(
    `INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, device_id, is_active, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
    [sessionId, user.id, hashToken(refreshToken), req.ip, req.headers?.['user-agent'] || '', deviceId,
     new Date(Date.now() + REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000)]
  );
  res.cookie('refreshToken', refreshToken, {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
  });
  mintCsrfCookie(res);
  return { sessionId, accessToken, refreshToken };
}

async function recordFailedAttempt(email) {
  const key = normalizeFailedAttemptEmail(email);
  if (!key) return;
  const lockedUntil = new Date();
  lockedUntil.setMinutes(lockedUntil.getMinutes() + LOCKOUT_MINUTES);

  await pool.query(
    `INSERT INTO failed_attempts (email, attempts, locked_until, updated_at)
     VALUES ($1, 1, NULL, NOW())
     ON CONFLICT (email) DO UPDATE SET
       attempts = failed_attempts.attempts + 1,
       locked_until = CASE
         WHEN failed_attempts.attempts + 1 >= $2 THEN $3
         ELSE failed_attempts.locked_until
       END,
       updated_at = NOW()`,
    [key, MAX_FAILED_ATTEMPTS, lockedUntil]
  );
}

async function clearFailedAttempts(email) {
  const key = normalizeFailedAttemptEmail(email);
  if (!key) return;
  await pool.query('DELETE FROM failed_attempts WHERE email = $1', [key]);
}

async function isAccountLocked(email) {
  const key = normalizeFailedAttemptEmail(email);
  if (!key) return false;
  const result = await pool.query(
    'SELECT attempts, locked_until, updated_at FROM failed_attempts WHERE email = $1',
    [key]
  );
  const row = result.rows[0];
  if (!row) return false;
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    return true;
  }
  if (row.locked_until && new Date(row.locked_until) <= new Date()) {
    await pool.query('DELETE FROM failed_attempts WHERE email = $1', [key]);
    return false;
  }
  if (!row.locked_until && row.updated_at) {
    const ageMs = Date.now() - new Date(row.updated_at).getTime();
    if (ageMs > 60 * 60 * 1000) {
      await pool.query('DELETE FROM failed_attempts WHERE email = $1', [key]);
      return false;
    }
  }
  return false;
}

function sanitizeUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    department: user.department,
    position: user.position,
    tenant_id: user.tenant_id || 'default',
  };
}

function requireRole(...roles) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    try {
      const token = authHeader.slice(7);
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      // Challenge tokens must not be usable as session tokens - they are only for /mfa/validate
      if (payload.purpose === 'mfa_challenge' || payload.aud === MFA_CHALLENGE_AUD) {
        return res.status(401).json({ message: 'MFA challenge token not valid for this endpoint' });
      }
      if (roles.length && !roles.includes(payload.role)) {
        return res.status(403).json({ message: 'Insufficient permissions' });
      }
      req.user = payload;
      next();
    } catch {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
  };
}

async function requireScimAuth(req, res, next) {
  // SCIM provisioning must use a dedicated provisioning credential.
  // Regular user JWTs are rejected here so an employee session can never
  // list or modify users through the SCIM surface.
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
    // Legacy shared keys keep working during the migration window (no flag
    // day): they carry the full SCIM scope for their mapped tenant.
    const tenant = resolveScimTenant(apiKey);
    if (tenant) {
      req.scimTenant = tenant;
      req.scimKeyId = getScimKeyId(apiKey, tenant);
      req.apiKeyScopes = [...API_KEY_SCOPES];
      return next();
    }

    // Scoped API keys: look up by the public key id, then verify the secret
    // against the stored bcrypt hash. State and scope errors are revealed
    // only after the secret matches, so a guessed key id learns nothing.
    const parsed = parseApiKeyFormat(apiKey);
    if (parsed) {
      try {
        const result = await pool.query('SELECT * FROM api_keys WHERE key_id = $1', [parsed.keyId]);
        const keyRow = result.rows[0];
        const secretMatches = keyRow ? await bcrypt.compare(parsed.secret, keyRow.key_hash) : false;
        if (!keyRow || !secretMatches) {
          return res.status(401).json({
            schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
            detail: 'Authentication required',
            status: '401'
          });
        }
        const stateError = apiKeyStateError(keyRow);
        if (stateError) {
          return sendScimError(res, 401, stateError);
        }
        const scopes = normalizeApiKeyScopes(keyRow.scopes);
        const requiredScope = scimScopeForRequest(req.method);
        if (!apiKeyHasScope(scopes, requiredScope)) {
          return sendScimError(res, 403, `API key is missing the required scope: ${requiredScope}`);
        }
        req.scimTenant = keyRow.tenant_id || 'default';
        req.scimKeyId = `apikey:${parsed.keyId}`;
        req.apiKeyScopes = scopes;
        // Usage tracking is fire-and-forget and throttled to at most one
        // write per key per minute so read-heavy syncs stay cheap.
        pool.query(
          `UPDATE api_keys SET last_used_at = NOW()
           WHERE key_id = $1 AND (last_used_at IS NULL OR last_used_at < NOW() - INTERVAL '1 minute')`,
          [parsed.keyId]
        ).catch(() => {});
        return next();
      } catch (err) {
        safeLog(console.error, 'Scoped API key verification failed:', err);
        return sendScimError(res, 503, 'Authentication temporarily unavailable');
      }
    }
  }

  return res.status(401).json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail: 'Authentication required',
    status: '401'
  });
}

const rateLimitStore = new Map();

// Double-submit CSRF protection for cookie-authenticated routes (/refresh,
// /logout), mirroring the api-gateway policy. The rule keys on how the request
// authenticated: header-borne credentials (Authorization: Bearer) are never
// attached automatically by a browser to a cross-site request, so they are
// exempt; cookie-authenticated requests must carry the readable csrf_token
// cookie and echo it in the x-csrf-token header. A missing cookie now fails
// closed. All other state-changing routes use Bearer JWTs, which are immune to
// CSRF. Machine clients authenticate with Bearer (seed script, k6) or carry
// cookie + header.
function requireCsrfDoubleSubmit(req, res, next) {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return next();
  }
  const cookieToken = req.cookies?.csrf_token;
  const headerToken = req.headers['x-csrf-token'];
  if (
    typeof cookieToken === 'string' && cookieToken.length > 0 &&
    typeof headerToken === 'string' && headerToken.length > 0 &&
    headerToken === cookieToken
  ) {
    return next();
  }
  return res.status(403).json({
    message: 'CSRF token validation failed',
    detail: 'This endpoint authenticates with cookies and requires the csrf_token cookie echoed in the x-csrf-token header',
  });
}

function mintCsrfCookie(res) {
  try {
    res.cookie('csrf_token', crypto.randomBytes(32).toString('hex'), {
      httpOnly: false,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });
  } catch {}
}

// Atomic Redis rate-limit check via Lua script: INCR + PEXPIRE on first hit.
// Returns { count, ttl } or null on error.
const RATE_LIMIT_SCRIPT = `
  local current = redis.call('INCR', KEYS[1])
  local ttl
  if current == 1 then
    redis.call('PEXPIRE', KEYS[1], ARGV[1])
    ttl = ARGV[1]
  else
    ttl = redis.call('PTTL', KEYS[1])
  end
  return {current, math.max(ttl, 0)}
`;

async function redisRateLimitCheck(key, windowMs) {
  try {
    const result = await redisClient.eval(RATE_LIMIT_SCRIPT, {
      keys: [`rl:${key}`],
      arguments: [String(windowMs)],
    });
    return { count: result[0], ttl: result[1] };
  } catch (err) {
    return null;
  }
}

function createUserRateLimiter(action, maxRequests = 20, windowMs = 15 * 60 * 1000, options = {}) {
  const { keyByEmail = false } = options;

  return async (req, res, next) => {
    const clientIp = getClientIp(req);
    const identifier = req.user?.id || clientIp;
    const keys = [`${identifier}:${action}`];

    // For credential-stuffing endpoints, also key on email/username so a
    // distributed attack against a single account is caught even when the
    // source IPs differ.
    if (keyByEmail && req.body && req.body.email) {
      const email = String(req.body.email).toLowerCase().trim();
      keys.push(`email:${email}:${action}`);
    }

    const now = Date.now();
    let maxCount = 0;
    let windowStart = now;
    let fromRedis = false;

    // Try Redis first for distributed rate limiting across replicas.
    if (redisClient.isReady) {
      try {
        let allSucceeded = true;
        for (const key of keys) {
          const result = await redisRateLimitCheck(key, windowMs);
          if (result) {
            if (result.count > maxCount) {
              maxCount = result.count;
              windowStart = now - (windowMs - result.ttl);
            }
          } else {
            allSucceeded = false;
            break;
          }
        }
        fromRedis = allSucceeded;
      } catch (err) {
        fromRedis = false;
      }
    }

    // In-process fallback when Redis is unavailable.
    if (!fromRedis) {
      for (const key of keys) {
        let entry = rateLimitStore.get(key);
        if (!entry) {
          entry = { count: 1, startTime: now };
          rateLimitStore.set(key, entry);
        } else {
          if (now - entry.startTime > windowMs) {
            entry.count = 1;
            entry.startTime = now;
          } else {
            entry.count++;
          }
        }
        if (entry.count > maxCount) {
          maxCount = entry.count;
          windowStart = entry.startTime;
        }
      }
    }

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - maxCount));
    res.setHeader('X-RateLimit-Reset', Math.ceil((windowStart + windowMs) / 1000));

    if (maxCount > maxRequests) {
      return res.status(429).json({
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((windowStart + windowMs - now) / 1000)
      });
    }

    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now - entry.startTime > 30 * 60 * 1000) {
      rateLimitStore.delete(key);
    }
  }
}, 60 * 1000);

function mintAuditWriterToken() {
  return jwt.sign(
    {
      sub: 'auth-service',
      service: 'auth-service',
      tenant_id: 'default',
      aud: AUDIT_WRITER_AUDIENCE,
    },
    INTERNAL_JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '60s' }
  );
}
setInterval(async () => {
  try {
    await pool.query("DELETE FROM failed_attempts WHERE locked_until IS NULL AND updated_at < NOW() - INTERVAL '1 hour'");
    await pool.query('DELETE FROM failed_attempts WHERE locked_until IS NOT NULL AND locked_until < NOW()');
    // Keep SAML request ids for an hour past expiry (replay diagnostics), then
    // drop them; their assertions have long expired by that point.
    await pool.query("DELETE FROM saml_authn_requests WHERE expires_at < NOW() - INTERVAL '1 hour'");
  } catch (err) {
    safeLog(console.error, 'Failed to sweep stale rows:', err);
  }
}, 10 * 60 * 1000);

async function sendAuditEvent(eventType, userId, email, details = {}) {
  const payload = {
    event_type: eventType,
    user_id: userId,
    email,
    timestamp: new Date().toISOString(),
    details,
    service: 'auth-service'
  };
  const delaysMs = [0, 300];
  for (let attempt = 0; attempt < delaysMs.length; attempt++) {
    if (delaysMs[attempt]) await new Promise((r) => setTimeout(r, delaysMs[attempt]));
    try {
      await axios.post(`${AUDIT_SERVICE_URL}/api/v1/audit/log`, payload, {
        headers: { 'x-internal-auth': mintAuditWriterToken() },
        timeout: 3000
      });
      return;
    } catch (err) {
      if (attempt === delaysMs.length - 1) {
        try { auditDeliveryFailuresTotal.labels({ event_type: eventType }).inc(); } catch {}
        safeLog(console.error, `Audit log failed for ${eventType}:`, err);
      }
    }
  }
}

function getFrontendUrl() {
  return (process.env.FRONTEND_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '');
}

// Email sender abstraction. No SMTP is configured in this repo, so the
// default implementation is a no-op that logs the message. This keeps the
// password reset flow testable in development without an SMTP server.
// If SMTP settings are provided via env, this function is the single
// place to plug in a real transport.
async function sendEmail({ to, subject, text }) {
  try {
    // Never log message bodies: reset and magic-link emails carry
    // single-use secrets in their URLs. Metadata only.
    console.log(`[email] to=${to} subject=${subject}`);
    return true;
  } catch (err) {
    safeLog(console.error, 'Email send failed:', err);
    return false;
  }
}

async function sendPasswordResetEmail(email, rawToken, resetUrl) {
  const subject = 'Reset your Atlas password';
  const text = `You requested a password reset for your Atlas account.\n\nReset link (valid for 1 hour, single use): ${resetUrl}\n\nIf you did not request this, you can ignore this email.`;
  return sendEmail({ to: email, subject, text });
}

function formatScimUser(user, baseUrl) {
  const nameParts = (user.name || '').split(' ');
  return {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    id: String(user.id),
    userName: user.email,
    name: {
      formatted: user.name || '',
      givenName: nameParts[0] || '',
      familyName: nameParts.slice(1).join(' ') || ''
    },
    emails: [
      {
        value: user.email,
        primary: true,
        type: 'work'
      }
    ],
    roles: [
      {
        value: user.role || 'employee',
        type: 'default'
      }
    ],
    active: user.active !== false,
    meta: {
      resourceType: 'User',
      created: user.created_at || new Date().toISOString(),
      lastModified: user.updated_at || user.created_at || new Date().toISOString(),
      version: `W/"${user.id}"`,
      location: `${baseUrl}/scim/v2/Users/${user.id}`
    }
  };
}

async function sendScimError(res, status, detail) {
  return res.status(status).json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail,
    status: String(status),
    message: detail,
  });
}

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(50) DEFAULT 'employee',
      department VARCHAR(100),
      position VARCHAR(100),
      tenant_id VARCHAR(50) DEFAULT 'default',
      active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const columnsToAdd = [
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();",
    "ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();"
  ];
  for (const sql of columnsToAdd) {
    try { await pool.query(sql); } catch (err) { /* column may exist */ }
  }

  try {
    await pool.query("ALTER TABLE users ADD COLUMN tenant_id VARCHAR(50) DEFAULT 'default';");
  } catch (err) { /* column may exist */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS failed_attempts (
      email VARCHAR(255) PRIMARY KEY,
      attempts INTEGER DEFAULT 0,
      locked_until TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query('ALTER TABLE failed_attempts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()');
  } catch (err) { /* column may exist */ }
  try {
    await pool.query('UPDATE failed_attempts SET updated_at = NOW() WHERE updated_at IS NULL');
  } catch (err) { /* best effort backfill */ }
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_failed_attempts_locked_until ON failed_attempts (locked_until)');
  } catch (err) { /* index may exist */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_mfa (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mfa_secret VARCHAR(255) NOT NULL,
      backup_codes JSONB DEFAULT '[]'::jsonb,
      mfa_enabled BOOLEAN DEFAULT false,
      backup_codes_shown BOOLEAN DEFAULT false,
      backup_codes_issued_at TIMESTAMP,
      backup_codes_expires_at TIMESTAMP
    );
  `);
  // Existing installs get the freshness columns; legacy code sets are given a
  // bounded lifetime from the moment this ships rather than living forever.
  try {
    await pool.query('ALTER TABLE user_mfa ADD COLUMN IF NOT EXISTS backup_codes_issued_at TIMESTAMP');
    await pool.query('ALTER TABLE user_mfa ADD COLUMN IF NOT EXISTS backup_codes_expires_at TIMESTAMP');
    await pool.query(`
      UPDATE user_mfa
      SET backup_codes_issued_at = COALESCE(backup_codes_issued_at, NOW()),
          backup_codes_expires_at = COALESCE(backup_codes_expires_at, NOW() + INTERVAL '90 days')
      WHERE backup_codes_expires_at IS NULL
    `);
  } catch (err) { /* column already present */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_devices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id VARCHAR(255) NOT NULL,
      device_name VARCHAR(200),
      device_type VARCHAR(50),
      os VARCHAR(50),
      browser VARCHAR(50),
      ip_address VARCHAR(45),
      fingerprint VARCHAR(255),
      is_trusted BOOLEAN DEFAULT false,
      last_used_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, device_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64),
      ip_address VARCHAR(45),
      user_agent TEXT,
      device_id VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS passwordless_tokens (
      id SERIAL PRIMARY KEY,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Rename for installs created before the column carried its honest name.
  try {
    await pool.query('ALTER TABLE passwordless_tokens RENAME COLUMN token TO token_hash');
  } catch (err) { /* already renamed */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash VARCHAR(64) NOT NULL UNIQUE,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Per-tenant password policy. Column defaults reproduce the historical
  // global rules; a tenant opts up by writing a row (defaults are applied by
  // the service when no row exists, so absence is never a downgrade).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_policies (
      tenant_id VARCHAR(50) PRIMARY KEY,
      min_length INTEGER NOT NULL DEFAULT 8,
      require_upper BOOLEAN NOT NULL DEFAULT true,
      require_lower BOOLEAN NOT NULL DEFAULT false,
      require_digit BOOLEAN NOT NULL DEFAULT true,
      require_symbol BOOLEAN NOT NULL DEFAULT false,
      history_count INTEGER NOT NULL DEFAULT 0,
      max_age_days INTEGER,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // Backfill: existing tenants get an explicit default row so settings
  // surfaces have something to edit and audits can diff from a stored row.
  try {
    await pool.query(`INSERT INTO password_policies (tenant_id) VALUES ('default') ON CONFLICT (tenant_id) DO NOTHING`);
    await pool.query(`
      INSERT INTO password_policies (tenant_id)
      SELECT DISTINCT tenant_id FROM users WHERE tenant_id IS NOT NULL AND tenant_id <> ''
      ON CONFLICT (tenant_id) DO NOTHING
    `);
  } catch (err) { /* best effort backfill */ }

  // Salted hashes of recent passwords, used only for reuse rejection. Plain
  // passwords are never stored here (or anywhere).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_password_history_user ON password_history (user_id, created_at DESC)');
  } catch (err) { /* index may exist */ }

  // Password age tracking for advisory expiry (max_age_days).
  try {
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMP');
    await pool.query('UPDATE users SET password_changed_at = COALESCE(updated_at, created_at, NOW()) WHERE password_changed_at IS NULL');
  } catch (err) { /* column may exist */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      credential_id VARCHAR(255) NOT NULL UNIQUE,
      public_key TEXT NOT NULL,
      counter INTEGER DEFAULT 0,
      device_name VARCHAR(200),
      device_type VARCHAR(50),
      transports JSONB DEFAULT '[]'::jsonb,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP DEFAULT NOW(),
      last_used_at TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      challenge TEXT NOT NULL UNIQUE,
      purpose VARCHAR(20) NOT NULL DEFAULT 'registration',
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user ON webauthn_challenges (user_id, purpose, expires_at);`);
  // Cleanup legacy challenge rows that were stored as pseudo-credentials.
  try {
    await pool.query(`DELETE FROM webauthn_credentials WHERE credential_id LIKE 'challenge:%'`);
  } catch (e) { /* ignore if cleanup fails on older schemas */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_providers (
      id SERIAL PRIMARY KEY,
      provider VARCHAR(50) NOT NULL,
      client_id VARCHAR(255) NOT NULL,
      client_secret VARCHAR(255) NOT NULL,
      redirect_uri VARCHAR(500),
      scopes VARCHAR(500) DEFAULT 'openid email profile',
      enabled BOOLEAN DEFAULT true,
      tenant_id VARCHAR(50) DEFAULT 'default',
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(provider, tenant_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_states (
      state VARCHAR(64) PRIMARY KEY,
      provider VARCHAR(50) NOT NULL,
      tenant_id VARCHAR(50) DEFAULT 'default',
      redirect_to VARCHAR(500),
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  // OIDC nonce issued with the authorize request and validated against the
  // id_token on callback (replay/injection defence for the login ceremony).
  try {
    await pool.query('ALTER TABLE oauth_states ADD COLUMN IF NOT EXISTS nonce VARCHAR(64)');
  } catch (err) { /* column may already exist */ }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS oauth_links (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      provider_user_id VARCHAR(255) NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(provider, provider_user_id)
    );
  `);

  // Scoped, expiring, individually revocable API keys (issue #472). Only the
  // bcrypt hash of the secret is stored; key_id is the public lookup handle.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id SERIAL PRIMARY KEY,
      key_id VARCHAR(32) NOT NULL UNIQUE,
      key_hash VARCHAR(255) NOT NULL,
      label VARCHAR(120) NOT NULL,
      scopes JSONB NOT NULL DEFAULT '[]'::jsonb,
      tenant_id VARCHAR(50) DEFAULT 'default',
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      revoked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      expires_at TIMESTAMP,
      revoked_at TIMESTAMP,
      last_used_at TIMESTAMP
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_api_keys_key_id ON api_keys (key_id);');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, created_at DESC);');
  } catch (err) { /* index may exist */ }

  // Harden oauth_providers client_secret column to TEXT and migrate plaintext secrets to encrypted at-rest values
  try {
    await pool.query("ALTER TABLE oauth_providers ALTER COLUMN client_secret TYPE TEXT USING client_secret::text");
  } catch (e) { /* column already TEXT or migration not needed */ }
  try {
    const existing = await pool.query('SELECT id, client_secret FROM oauth_providers');
    for (const row of existing.rows) {
      if (row.client_secret && !isEncryptedOAuthSecret(row.client_secret)) {
        const enc = encryptOAuthSecret(row.client_secret);
        await pool.query('UPDATE oauth_providers SET client_secret = $1 WHERE id = $2', [enc, row.id]);
      }
    }
  } catch (e) {
    safeLog(console.error, 'OAuth provider secret migration failed:', e);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotated_tokens (
      id SERIAL PRIMARY KEY,
      token_hash VARCHAR(64) NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // Issued SAML AuthnRequest identifiers, kept for a short TTL so the ACS can
  // match InResponseTo and enforce one-time consumption. Consumed rows are
  // retained until cleanup so replays can be distinguished from forgery.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saml_authn_requests (
      request_id VARCHAR(128) PRIMARY KEY,
      tenant_id VARCHAR(50) DEFAULT 'default',
      expires_at TIMESTAMP NOT NULL,
      consumed_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS idx_saml_authn_requests_expires ON saml_authn_requests (expires_at)');
  } catch (err) { /* index may exist */ }

  const adminCheck = await pool.query('SELECT * FROM users WHERE email = $1', [
    'admin@atlas.io',
  ]);
  if (adminCheck.rows.length === 0) {
    const hashedPass = await bcrypt.hash(ADMIN_DEFAULT_PASSWORD, BCRYPT_COST);
    await pool.query(
      'INSERT INTO users (email, password, name, role, department, position, tenant_id, password_changed_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
      [
        'admin@atlas.io',
        hashedPass,
        'Super Admin',
        'admin',
        'Global',
        'System Administrator',
        'default'
      ]
    );
    console.log('Default admin user created (admin@atlas.io)');
  }

  console.log('Database initialized successfully.');
}

initDB().catch((err) => {
  safeLog(console.error, 'Database initialization failed:', err);
});

app.post('/register', createUserRateLimiter('register', 10, 15 * 60 * 1000, { keyByEmail: true }), async (req, res) => {
  const { email, password, name, department, position } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ message: 'Email, password, and name are required' });
  }

  const emailError = validateEmail(email);
  if (emailError) {
    return res.status(400).json({ message: emailError });
  }
  const normalizedEmail = normalizeEmail(email);

  // Tenant is always assigned server-side. Joining an existing tenant
  // requires an invite/admin flow, never a client-supplied tenant_id.
  const tenantId = 'default';

  // Enforce the requesting tenant's policy (defaults until the tenant opts up).
  const policy = await getPasswordPolicyForTenant(tenantId);
  const passwordError = validatePassword(password, policy);
  if (passwordError) {
    return res.status(400).json({ message: passwordError, field: 'password' });
  }

  try {
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
    const result = await pool.query(
      `INSERT INTO users (email, password, name, role, department, position, tenant_id, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       RETURNING id, email, name, role, department, position, tenant_id`,
      [
        normalizedEmail,
        hashedPassword,
        name,
        'employee',
        department || 'General',
        position || 'Staff',
        tenantId
      ]
    );

    await recordPasswordHistory(result.rows[0].id, hashedPassword);

    await sendAuditEvent('auth.register', result.rows[0].id, normalizedEmail, {
      role: 'employee',
      tenant_id: tenantId
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: sanitizeUser(result.rows[0]),
    });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    if (error.code === '23505') {
      return res.status(409).json({ message: 'User already exists' });
    }
    res.status(500).json({ message: 'Server error during registration' });
  }
});

app.post('/login', createUserRateLimiter('login', 20, 15 * 60 * 1000, { keyByEmail: true }), async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const emailError = validateEmail(email);
  if (emailError) {
    return res.status(400).json({ message: emailError });
  }
  const normalizedEmail = normalizeEmail(email);

  try {
    if (await isAccountLocked(normalizedEmail)) {
      return res.status(423).json({
        message: `Account locked. Try again in ${LOCKOUT_MINUTES} minutes.`,
      });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    const user = result.rows[0];

    if (!user) {
      authFailedLoginTotal.labels({ known_user: 'false' }).inc();
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await recordFailedAttempt(normalizedEmail);
      authFailedLoginTotal.labels({ known_user: 'true' }).inc();
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    await clearFailedAttempts(normalizedEmail);

    // Advisory expiry status for the tenant policy: reported on login so the
    // client can prompt a rotation. Never blocks the login.
    const expiresPolicy = await getPasswordPolicyForTenant(user.tenant_id || 'default');
    const passwordStatus = passwordExpiryStatus(user.password_changed_at, expiresPolicy.max_age_days);

    const deviceId = req.headers['x-device-id'];
    const deviceFingerprint = req.headers['x-device-fingerprint'];

    let deviceTrusted = false;
    if (deviceId && deviceFingerprint) {
      const deviceResult = await pool.query(
        'SELECT is_trusted FROM user_devices WHERE user_id = $1 AND device_id = $2 AND fingerprint = $3',
        [user.id, deviceId, deviceFingerprint]
      );
      if (deviceResult.rows[0]) {
        deviceTrusted = deviceResult.rows[0].is_trusted;
        await pool.query(
          'UPDATE user_devices SET last_used_at = NOW(), ip_address = $1 WHERE user_id = $2 AND device_id = $3',
          [req.ip, user.id, deviceId]
        );
      }
    }

    const mfaResult = await pool.query(
      'SELECT mfa_enabled FROM user_mfa WHERE user_id = $1',
      [user.id]
    );
    const mfaRequired = mfaResult.rows[0]?.mfa_enabled || false;

    if (mfaRequired) {
      // Do not issue a full session yet - require second factor.
      // Create a short-lived (5m), single-use challenge token that is only valid for /mfa/validate.
      const mfaChallengeToken = signMfaChallengeToken(user);
      let jti;
      try {
        const decoded = jwt.decode(mfaChallengeToken);
        jti = decoded?.jti;
      } catch {}
      // The challenge cannot be validated without its stored jti, so a store
      // failure refuses the login instead of issuing an unredeemable token.
      if (!jti || !(await storeMfaChallengeJti(redisClient, jti, user.id))) {
        return authStoreUnavailable(res, 'mfa_challenge_store');
      }
      await sendAuditEvent('auth.login_mfa_required', user.id, email, {
        device_trusted: deviceTrusted,
        device_id: deviceId,
        ip_address: req.ip,
        user_agent: req.headers['user-agent']
      });
      return res.status(200).json({
        message: 'MFA required',
        mfa_required: true,
        mfa_challenge_token: mfaChallengeToken,
        password_expired: passwordStatus.expired,
        days_until_password_expiry: passwordStatus.days_until_expiry,
        password_max_age_days: passwordStatus.max_age_days
      });
    }

    const { sessionId, accessToken: token } = await issueLoginSession(user, req, res);

    await sendAuditEvent('auth.login', user.id, email, {
      device_trusted: deviceTrusted,
      mfa_required: false,
      device_id: deviceId,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      session_id: sessionId,
      password_expired: passwordStatus.expired,
      days_until_password_expiry: passwordStatus.days_until_expiry
    });

    res.status(200).json({
      message: 'Logged in successfully',
      token,
      session_id: sessionId,
      user: sanitizeUser(user),
      device_trusted: deviceTrusted,
      mfa_required: false,
      password_expired: passwordStatus.expired,
      days_until_password_expiry: passwordStatus.days_until_expiry,
      password_max_age_days: passwordStatus.max_age_days
    });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

app.post('/refresh', createUserRateLimiter('refresh', 100), requireCsrfDoubleSubmit, async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) {
    return res.status(400).json({ message: 'Refresh token is required' });
  }

  try {
    const rotation = await rotateRefreshToken(pool, refreshToken);
    if (rotation.status === 'reused') {
      await sendAuditEvent('auth.refresh_token_reuse', rotation.userId, null, { action: 'all_sessions_revoked' });
      return res.status(401).json({ message: 'Token reuse detected. All sessions revoked.' });
    }
    if (rotation.status !== 'ok') {
      return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }

    const row = rotation.user;
    const user = {
      id: row.id,
      email: row.email,
      role: row.role,
      tenant_id: row.tenant_id,
    };
    const token = signAccessToken(user, rotation.sessionId);
    const newRefreshToken = rotation.newRefreshToken;

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });
    mintCsrfCookie(res);

    res.status(200).json({
      message: 'Token refreshed',
      token,
      user: sanitizeUser(row),
    });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Server error during token refresh' });
  }
});

app.post('/logout', createUserRateLimiter('logout', 100), requireCsrfDoubleSubmit, async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  const sessionId = req.headers['x-session-id'];
  let userId = null;
  let userEmail = null;

  try {
    if (refreshToken) {
      const revocation = await revokeRefreshTokenForLogout(pool, refreshToken);
      if (revocation.status === 'reused') {
        await sendAuditEvent('auth.refresh_token_reuse', revocation.userId, null, { action: 'all_sessions_revoked', source: 'logout' });
      }
      if (revocation.status !== 'none') {
        userId = revocation.userId;
        const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
        userEmail = userRes.rows[0]?.email || null;
      }
    }

    if (sessionId) {
      await pool.query('UPDATE sessions SET is_active = false WHERE id = $1', [sessionId]);
    }

    // Denylist the access token and session so they cannot be used for the
    // next 15 minutes. The write must not be skipped: a logout that cannot
    // record the revocation is refused (503) and the cookies are kept so the
    // client can retry once the store is back.
    const denylistKeys = new Set();
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      try {
        const payload = jwt.decode(authHeader.slice(7));
        if (payload?.jti) denylistKeys.add(`denylist:jti:${payload.jti}`);
        if (payload?.sid) denylistKeys.add(`denylist:sid:${payload.sid}`);
      } catch {}
    }
    if (sessionId) denylistKeys.add(`denylist:sid:${sessionId}`);
    if (denylistKeys.size) {
      if (!redisClient.isOpen) {
        return authStoreUnavailable(res, 'logout_denylist');
      }
      try {
        for (const key of denylistKeys) {
          await redisClient.set(key, '1', { EX: 15 * 60 });
        }
      } catch (err) {
        safeLog(console.error, 'Logout denylist write failed', err);
        return authStoreUnavailable(res, 'logout_denylist');
      }
    }

    res.clearCookie('refreshToken');
    res.clearCookie('csrf_token');

    if (userId) {
      await sendAuditEvent('auth.logout', userId, userEmail, {
        session_id: sessionId,
        ip_address: req.ip
      });
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Server error during logout' });
  }
});

app.post('/mfa/setup', requireRole(), createUserRateLimiter('mfa_setup', 5), async (req, res) => {
  try {
    const userId = req.user.id;
    const { password, token } = req.body || {};
    // Setup is the highest-stakes settings change in the account flow: it
    // must not silently disarm MFA on a bare session. Require proof of the
    // existing factor first - either the account password or a current TOTP
    // code - and never toggle mfa_enabled off as a side effect.
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    let confirmed = false;
    if (password) {
      confirmed = await bcrypt.compare(password, user.password);
    }
    const existingMfa = await pool.query('SELECT * FROM user_mfa WHERE user_id = $1', [userId]);
    if (!confirmed && token && existingMfa.rows[0]?.mfa_secret) {
      confirmed = authenticator.check(token, existingMfa.rows[0].mfa_secret);
    }
    if (!confirmed) {
      await sendAuditEvent('auth.mfa_setup_denied', userId, req.user.email, {});
      return res.status(403).json({ message: 'Confirm with your password or current MFA code to change MFA settings' });
    }
    const secret = authenticator.generateSecret();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const backupCodes = Array.from({ length: 10 }, () => ({
      code: crypto.randomBytes(5).toString('hex').slice(0, 8).toUpperCase(),
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }));

    const existing = await pool.query('SELECT backup_codes_shown, mfa_enabled FROM user_mfa WHERE user_id = $1', [userId]);
    const alreadyShown = existing.rows[0]?.backup_codes_shown === true;
    const wasEnabled = existing.rows[0]?.mfa_enabled === true;

    await pool.query(`
      INSERT INTO user_mfa (user_id, mfa_secret, backup_codes, mfa_enabled, backup_codes_issued_at, backup_codes_expires_at)
      VALUES ($1, $2, $3::jsonb, $4, NOW(), $5)
      ON CONFLICT (user_id) DO UPDATE SET
        mfa_secret = EXCLUDED.mfa_secret,
        backup_codes = EXCLUDED.backup_codes,
        backup_codes_issued_at = EXCLUDED.backup_codes_issued_at,
        backup_codes_expires_at = EXCLUDED.backup_codes_expires_at
    `, [userId, secret, JSON.stringify(backupCodes), wasEnabled, expiresAt]);

    const otpauth = authenticator.keyuri(req.user.email, 'Atlas Workforce', secret);

    const response = { secret, qr_code_uri: otpauth };
    if (alreadyShown) {
      response.message = 'Backup codes were regenerated. Use /mfa/rotate-backup-codes to view new codes with re-authentication.';
    } else {
      await pool.query('UPDATE user_mfa SET backup_codes_shown = true WHERE user_id = $1', [userId]);
      response.backup_codes = backupCodes.map((entry) => entry.code);
      response.backup_codes_expires_at = expiresAt.toISOString();
      response.message = 'Save these backup codes. They will not be shown again.';
    }

    await sendAuditEvent('auth.mfa_setup_confirmed', userId, req.user.email, { was_enabled: wasEnabled });

    res.json(response);
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'MFA setup failed' });
  }
});

app.post('/mfa/rotate-backup-codes', requireRole(), createUserRateLimiter('mfa_verify', 5), async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Current TOTP token is required to rotate backup codes' });
    }

    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM user_mfa WHERE user_id = $1', [userId]);
    if (!result.rows[0]) {
      return res.status(400).json({ message: 'MFA not set up' });
    }

    const isValid = authenticator.check(token, result.rows[0].mfa_secret);
    if (!isValid) {
      return res.status(400).json({ message: 'Invalid token' });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
    const newCodes = Array.from({ length: 10 }, () => ({
      code: crypto.randomBytes(5).toString('hex').slice(0, 8).toUpperCase(),
      issued_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    }));

    await pool.query(`
      UPDATE user_mfa
      SET backup_codes = $1::jsonb,
          backup_codes_shown = true,
          backup_codes_issued_at = NOW(),
          backup_codes_expires_at = $2
      WHERE user_id = $3
    `, [JSON.stringify(newCodes), expiresAt, userId]);

    await sendAuditEvent('auth.mfa_rotate_codes', userId, req.user.email);

    res.json({
      message: 'Backup codes rotated successfully. Save these codes as they will not be shown again.',
      backup_codes: newCodes.map((entry) => entry.code),
      backup_codes_expires_at: expiresAt.toISOString(),
    });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to rotate backup codes' });
  }
});

app.post('/mfa/verify', requireRole(), createUserRateLimiter('mfa_verify', 10), async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Token is required' });
    }

    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM user_mfa WHERE user_id = $1', [userId]);
    if (!result.rows[0] || !result.rows[0].mfa_secret) {
      return res.status(400).json({ message: 'MFA not set up. Call /mfa/setup first.' });
    }

    const isValid = authenticator.check(token, result.rows[0].mfa_secret);
    if (!isValid) {
      return res.status(400).json({ message: 'Invalid token' });
    }

    await pool.query('UPDATE user_mfa SET mfa_enabled = true WHERE user_id = $1', [userId]);
    await sendAuditEvent('auth.mfa_enabled', userId, req.user.email);

    res.json({ message: 'MFA enabled successfully' });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'MFA verification failed' });
  }
});

app.post('/mfa/validate', createUserRateLimiter('mfa_validate', 10), async (req, res) => {
  try {
    const { token, backup_code, mfa_challenge_token } = req.body;
    if (!token && !backup_code) {
      return res.status(400).json({ message: 'Token or backup code is required' });
    }

    let userId;
    let user;
    let challengeJti = null;
    let isChallengeFlow = false;

    if (mfa_challenge_token) {
      // Login MFA challenge flow: verify short-lived single-use challenge token issued by /login
      let payload;
      try {
        payload = jwt.verify(mfa_challenge_token, jwtSecret, {
          algorithms: ['HS256'],
          audience: MFA_CHALLENGE_AUD,
          issuer: MFA_CHALLENGE_ISS,
        });
      } catch (err) {
        if (err.name === 'TokenExpiredError') {
          return res.status(401).json({ message: 'MFA challenge token expired' });
        }
        return res.status(401).json({ message: 'Invalid MFA challenge token' });
      }
      if (payload.purpose !== 'mfa_challenge') {
        return res.status(401).json({ message: 'Invalid challenge token purpose' });
      }
      const jti = payload.jti;
      if (!jti) {
        return res.status(401).json({ message: 'Challenge token missing jti' });
      }
      // Enforce single-use via Redis (5 minute TTL). Fails closed: when the
      // store cannot answer, the challenge cannot be trusted either.
      const exists = await mfaChallengeJtiExists(redisClient, jti);
      if (exists === null) {
        return authStoreUnavailable(res, 'mfa_challenge_check');
      }
      if (!exists) {
        return res.status(401).json({ message: 'MFA challenge token already used or expired' });
      }
      challengeJti = jti;
      userId = parseInt(payload.sub || payload.user_id || payload.id, 10);
      if (!userId) {
        return res.status(400).json({ message: 'Invalid challenge token subject' });
      }
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      user = userResult.rows[0];
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      if (!user.active) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }
      isChallengeFlow = true;
    } else {
      // Step-up flow: require a valid Bearer session token
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Authentication required' });
      }
      const bearer = authHeader.slice(7);
      let payload;
      try {
        payload = jwt.verify(bearer, jwtSecret, { algorithms: ['HS256'] });
        if (payload.purpose === 'mfa_challenge' || payload.aud === MFA_CHALLENGE_AUD) {
          return res.status(401).json({ message: 'MFA challenge token not valid for this endpoint' });
        }
      } catch {
        return res.status(401).json({ message: 'Invalid or expired token' });
      }
      userId = payload.id;
      const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
      user = userResult.rows[0];
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      req.user = payload;
    }

    const result = await pool.query('SELECT * FROM user_mfa WHERE user_id = $1 AND mfa_enabled = true', [userId]);
    if (!result.rows[0]) {
      return res.status(400).json({ message: 'MFA is not enabled for this user' });
    }
    const mfa = result.rows[0];

    let validated = false;
    let method = null;
    if (token) {
      const isValid = authenticator.check(token, mfa.mfa_secret);
      if (isValid) {
        validated = true;
        method = 'totp';
      }
    }
    if (!validated && backup_code) {
      // One guarded statement: match (case-insensitive, trimmed) and consume
      // the code in the same UPDATE, refuse when the set is expired, and
      // re-check on write conflict so two concurrent submits cannot both win.
      // Doing the work inside jsonb removes the JS-side JSON.parse throw on
      // corrupted rows entirely.
      const normalizedCode = String(backup_code).trim().toUpperCase();
      const codeMatch = `(
        (jsonb_typeof(t.value) = 'string' AND upper(btrim(t.value #>> '{}')) = $2)
        OR
        (jsonb_typeof(t.value) = 'object' AND upper(btrim(t.value ->> 'code')) = $2)
      )`;
      const consumed = await pool.query(
        `UPDATE user_mfa
         SET backup_codes = (
           SELECT COALESCE(jsonb_agg(t.value) FILTER (WHERE NOT (${codeMatch})), '[]'::jsonb)
           FROM jsonb_array_elements(COALESCE(user_mfa.backup_codes, '[]'::jsonb)) AS t(value)
         )
         WHERE user_id = $1
           AND backup_codes_expires_at IS NOT NULL
           AND backup_codes_expires_at > NOW()
           AND EXISTS (
             SELECT 1
             FROM jsonb_array_elements(COALESCE(user_mfa.backup_codes, '[]'::jsonb)) AS t(value)
             WHERE ${codeMatch}
           )
         RETURNING user_id`,
        [userId, normalizedCode]
      );
      if (consumed.rowCount === 1) {
        validated = true;
        method = 'backup_code';
      } else {
        // Distinguish an expired set from a wrong code so users know to rotate.
        const expired = await pool.query(
          `SELECT 1 FROM user_mfa
           WHERE user_id = $1
             AND (backup_codes_expires_at IS NULL OR backup_codes_expires_at <= NOW())
             AND EXISTS (
               SELECT 1
               FROM jsonb_array_elements(COALESCE(backup_codes, '[]'::jsonb)) AS t(value)
               WHERE ${codeMatch}
             )`,
          [userId, normalizedCode]
        );
        if (expired.rowCount === 1) {
          return res.status(400).json({
            message: 'Backup codes have expired. Rotate them with /mfa/rotate-backup-codes using a TOTP code.',
          });
        }
      }
    }
    if (!validated) {
      return res.status(400).json({ message: 'Invalid token or backup code' });
    }

    // Consume challenge token after successful validation (single-use). If the
    // store cannot record the consumption the session is not issued: the
    // challenge would otherwise stay replayable.
    if (isChallengeFlow && challengeJti) {
      const consumed = await consumeMfaChallengeJti(redisClient, challengeJti);
      if (!consumed) {
        return authStoreUnavailable(res, 'mfa_challenge_consume');
      }
    }

    if (isChallengeFlow) {
      // Issue full session for login completion
      const { sessionId, accessToken } = await issueLoginSession(user, req, res);
      await sendAuditEvent('auth.mfa_validate', userId, user.email, { method, mfa_challenge: true });
      return res.json({
        message: 'MFA validated, logged in successfully',
        token: accessToken,
        session_id: sessionId,
        user: sanitizeUser(user),
        validated: true,
      });
    } else {
      const mfaToken = signMfaToken(req.user);
      await sendAuditEvent('auth.mfa_validate', userId, user.email, { method });
      return res.json({ message: 'Token validated', validated: true, mfa_token: mfaToken });
    }
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'MFA validation failed' });
  }
});

app.post('/mfa/disable', requireRole(), createUserRateLimiter('mfa_disable', 5), async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ message: 'Password is required to disable MFA' });
    }

    const userId = req.user.id;
    const userResult = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
    if (!userResult.rows[0]) {
      return res.status(404).json({ message: 'User not found' });
    }

    const isMatch = await bcrypt.compare(password, userResult.rows[0].password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Invalid password' });
    }

    await pool.query('DELETE FROM user_mfa WHERE user_id = $1', [userId]);
    await sendAuditEvent('auth.mfa_disabled', userId, req.user.email);

    res.json({ message: 'MFA disabled successfully' });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to disable MFA' });
  }
});

app.get('/mfa/status', requireRole(), createUserRateLimiter('mfa_status', 60), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT mfa_enabled FROM user_mfa WHERE user_id = $1', [userId]);

    res.json({
      mfa_enabled: result.rows[0]?.mfa_enabled || false,
      mfa_setup: !!result.rows[0]
    });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to get MFA status' });
  }
});

app.post('/devices/register', requireRole(), createUserRateLimiter('device_register', 20), async (req, res) => {
  try {
    const { device_id, device_name, device_type, os, browser, fingerprint } = req.body;
    if (!device_id || !fingerprint) {
      return res.status(400).json({ message: 'device_id and fingerprint are required' });
    }

    const userId = req.user.id;

    const existing = await pool.query(
      'SELECT id, is_trusted FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [userId, device_id]
    );

    if (existing.rows.length > 0) {
      const result = await pool.query(`
        UPDATE user_devices
        SET device_name = COALESCE($1, device_name),
            device_type = COALESCE($2, device_type),
            os = COALESCE($3, os),
            browser = COALESCE($4, browser),
            fingerprint = $5,
            ip_address = $6,
            last_used_at = NOW()
        WHERE id = $7
        RETURNING id, device_id, device_name, device_type, os, browser, ip_address, is_trusted, last_used_at, created_at
      `, [device_name, device_type, os, browser, fingerprint, req.ip, existing.rows[0].id]);

      return res.json(result.rows[0]);
    }

    const result = await pool.query(`
      INSERT INTO user_devices (user_id, device_id, device_name, device_type, os, browser, ip_address, fingerprint, last_used_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
      RETURNING id, device_id, device_name, device_type, os, browser, ip_address, is_trusted, last_used_at, created_at
    `, [userId, device_id, device_name, device_type, os, browser, req.ip, fingerprint]);

    res.status(201).json(result.rows[0]);
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Device registration failed' });
  }
});

app.get('/devices', requireRole(), createUserRateLimiter('device_list', 60), async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const result = await pool.query(
      'SELECT id, device_id, device_name, device_type, os, browser, ip_address, is_trusted, last_used_at, created_at FROM user_devices WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    res.json(result.rows);
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to list devices' });
  }
});

app.put('/devices/:id/trust', requireRole(), createUserRateLimiter('device_trust', 20), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    if (isNaN(deviceId)) {
      return res.status(400).json({ message: 'Invalid device id' });
    }

    const userId = req.user.id;
    const result = await pool.query(
      'UPDATE user_devices SET is_trusted = NOT is_trusted WHERE id = $1 AND user_id = $2 RETURNING id, device_id, device_name, device_type, os, browser, is_trusted, last_used_at',
      [deviceId, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Device not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to update device trust' });
  }
});

app.delete('/devices/:id', requireRole(), createUserRateLimiter('device_delete', 20), async (req, res) => {
  try {
    const deviceId = parseInt(req.params.id);
    if (isNaN(deviceId)) {
      return res.status(400).json({ message: 'Invalid device id' });
    }

    const userId = req.user.id;
    const result = await pool.query(
      'DELETE FROM user_devices WHERE id = $1 AND user_id = $2 RETURNING id',
      [deviceId, userId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Device not found' });
    }

    res.json({ message: 'Device removed' });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to remove device' });
  }
});

app.post('/devices/verify', requireRole(), createUserRateLimiter('device_verify', 30), async (req, res) => {
  try {
    const { device_id, fingerprint, nonce } = req.body;
    if (!device_id || !fingerprint) {
      return res.status(400).json({ message: 'device_id and fingerprint are required' });
    }

    if (nonce) {
      if (!redisClient.isOpen) {
        return res.status(503).json({ message: 'Nonce verification unavailable' });
      }
      const nonceKey = `device_nonce:${nonce}`;
      const used = await redisClient.get(nonceKey);
      if (used) {
        return res.status(400).json({ message: 'Nonce already used' });
      }
      await redisClient.setEx(nonceKey, 300, '1');
    }

    const userId = req.user.id;
    const result = await pool.query(
      'SELECT id, is_trusted, fingerprint FROM user_devices WHERE user_id = $1 AND device_id = $2',
      [userId, device_id]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Device not found' });
    }

    const match = result.rows[0].fingerprint === fingerprint;
    if (match) {
      await pool.query(
        'UPDATE user_devices SET last_used_at = NOW(), ip_address = $1 WHERE id = $2',
        [req.ip, result.rows[0].id]
      );
    }

    res.json({
      verified: match,
      device: {
        id: result.rows[0].id,
        is_trusted: result.rows[0].is_trusted
      }
    });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Device verification failed' });
  }
});

app.get('/scim/v2/Users', requireScimAuth, createUserRateLimiter('scim_list', 30), async (req, res) => {
  try {
    const tenant = req.scimTenant;
    if (!tenant) {
      return sendScimError(res, 401, 'Authentication required');
    }
    const rawCount = parseInt(req.query.count, 10);
    const count = Number.isNaN(rawCount) ? 10 : Math.min(Math.max(rawCount, 1), 100);
    const rawStartIndex = parseInt(req.query.startIndex, 10);
    const startIndex = Number.isNaN(rawStartIndex) ? 1 : Math.max(rawStartIndex, 1);
    const offset = startIndex - 1;

    let whereClause = 'WHERE tenant_id = $1';
    let queryParams = [tenant];

    if (req.query.filter) {
      const rawFilter = String(req.query.filter);
      const userNameMatch = rawFilter.match(/userName\s+eq\s+"([^"]{1,254})"/i);
      // Linear match on purpose: the value pattern must not reach back over
      // arbitrary filter text (that backtracking is a ReDoS vector).
      const emailMatch = rawFilter.match(/value\s+eq\s+"([^"]{1,254})"/i);
      const filterValue = userNameMatch?.[1] || emailMatch?.[1];

      if (!filterValue) {
        return sendScimError(res, 400, 'Unsupported SCIM filter. Supported: userName eq "email@example.com"');
      }
      whereClause += ` AND email = $${queryParams.length + 1}`;
      queryParams.push(filterValue);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*) FROM users ${whereClause}`,
      queryParams
    );
    const totalResults = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT * FROM users ${whereClause} ORDER BY id ASC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
      [...queryParams, count, offset]
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    res.json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults,
      itemsPerPage: count,
      startIndex,
      Resources: result.rows.map(user => formatScimUser(user, baseUrl))
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.post('/scim/v2/Users', requireScimAuth, createUserRateLimiter('scim_create', 20), async (req, res) => {
  try {
    const tenant = req.scimTenant;
    if (!tenant) {
      return sendScimError(res, 401, 'Authentication required');
    }
    const { userName, name, emails, roles, active, externalId, password } = req.body;

    if (!userName) {
      return sendScimError(res, 400, 'userName is required');
    }

    const email = emails?.[0]?.value || userName;
    const givenName = name?.givenName || '';
    const familyName = name?.familyName || '';
    const displayName = name?.formatted || `${givenName} ${familyName}`.trim() || email;
    const requestedRole = roles?.[0]?.value;
    if (requestedRole && !isAllowedScimRole(requestedRole)) {
      return sendScimError(res, 400, 'Invalid role. Only employee provisioning is allowed via SCIM.');
    }
    const role = 'employee';
    const userActive = active !== undefined ? active : true;

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return sendScimError(res, 409, 'User already exists');
    }

    let passwordToHash;
    if (password && typeof password === 'string' && password.length > 0) {
      // SCIM is a credential-setting path too: enforce the provisioning
      // key's tenant policy (the tenant is verified, never client-supplied).
      const scimPolicy = await getPasswordPolicyForTenant(tenant);
      const passwordError = validatePassword(password, scimPolicy);
      if (passwordError) {
        return sendScimError(res, 400, passwordError);
      }
      passwordToHash = password;
    } else {
      // No usable credential is emailed for generated passwords, so the
      // account must be activated via POST /auth/password/reset-request
      // or POST /auth/admin/password-reset.
      passwordToHash = crypto.randomBytes(16).toString('hex');
    }
    const hashedPassword = await bcrypt.hash(passwordToHash, BCRYPT_COST);

    const result = await pool.query(
      `INSERT INTO users (email, password, name, role, active, tenant_id, password_changed_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW()) RETURNING *`,
      [email, hashedPassword, displayName, role, userActive, tenant]
    );

    if (password && typeof password === 'string' && password.length > 0) {
      await recordPasswordHistory(result.rows[0].id, hashedPassword);
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const scimUser = formatScimUser(result.rows[0], baseUrl);

    await sendAuditEvent('scim.user_created', result.rows[0].id, email, {
      method: 'scim',
      source: externalId || 'SCIM provisioned',
      tenant_id: tenant,
      actor: req.scimKeyId || `scim:${tenant}`,
      role
    });

    res.status(201).json(scimUser);
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    if (err.code === '23505') {
      return sendScimError(res, 409, 'User already exists');
    }
    return sendScimError(res, 500, 'Internal error');
  }
});

app.get('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_get', 60), async (req, res) => {
  try {
    const tenant = req.scimTenant;
    if (!tenant) {
      return sendScimError(res, 401, 'Authentication required');
    }
    if (!isValidScimUserId(req.params.id)) {
      return sendScimError(res, 400, 'Invalid user id');
    }
    const result = await pool.query('SELECT * FROM users WHERE id = $1 AND tenant_id = $2', [req.params.id, tenant]);
    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(formatScimUser(result.rows[0], baseUrl));
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.put('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_update', 20), async (req, res) => {
  try {
    const tenant = req.scimTenant;
    if (!tenant) {
      return sendScimError(res, 401, 'Authentication required');
    }
    if (!isValidScimUserId(req.params.id)) {
      return sendScimError(res, 400, 'Invalid user id');
    }
    const { userName, name, emails, roles, active } = req.body;

    const email = emails?.[0]?.value || userName;
    const givenName = name?.givenName || '';
    const familyName = name?.familyName || '';
    const displayName = name?.formatted || `${givenName} ${familyName}`.trim() || email;
    const role = roles?.[0]?.value;
    if (role && !isAllowedScimRole(role)) {
      return sendScimError(res, 400, 'Invalid role. Only employee provisioning is allowed via SCIM.');
    }

    const updateFields = [];
    const updateValues = [];
    let paramIdx = 1;

    if (email) { updateFields.push(`email = $${paramIdx++}`); updateValues.push(email); }
    if (displayName) { updateFields.push(`name = $${paramIdx++}`); updateValues.push(displayName); }
    if (role) { updateFields.push(`role = $${paramIdx++}`); updateValues.push(role); }
    if (active !== undefined) { updateFields.push(`active = $${paramIdx++}`); updateValues.push(active); }
    updateFields.push(`updated_at = NOW()`);

    if (updateFields.length === 1) {
      return sendScimError(res, 400, 'No attributes to update');
    }

    updateValues.push(req.params.id);
    updateValues.push(tenant);
    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx++} AND tenant_id = $${paramIdx} RETURNING *`;

    const result = await pool.query(query, updateValues);
    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    await sendAuditEvent('scim.user_updated', result.rows[0].id, result.rows[0].email, {
      method: 'scim',
      tenant_id: tenant,
      actor: req.scimKeyId || `scim:${tenant}`
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(formatScimUser(result.rows[0], baseUrl));
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    if (err.code === '23505') {
      return sendScimError(res, 409, 'User already exists');
    }
    return sendScimError(res, 500, 'Internal error');
  }
});

app.patch('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_patch', 20), async (req, res) => {
  try {
    const tenant = req.scimTenant;
    if (!tenant) {
      return sendScimError(res, 401, 'Authentication required');
    }
    if (!isValidScimUserId(req.params.id)) {
      return sendScimError(res, 400, 'Invalid user id');
    }
    const { Operations } = req.body;
    if (!Operations || !Array.isArray(Operations)) {
      return sendScimError(res, 400, 'Operations array is required');
    }

    const updateFields = [];
    const updateValues = [];
    let paramIdx = 1;

    for (const op of Operations) {
      if (op.op === 'replace') {
        if (op.path === 'active') {
          updateFields.push(`active = $${paramIdx++}`);
          updateValues.push(op.value === true || op.value === 'true');
        } else if (op.path === 'name.formatted') {
          updateFields.push(`name = $${paramIdx++}`);
          updateValues.push(op.value);
        } else if (op.path === 'emails[0].value' || op.path === 'userName') {
          updateFields.push(`email = $${paramIdx++}`);
          updateValues.push(op.value);
        } else if (op.path === 'roles[0].value' || op.path === 'role') {
          if (!isAllowedScimRole(op.value)) {
            return sendScimError(res, 400, 'Invalid role. Only employee provisioning is allowed via SCIM.');
          }
          updateFields.push(`role = $${paramIdx++}`);
          updateValues.push(op.value);
        } else if (!op.path && op.value && typeof op.value === 'object') {
          if (op.value.active !== undefined) {
            updateFields.push(`active = $${paramIdx++}`);
            updateValues.push(op.value.active);
          }
          if (op.value.name?.formatted) {
            updateFields.push(`name = $${paramIdx++}`);
            updateValues.push(op.value.name.formatted);
          }
          if (op.value.emails?.[0]?.value) {
            updateFields.push(`email = $${paramIdx++}`);
            updateValues.push(op.value.emails[0].value);
          }
          if (op.value.roles?.[0]?.value) {
            if (!isAllowedScimRole(op.value.roles[0].value)) {
              return sendScimError(res, 400, 'Invalid role. Only employee provisioning is allowed via SCIM.');
            }
            updateFields.push(`role = $${paramIdx++}`);
            updateValues.push(op.value.roles[0].value);
          }
          if (op.value.role && typeof op.value.role === 'string') {
            if (!isAllowedScimRole(op.value.role)) {
              return sendScimError(res, 400, 'Invalid role. Only employee provisioning is allowed via SCIM.');
            }
            updateFields.push(`role = $${paramIdx++}`);
            updateValues.push(op.value.role);
          }
          if (op.value.userName) {
            updateFields.push(`email = $${paramIdx++}`);
            updateValues.push(op.value.userName);
          }
        }
      }
    }

    if (updateFields.length === 0) {
      return sendScimError(res, 400, 'No valid replace operations found');
    }

    updateFields.push('updated_at = NOW()');
    updateValues.push(req.params.id);
    updateValues.push(tenant);

    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx++} AND tenant_id = $${paramIdx} RETURNING *`;

    const result = await pool.query(query, updateValues);
    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    await sendAuditEvent('scim.user_updated', result.rows[0].id, result.rows[0].email, {
      method: 'scim',
      tenant_id: tenant,
      actor: req.scimKeyId || `scim:${tenant}`
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(formatScimUser(result.rows[0], baseUrl));
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    if (err.code === '23505') {
      return sendScimError(res, 409, 'User already exists');
    }
    return sendScimError(res, 500, 'Internal error');
  }
});

app.delete('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_delete', 10), async (req, res) => {
  try {
    const tenant = req.scimTenant;
    if (!tenant) {
      return sendScimError(res, 401, 'Authentication required');
    }
    if (!isValidScimUserId(req.params.id)) {
      return sendScimError(res, 400, 'Invalid user id');
    }
    const result = await pool.query(
      'UPDATE users SET active = false, updated_at = NOW() WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, tenant]
    );

    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    await sendAuditEvent('scim.user_deactivated', parseInt(req.params.id), null, {
      method: 'scim',
      tenant_id: tenant,
      actor: req.scimKeyId || `scim:${tenant}`
    });

    res.status(204).send();
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    return sendScimError(res, 500, 'Internal error');
  }
});

// ── SAML AuthnRequest tracking ─────────────────────────────────────────────

function generateSamlRequestId() {
  return `_${crypto.randomBytes(16).toString('hex')}`;
}

function buildSamlAuthnRequest({ requestId, issueInstant, entityId, acsUrl, idpSsoUrl }) {
  return `<?xml version="1.0"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${requestId}" Version="2.0" IssueInstant="${issueInstant}" Destination="${idpSsoUrl}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${entityId}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>
</samlp:AuthnRequest>`;
}

// Persist an issued AuthnRequest id. If the write fails the caller must not
// hand the request to the IdP: an id the SP cannot remember is an id whose
// response the SP cannot distinguish from a replay, so the flow fails closed.
async function recordSamlAuthnRequest(requestId, tenantId) {
  const expiresAt = new Date(Date.now() + SAML_AUTHN_REQUEST_TTL_MINUTES * 60 * 1000);
  await pool.query(
    'INSERT INTO saml_authn_requests (request_id, tenant_id, expires_at) VALUES ($1, $2, $3)',
    [requestId, tenantId || SAML_TENANT_ID, expiresAt]
  );
  return expiresAt;
}

// Atomically redeem an AuthnRequest id: only the first caller for a matching,
// unconsumed, unexpired id gets a row back. Concurrency-safe (single UPDATE),
// so two assertions racing to reuse one id cannot both succeed.
async function consumeSamlAuthnRequest(requestId) {
  const result = await pool.query(
    `UPDATE saml_authn_requests
     SET consumed_at = NOW()
     WHERE request_id = $1 AND consumed_at IS NULL AND expires_at > NOW()
     RETURNING request_id`,
    [requestId]
  );
  return result.rows.length > 0;
}

function extractSamlInResponseTo(doc) {
  const candidates = [];
  const root = doc && doc.documentElement;
  if (root && root.getAttribute) {
    candidates.push(root.getAttribute('InResponseTo'));
  }
  const nodes = doc.getElementsByTagNameNS
    ? doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'SubjectConfirmationData')
    : doc.getElementsByTagName('SubjectConfirmationData');
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].getAttribute) candidates.push(nodes[i].getAttribute('InResponseTo'));
  }
  for (const value of candidates) {
    const trimmed = String(value || '').trim();
    if (trimmed) return trimmed;
  }
  return '';
}

app.post('/saml/acs', createUserRateLimiter('saml_acs', 20), async (req, res) => {
  try {
    const { SAMLResponse } = req.body;
    if (!SAMLResponse) {
      return res.status(400).json({ message: 'SAMLResponse is required' });
    }

    if (!SAML_IDP_CERT || !SAML_IDP_CERT.trim()) {
      console.error('SAML_IDP_CERT not configured — rejecting SAML ACS request');
      return res.status(503).json({ message: 'SAML is not configured on this server. Set SAML_IDP_CERT to enable SAML authentication.' });
    }

    const decodedXml = Buffer.from(SAMLResponse, 'base64').toString('utf-8');

    const doc = new DOMParser().parseFromString(decodedXml, 'text/xml');

    const signatureNodes = doc.getElementsByTagNameNS
      ? doc.getElementsByTagNameNS('http://www.w3.org/2000/09/xmldsig#', 'Signature')
      : doc.getElementsByTagName('Signature');

    if (signatureNodes.length === 0) {
      return res.status(400).json({ message: 'SAML response is not signed' });
    }

    let signatureVerified = false;
    for (let i = 0; i < signatureNodes.length; i++) {
      const sig = new SignedXml();
      sig.keyInfoProvider = {
        getKeyInfo() { return '<X509Data></X509Data>'; },
        getKey(keyInfo) { return SAML_IDP_CERT; },
      };
      sig.loadSignature(signatureNodes[i].toString());
      try {
        signatureVerified = sig.checkSignature(decodedXml);
        if (signatureVerified) break;
      } catch {
        continue;
      }
    }

    if (!signatureVerified) {
      return res.status(401).json({ message: 'SAML signature verification failed' });
    }

    // Response correlation and replay protection. The assertion must name the
    // AuthnRequest this service issued (InResponseTo); the id is redeemed
    // exactly once below, after the assertion itself has passed validation.
    const inResponseTo = extractSamlInResponseTo(doc);
    if (!inResponseTo) {
      await sendAuditEvent('auth.saml_login_rejected', null, null, {
        reason: 'missing_in_response_to',
        ip_address: req.ip
      });
      return res.status(401).json({ message: 'SAML response is not tied to a login request (InResponseTo missing)' });
    }
    if (!SAML_AUTHN_REQUEST_ID_PATTERN.test(inResponseTo)) {
      await sendAuditEvent('auth.saml_login_rejected', null, null, {
        reason: 'malformed_in_response_to',
        ip_address: req.ip
      });
      return res.status(401).json({ message: 'SAML response references an unknown login request' });
    }

    const conditions = doc.getElementsByTagNameNS
      ? doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Conditions')
      : doc.getElementsByTagName('Conditions');

    if (conditions.length > 0) {
      const condition = conditions[0];
      const notBefore = condition.getAttribute('NotBefore');
      const notOnOrAfter = condition.getAttribute('NotOnOrAfter');
      const now = new Date();

      if (notBefore && now < new Date(notBefore)) {
        return res.status(401).json({ message: 'SAML assertion is not yet valid (NotBefore)' });
      }

      if (notOnOrAfter && now >= new Date(notOnOrAfter)) {
        return res.status(401).json({ message: 'SAML assertion has expired (NotOnOrAfter)' });
      }

      const audienceNodes = doc.getElementsByTagNameNS
        ? doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'Audience')
        : doc.getElementsByTagName('Audience');

      if (audienceNodes.length > 0) {
        let audienceValid = false;
        const expectedSpEntityId = `${req.protocol}://${req.get('host')}/saml/metadata`;
        for (let i = 0; i < audienceNodes.length; i++) {
          const aud = (audienceNodes[i].textContent || '').trim();
          if (aud === SAML_IDP_ENTITY_ID || aud === expectedSpEntityId) {
            audienceValid = true;
            break;
          }
        }
        if (!audienceValid) {
          return res.status(401).json({ message: 'SAML audience restriction mismatch' });
        }
      }
    }

    // Validate Recipient and SubjectConfirmation expiry outside Conditions so it
    // applies even when Conditions is absent. SAML spec requires Recipient to
    // match the ACS URL.
    const subjectConfNodes = doc.getElementsByTagNameNS
      ? doc.getElementsByTagNameNS('urn:oasis:names:tc:SAML:2.0:assertion', 'SubjectConfirmationData')
      : doc.getElementsByTagName('SubjectConfirmationData');
    if (subjectConfNodes.length > 0) {
      const expectedRecipient = `${req.protocol}://${req.get('host')}/saml/acs`;
      const now = new Date();
      for (let i = 0; i < subjectConfNodes.length; i++) {
        const recipient = subjectConfNodes[i].getAttribute('Recipient');
        if (recipient && recipient !== expectedRecipient) {
          return res.status(401).json({ message: 'SAML Recipient mismatch' });
        }
        const scNotOnOrAfter = subjectConfNodes[i].getAttribute('NotOnOrAfter');
        if (scNotOnOrAfter && now >= new Date(scNotOnOrAfter)) {
          return res.status(401).json({ message: 'SAML SubjectConfirmation has expired' });
        }
      }
    }

    // Validate Response Destination if present
    const destination = doc.documentElement.getAttribute('Destination');
    if (destination) {
      const expectedDestination = `${req.protocol}://${req.get('host')}/saml/acs`;
      if (destination !== expectedDestination) {
        return res.status(401).json({ message: 'SAML Destination mismatch' });
      }
    }

    // Redeem the referenced AuthnRequest exactly once. Until this point the
    // response has only been read; a captured assertion now fails here on its
    // second presentation even if its own conditions are still valid.
    const requestConsumed = await consumeSamlAuthnRequest(inResponseTo);
    if (!requestConsumed) {
      // Diagnostics only: the client always gets the same answer for unknown,
      // expired and already-redeemed request ids.
      let reason = 'unknown_request_id';
      try {
        const lookup = await pool.query(
          'SELECT consumed_at, expires_at FROM saml_authn_requests WHERE request_id = $1',
          [inResponseTo]
        );
        const row = lookup.rows[0];
        if (row && row.consumed_at) reason = 'replayed_response';
        else if (row && new Date(row.expires_at) <= new Date()) reason = 'expired_request_id';
      } catch { /* keep the generic reason */ }
      await sendAuditEvent('auth.saml_login_rejected', null, null, {
        reason,
        request_id: inResponseTo,
        ip_address: req.ip
      });
      return res.status(401).json({ message: 'SAML response replay or stale login request rejected' });
    }

    const ns = 'urn:oasis:names:tc:SAML:2.0:assertion';

    let email = '';
    const nameIdNodes = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS(ns, 'NameID') : doc.getElementsByTagName('NameID');
    if (nameIdNodes.length > 0) {
      email = nameIdNodes[0].textContent || '';
    }

    let firstName = '';
    let lastName = '';

    const attrNodes = doc.getElementsByTagNameNS ? doc.getElementsByTagNameNS(ns, 'Attribute') : doc.getElementsByTagName('Attribute');
    for (let i = 0; i < attrNodes.length; i++) {
      const name = attrNodes[i].getAttribute('Name') || '';
      const valNodes = attrNodes[i].getElementsByTagNameNS
        ? attrNodes[i].getElementsByTagNameNS(ns, 'AttributeValue')
        : attrNodes[i].getElementsByTagName('AttributeValue');
      const value = valNodes.length > 0 ? (valNodes[0].textContent || '') : '';
      const lower = name.toLowerCase();
      if (lower.includes('email') && !email) {
        email = value;
      } else if (lower.includes('firstname') || lower.includes('givenname')) {
        firstName = value;
      } else if (lower.includes('lastname') || lower.includes('surname')) {
        lastName = value;
      }
    }
    const displayName = `${firstName} ${lastName}`.trim() || email;

    if (!email) {
      return res.status(400).json({ message: 'Could not extract user identity from SAML response' });
    }

    // The asserted address is identity data from the IdP: normalize before any
    // lookup or insert so address variants map to one account, and reject
    // malformed values instead of persisting them.
    const normalizedEmail = normalizeEmail(email);
    const emailError = validateEmail(normalizedEmail);
    if (emailError) {
      await sendAuditEvent('auth.saml_login_rejected', null, null, {
        reason: 'invalid_asserted_email',
        ip_address: req.ip
      });
      return res.status(400).json({ message: `SAML asserted email is invalid: ${emailError}` });
    }

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [normalizedEmail]);
    let userData;
    let provisioned = false;

    if (userResult.rows.length === 0) {
      // JIT provisioning: the SP pins the tenant (SAML_TENANT_ID), grants the
      // least-privileged role explicitly, and marks the account active in the
      // insert rather than relying on column defaults.
      const tempPassword = crypto.randomBytes(16).toString('hex');
      const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_COST);
      userResult = await pool.query(
        `INSERT INTO users (email, password, name, role, department, position, tenant_id, active, password_changed_at)
         VALUES ($1, $2, $3, 'employee', 'General', 'Staff', $4, true, NOW())
         RETURNING *`,
        [normalizedEmail, hashedPassword, displayName || normalizedEmail, SAML_TENANT_ID]
      );
      userData = userResult.rows[0];
      provisioned = true;
    } else {
      userData = userResult.rows[0];
    }

    if (!userData.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    if (provisioned) {
      await sendAuditEvent('auth.saml_user_provisioned', userData.id, normalizedEmail, {
        tenant_id: userData.tenant_id,
        role: userData.role,
        source: 'saml-jit'
      });
    }

    const { sessionId, accessToken: token } = await issueLoginSession(userData, req, res);

    await sendAuditEvent('auth.saml_login', userData.id, normalizedEmail, {
      ip_address: req.ip,
      session_id: sessionId
    });

    res.json({
      message: 'SAML login successful',
      token,
      session_id: sessionId,
      user: sanitizeUser(userData)
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'SAML ACS processing error' });
  }
});

app.get('/saml/metadata', (req, res) => {
  const entityId = `${req.protocol}://${req.get('host')}/saml/metadata`;
  const acsUrl = `${req.protocol}://${req.get('host')}/saml/acs`;

  const metadata = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <SPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</NameIDFormat>
    <AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${acsUrl}" index="0"/>
  </SPSSODescriptor>
</EntityDescriptor>`;

  res.type('application/xml');
  res.send(metadata);
});

app.post('/saml/login', createUserRateLimiter('saml_login', 20), async (req, res) => {
  try {
    if (!SAML_IDP_SSO_URL) {
      return res.status(503).json({ message: 'SAML is not configured on this server. Set SAML_IDP_SSO_URL to enable SAML authentication.' });
    }
    const entityId = `${req.protocol}://${req.get('host')}/saml/metadata`;
    const acsUrl = `${req.protocol}://${req.get('host')}/saml/acs`;

    const requestId = generateSamlRequestId();
    const issueInstant = new Date().toISOString();
    // Persist before returning the redirect URL: if this fails the request is
    // never handed to the IdP, so no unverifiable response can come back.
    await recordSamlAuthnRequest(requestId, SAML_TENANT_ID);

    const samlRequest = buildSamlAuthnRequest({
      requestId,
      issueInstant,
      entityId,
      acsUrl,
      idpSsoUrl: SAML_IDP_SSO_URL,
    });

    const encodedRequest = Buffer.from(samlRequest).toString('base64');

    res.json({
      redirect_url: `${SAML_IDP_SSO_URL}?SAMLRequest=${encodeURIComponent(encodedRequest)}`,
      saml_request: encodedRequest,
      entity_id: entityId,
      acs_url: acsUrl
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'SAML login initiation failed' });
  }
});

app.post('/auth/passwordless/request', createUserRateLimiter('passwordless_request', 5, 15 * 60 * 1000, { keyByEmail: true }), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailError = validateEmail(email);
    if (emailError) {
      return res.status(400).json({ message: emailError });
    }
    const normalizedEmail = normalizeEmail(email);
    const neutralMessage = 'Check your email for the login link';

    const userResult = await pool.query('SELECT id, email FROM users WHERE email = $1 AND active = true', [normalizedEmail]);
    if (!userResult.rows[0]) {
      await sendAuditEvent('auth.passwordless_requested', null, normalizedEmail, { found: false });
      return res.json({ message: neutralMessage });
    }

    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    // Bound issuance: supersede prior active tokens and cap rows per user
    // so token rows cannot accumulate without limit.
    await pool.query('DELETE FROM passwordless_tokens WHERE user_id = $1 AND (used = true OR expires_at <= NOW())', [user.id]);
    await pool.query(
      `DELETE FROM passwordless_tokens WHERE user_id = $1 AND id NOT IN (
         SELECT id FROM passwordless_tokens WHERE user_id = $1 ORDER BY created_at DESC LIMIT 4
       )`,
      [user.id]
    );
    await pool.query(
      'INSERT INTO passwordless_tokens (token_hash, user_id, email, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, user.id, normalizedEmail, expiresAt]
    );

    await sendAuditEvent('auth.passwordless_requested', user.id, normalizedEmail, { found: true });

    res.json({
      message: neutralMessage
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to generate magic link' });
  }
});

app.post('/auth/passwordless/verify', createUserRateLimiter('passwordless_verify', 10), async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ message: 'Token is required' });
    }

    const tokenHash = hashToken(token);
    // Atomic consumption: a single UPDATE with the guard in the WHERE
    // clause, so two concurrent submissions cannot both pass the check.
    const result = await pool.query(
      'UPDATE passwordless_tokens SET used = true WHERE token_hash = $1 AND used = false AND expires_at > NOW() RETURNING *',
      [tokenHash]
    );

    if (!result.rows[0]) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [result.rows[0].user_id]);
    const user = userResult.rows[0];

    if (!user || !user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const { sessionId, accessToken } = await issueLoginSession(user, req, res);

    await sendAuditEvent('auth.passwordless_login', user.id, user.email, {
      session_id: sessionId
    });

    res.json({
      message: 'Logged in successfully',
      token: accessToken,
      session_id: sessionId,
      user: sanitizeUser(user)
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Magic link verification failed' });
  }
});

// Request a password reset. Always returns 200 with a generic message so
// callers cannot enumerate accounts. The raw token is emailed via the
// email sender abstraction and only the SHA-256 hash is stored.
app.post('/auth/password/reset-request', createUserRateLimiter('password_reset_request', 5), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ message: 'Email is required' });
    }

    const emailError = validateEmail(email);
    if (emailError) {
      return res.status(400).json({ message: emailError });
    }
    const normalizedEmail = normalizeEmail(email);
    const genericMessage = 'If an account exists for this email, a reset link has been sent.';
    const frontendUrl = getFrontendUrl();
    if (!frontendUrl) {
      return res.status(503).json({ message: 'Password reset is not configured (FRONTEND_URL missing)' });
    }

    const userResult = await pool.query('SELECT id, email, active FROM users WHERE email = $1', [normalizedEmail]);
    const user = userResult.rows[0];

    if (!user || !user.active) {
      await sendAuditEvent('auth.password_reset_requested', user?.id || null, normalizedEmail, { found: false });
      return res.json({ message: genericMessage });
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1 OR expires_at <= NOW()', [user.id]);
    await pool.query(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, expiresAt]
    );

    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;
    await sendPasswordResetEmail(user.email, rawToken, resetUrl);
    await sendAuditEvent('auth.password_reset_requested', user.id, user.email, { found: true });

    const response = { message: genericMessage };
    return res.json(response);
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to process reset request' });
  }
});

// Complete a password reset with a single-use token. Revokes all sessions
// on success so stolen tokens cannot be reused.
app.post('/auth/password/reset', createUserRateLimiter('password_reset', 10), async (req, res) => {
  try {
    const { token, password, new_password } = req.body;
    const newPassword = password || new_password;
    if (!token || !newPassword) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    const tokenHash = hashToken(String(token).trim());
    // Atomic consumption: single UPDATE with the guard, so concurrent
    // submissions cannot both redeem one single-use token.
    const tokenResult = await pool.query(
      'UPDATE password_reset_tokens SET used = true WHERE token_hash = $1 AND used = false AND expires_at > NOW() RETURNING *',
      [tokenHash]
    );
    const resetRow = tokenResult.rows[0];
    if (!resetRow) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [resetRow.user_id]);
    const user = userResult.rows[0];
    if (!user) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }
    if (!user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    // The token names the user, so the policy comes from the user's tenant -
    // never from anything the caller supplied.
    const policy = await getPasswordPolicyForTenant(user.tenant_id || 'default');
    const passwordError = validatePassword(newPassword, policy);
    if (passwordError) {
      return res.status(400).json({ message: passwordError, field: 'password' });
    }
    const historyError = await enforcePasswordHistory(user.id, newPassword, policy.history_count);
    if (historyError) {
      return res.status(400).json({ message: historyError, field: 'password' });
    }

    await setUserPassword(user.id, newPassword);
    await pool.query('UPDATE password_reset_tokens SET used = true WHERE token_hash = $1', [tokenHash]);
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND token_hash != $2', [user.id, tokenHash]);

    await revokeAllUserSessions(user.id);
    await clearFailedAttempts(user.email);
    await sendAuditEvent('auth.password_reset', user.id, user.email, {});

    return res.json({ message: 'Password has been reset successfully' });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Password reset failed' });
  }
});

// Admin-only reset for SCIM provisioned or locked-out accounts.
app.post('/auth/admin/password-reset', requireRole('admin'), createUserRateLimiter('admin_password_reset', 20), async (req, res) => {
  try {
    const { email, user_id, userId, password, new_password } = req.body;
    const targetEmail = email;
    const targetId = user_id || userId;
    const newPassword = password || new_password;
    if ((!targetEmail && !targetId) || !newPassword) {
      return res.status(400).json({ message: 'Target email or user_id and a new password are required' });
    }

    const lookup = targetId
      ? await pool.query('SELECT * FROM users WHERE id = $1', [targetId])
      : await pool.query('SELECT * FROM users WHERE email = $1', [targetEmail]);

    const user = lookup.rows[0];
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const policy = await getPasswordPolicyForTenant(user.tenant_id || 'default');
    const passwordError = validatePassword(newPassword, policy);
    if (passwordError) {
      return res.status(400).json({ message: passwordError, field: 'password' });
    }
    const historyError = await enforcePasswordHistory(user.id, newPassword, policy.history_count);
    if (historyError) {
      return res.status(400).json({ message: historyError, field: 'password' });
    }

    await setUserPassword(user.id, newPassword);
    await pool.query('DELETE FROM password_reset_tokens WHERE user_id = $1', [user.id]);

    await revokeAllUserSessions(user.id);
    await clearFailedAttempts(user.email);
    await sendAuditEvent('auth.admin_password_reset', user.id, user.email, { admin_id: req.user.id });

    return res.json({ message: 'Password reset successfully', user: sanitizeUser({ ...user }) });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Admin password reset failed' });
  }
});

// Admin policy surface: tenants opt up from the secure defaults here. The
// policy always applies to the caller's verified tenant claim.
app.get('/auth/admin/password-policy', requireRole('admin'), createUserRateLimiter('password_policy_read', 60), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id || 'default';
    const stored = await pool.query('SELECT * FROM password_policies WHERE tenant_id = $1', [tenantId]);
    res.json({
      tenant_id: tenantId,
      configured: stored.rows.length > 0,
      policy: stored.rows[0] ? clampPasswordPolicy(stored.rows[0]) : { ...DEFAULT_PASSWORD_POLICY },
      hard_floor_min_length: PASSWORD_HARD_FLOOR,
      history_max_retention: PASSWORD_HISTORY_MAX_RETENTION,
      max_age_days_cap: PASSWORD_MAX_AGE_DAYS_CAP,
      denylist_version: COMMON_PASSWORD_LIST_VERSION,
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to load password policy' });
  }
});

app.put('/auth/admin/password-policy', requireRole('admin'), createUserRateLimiter('password_policy_update', 20), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id || 'default';
    const body = req.body || {};
    const allowedFields = ['min_length', 'require_upper', 'require_lower', 'require_digit', 'require_symbol', 'history_count', 'max_age_days'];
    const unknownFields = Object.keys(body).filter((key) => !allowedFields.includes(key));
    if (unknownFields.length > 0) {
      return res.status(400).json({
        message: `Unknown password policy field: ${unknownFields[0]}`,
        field: unknownFields[0]
      });
    }
    const fieldErrors = validatePasswordPolicyInput(body);
    if (fieldErrors) {
      const firstField = Object.keys(fieldErrors)[0];
      return res.status(400).json({ message: fieldErrors[firstField], field: firstField, errors: fieldErrors });
    }

    const current = await pool.query('SELECT * FROM password_policies WHERE tenant_id = $1', [tenantId]);
    const merged = { ...(current.rows[0] || DEFAULT_PASSWORD_POLICY), ...body };
    const policy = clampPasswordPolicy(merged);

    const result = await pool.query(
      `INSERT INTO password_policies
         (tenant_id, min_length, require_upper, require_lower, require_digit, require_symbol, history_count, max_age_days, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (tenant_id) DO UPDATE SET
         min_length = $2, require_upper = $3, require_lower = $4, require_digit = $5,
         require_symbol = $6, history_count = $7, max_age_days = $8, updated_at = NOW()
       RETURNING *`,
      [tenantId, policy.min_length, policy.require_upper, policy.require_lower, policy.require_digit,
       policy.require_symbol, policy.history_count, policy.max_age_days]
    );

    await sendAuditEvent('auth.password_policy_updated', req.user.id, req.user.email, {
      tenant_id: tenantId,
      policy: clampPasswordPolicy(result.rows[0]),
    });

    res.json({
      tenant_id: tenantId,
      configured: true,
      policy: clampPasswordPolicy(result.rows[0]),
      hard_floor_min_length: PASSWORD_HARD_FLOOR,
      denylist_version: COMMON_PASSWORD_LIST_VERSION,
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to update password policy' });
  }
});

// Admin-only scoped API key surface. The plaintext key is returned exactly
// once at creation and never logged or stored.
app.post('/auth/admin/api-keys', requireRole('admin'), createUserRateLimiter('api_key_issue', 20), async (req, res) => {
  try {
    const { label, scopes, expires_in_days } = req.body || {};
    if (!label || typeof label !== 'string' || !label.trim() || label.trim().length > 120) {
      return res.status(400).json({ message: 'label is required (max 120 characters)', field: 'label' });
    }
    const scopeError = validateApiKeyScopes(scopes);
    if (scopeError) {
      return res.status(400).json({ message: scopeError, field: 'scopes' });
    }
    let expiresInDays = API_KEY_DEFAULT_EXPIRY_DAYS;
    if (expires_in_days !== undefined && expires_in_days !== null) {
      if (!Number.isInteger(expires_in_days) || expires_in_days < 1 || expires_in_days > API_KEY_MAX_EXPIRY_DAYS) {
        return res.status(400).json({
          message: `expires_in_days must be an integer between 1 and ${API_KEY_MAX_EXPIRY_DAYS}`,
          field: 'expires_in_days'
        });
      }
      expiresInDays = expires_in_days;
    }

    const tenantId = req.user.tenant_id || 'default';
    const uniqueScopes = [...new Set(scopes)];
    const { keyId, secret, apiKey } = generateApiKey();
    const keyHash = await bcrypt.hash(secret, BCRYPT_COST);
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO api_keys (key_id, key_hash, label, scopes, tenant_id, created_by, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       RETURNING id, key_id, label, scopes, tenant_id, created_at, expires_at`,
      [keyId, keyHash, label.trim(), JSON.stringify(uniqueScopes), tenantId, req.user.id, expiresAt]
    );

    await sendAuditEvent('auth.api_key_issued', req.user.id, req.user.email, {
      key_id: keyId,
      label: label.trim(),
      scopes: uniqueScopes,
      tenant_id: tenantId,
      expires_at: expiresAt.toISOString()
    });

    res.status(201).json({
      message: 'API key created. Store it now; it will never be shown again.',
      api_key: apiKey,
      key: result.rows[0]
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to create API key' });
  }
});

app.get('/auth/admin/api-keys', requireRole('admin'), createUserRateLimiter('api_key_list', 60), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id || 'default';
    const result = await pool.query(
      `SELECT key_id, label, scopes, tenant_id, created_by, created_at, expires_at, revoked_at, last_used_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId]
    );
    res.json({ api_keys: result.rows });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to list API keys' });
  }
});

app.delete('/auth/admin/api-keys/:keyId', requireRole('admin'), createUserRateLimiter('api_key_revoke', 20), async (req, res) => {
  try {
    const keyId = String(req.params.keyId || '');
    if (!/^[0-9a-f]{16}$/.test(keyId)) {
      return res.status(400).json({ message: 'Invalid key id' });
    }
    const tenantId = req.user.tenant_id || 'default';
    const result = await pool.query(
      `UPDATE api_keys SET revoked_at = NOW(), revoked_by = $1
       WHERE key_id = $2 AND tenant_id = $3 AND revoked_at IS NULL
       RETURNING key_id, label, scopes, revoked_at`,
      [req.user.id, keyId, tenantId]
    );
    if (!result.rows[0]) {
      const existing = await pool.query(
        'SELECT key_id, revoked_at FROM api_keys WHERE key_id = $1 AND tenant_id = $2',
        [keyId, tenantId]
      );
      if (!existing.rows[0]) {
        return res.status(404).json({ message: 'API key not found' });
      }
      return res.json({ message: 'API key was already revoked', revoked_at: existing.rows[0].revoked_at });
    }

    await sendAuditEvent('auth.api_key_revoked', req.user.id, req.user.email, {
      key_id: keyId,
      label: result.rows[0].label,
      scopes: result.rows[0].scopes,
      tenant_id: tenantId
    });

    res.json({
      message: 'API key revoked',
      key_id: keyId,
      revoked_at: result.rows[0].revoked_at
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to revoke API key' });
  }
});

// Internal identity lookup used by the api-gateway to map a Slack workspace
// user to an Atlas user for slash commands and interactive approvals. Requires
// the internal service token (x-internal-auth, same trust as gateway-to-service
// calls); the tenant comes from the token claims, never from query input, so a
// caller scoped to one workspace cannot read identities from another. Returns a
// minimal non-sensitive projection: id, email, name, role, tenant.
app.get('/internal/atlas-user', (req, res) => {
  const token = req.headers['x-internal-auth'];
  if (!token) {
    return res.status(401).json({ message: 'Internal authentication required' });
  }
  let claims;
  try {
    claims = jwt.verify(token, INTERNAL_JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    safeLog(console.warn, 'Internal atlas-user lookup rejected:', err.message);
    return res.status(401).json({ message: 'Invalid internal token' });
  }

  const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
  if (!/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email)) {
    return res.status(400).json({ message: 'A valid email is required' });
  }
  const tenantId = typeof claims.tenant_id === 'string' && claims.tenant_id.trim() ? claims.tenant_id.trim() : 'default';

  pool
    .query(
      'SELECT id, email, name, role, tenant_id, active FROM users WHERE email = $1 AND tenant_id = $2 LIMIT 1',
      [email, tenantId]
    )
    .then(({ rows }) => {
      if (rows.length === 0 || rows[0].active === false) {
        return res.status(404).json({ message: 'No matching Atlas user in this workspace' });
      }
      const row = rows[0];
      return res.json({
        id: row.id,
        email: row.email,
        name: row.name,
        role: row.role,
        tenant_id: row.tenant_id || tenantId
      });
    })
    .catch((err) => {
      safeLog(console.error, 'Request failed', err);
      res.status(500).json({ message: 'Internal user lookup failed' });
    });
});

app.get('/sessions', requireRole(), createUserRateLimiter('sessions_list', 60), async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const result = await pool.query(
      'SELECT id, ip_address, user_agent, device_id, is_active, created_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    res.json(result.rows);
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to list sessions' });
  }
});

app.delete('/sessions/:id', requireRole(), createUserRateLimiter('session_revoke', 20), async (req, res) => {
  try {
    const userId = req.user.id;
    if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(req.params.id)) {
      return res.status(400).json({ message: 'Invalid session id' });
    }
    const result = await pool.query(
      'UPDATE sessions SET is_active = false WHERE id = $1::uuid AND user_id = $2 RETURNING token_hash',
      [req.params.id, userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Session not found' });
    }
    // Also delete the refresh token that belongs to this session so it cannot be used to refresh
    const tokenHash = result.rows[0].token_hash;
    if (tokenHash) {
      await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
      await pool.query('DELETE FROM rotated_tokens WHERE token_hash = $1', [tokenHash]);
      // Optionally denylist any access tokens from this session via Redis (handled by gateway)
      if (redisClient.isOpen) {
        const accessJtiKey = `denylist:sid:${req.params.id}`;
        await redisClient.set(accessJtiKey, '1', { EX: 15 * 60 });
      }
    }
    // If the request supplied an access token, denylist its jti as well
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && redisClient.isOpen) {
      try {
        const token = authHeader.slice(7);
        const payload = jwt.decode(token);
        if (payload && payload.jti) {
          await redisClient.set(`denylist:jti:${payload.jti}`, '1', { EX: 15 * 60 });
        }
        if (payload && payload.sid) {
          await redisClient.set(`denylist:sid:${payload.sid}`, '1', { EX: 15 * 60 });
        }
      } catch {}
    }
    res.json({ message: 'Session revoked' });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to revoke session' });
  }
});

app.delete('/sessions', requireRole(), createUserRateLimiter('sessions_revoke_all', 20), async (req, res) => {
  try {
    const userId = req.user.id;
    const currentSessionId = req.headers['x-session-id'];

    let revokedHashes = [];
    if (currentSessionId) {
      if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(currentSessionId)) {
        return res.status(400).json({ message: 'Invalid session id' });
      }
      const resQ = await pool.query(
        'UPDATE sessions SET is_active = false WHERE user_id = $1 AND id != $2::uuid RETURNING token_hash',
        [userId, currentSessionId]
      );
      revokedHashes = resQ.rows.map(r => r.token_hash).filter(Boolean);
    } else {
      const resQ = await pool.query(
        'UPDATE sessions SET is_active = false WHERE user_id = $1 RETURNING token_hash',
        [userId]
      );
      revokedHashes = resQ.rows.map(r => r.token_hash).filter(Boolean);
    }
    // Delete refresh tokens for the revoked sessions
    for (const th of revokedHashes) {
      await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [th]);
      await pool.query('DELETE FROM rotated_tokens WHERE token_hash = $1', [th]);
      if (redisClient.isOpen) {
        // Find session id for this hash to denylist sid
        const sidRes = await pool.query('SELECT id FROM sessions WHERE token_hash = $1', [th]);
        const sid = sidRes.rows[0]?.id;
        if (sid) await redisClient.set(`denylist:sid:${sid}`, '1', { EX: 15 * 60 });
      }
    }
    // Also denylist the current access token's jti/sid if provided
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ') && redisClient.isOpen) {
      try {
        const token = authHeader.slice(7);
        const payload = jwt.decode(token);
        if (payload && payload.jti) await redisClient.set(`denylist:jti:${payload.jti}`, '1', { EX: 15 * 60 });
      } catch {}
    }

    await sendAuditEvent('auth.sessions_revoked', userId, req.user.email, {
      except_session_id: currentSessionId
    });

    res.json({ message: 'Other sessions revoked' });
  } catch (error) {
    safeLog(console.error, 'Request failed', error);
    res.status(500).json({ message: 'Failed to revoke sessions' });
  }
});

// ── WebAuthn / Hardware Security Keys ──────────────────────────────────────

const RP_NAME = 'Atlas Workforce';

function getRpId(req) {
  return process.env.WEBAUTHN_RP_ID || req.hostname || 'localhost';
}

function base64urlToBuffer(base64url) {
  let s = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function base64urlToBase64(base64url) {
  return base64urlToBuffer(base64url).toString('base64');
}

const WEBAUTHN_CHALLENGE_TTL_MINUTES = 5;

async function storeWebauthnChallenge(userId, challenge, purpose) {
  await pool.query(`DELETE FROM webauthn_challenges WHERE expires_at <= NOW()`);
  await pool.query(
    `INSERT INTO webauthn_challenges (user_id, challenge, purpose, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' minutes')::INTERVAL)
     ON CONFLICT (challenge) DO UPDATE SET user_id = EXCLUDED.user_id, purpose = EXCLUDED.purpose, expires_at = EXCLUDED.expires_at, created_at = NOW()`,
    [userId, challenge, purpose, String(WEBAUTHN_CHALLENGE_TTL_MINUTES)]
  );
}

async function storeChallenge(userId, challenge, purpose = 'registration') {
  return storeWebauthnChallenge(userId, challenge, purpose);
}

async function getLatestWebauthnChallenge(userId, purpose) {
  const result = await pool.query(
    `SELECT challenge FROM webauthn_challenges
     WHERE user_id = $1 AND purpose = $2 AND expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [userId, purpose]
  );
  if (result.rows[0]) return result.rows[0].challenge;
  // Fallback for in-flight challenges created before the migration.
  const legacy = await pool.query(
    `SELECT public_key AS challenge FROM webauthn_credentials
     WHERE user_id = $1 AND credential_id LIKE 'challenge:%' AND device_name = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return legacy.rows[0] ? legacy.rows[0].challenge : null;
}

async function consumeWebauthnChallenge(userId, purpose) {
  await pool.query(`DELETE FROM webauthn_challenges WHERE user_id = $1 AND purpose = $2`, [userId, purpose]);
  await pool.query(`DELETE FROM webauthn_credentials WHERE user_id = $1 AND credential_id LIKE 'challenge:%'`, [userId]);
}

async function consumeChallenge(userId, challenge) {
  const result = await pool.query(
    'DELETE FROM webauthn_challenges WHERE user_id = $1 AND challenge = $2 RETURNING id',
    [userId, challenge]
  );
  if (result.rowCount > 0) return true;
  const legacy = await pool.query(
    'DELETE FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2 RETURNING id',
    [userId, `challenge:${challenge}`]
  );
  return legacy.rowCount > 0;
}

app.post('/webauthn/register/begin', requireRole(), createUserRateLimiter('webauthn_register', 10), async (req, res) => {
  try {
    const userId = req.user.id;
    const { device_name, device_type } = req.body;

    const userResult = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    const existing = await pool.query(
      "SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND is_active = true AND credential_id NOT LIKE 'challenge:%'",
      [userId]
    );

    const options = generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: getRpId(req),
      userName: user.email,
      userDisplayName: user.name || user.email,
      excludeCredentials: existing.rows.map(r => ({
        id: r.credential_id,
        type: 'public-key',
      })),
    });

    await storeWebauthnChallenge(userId, options.challenge, 'registration');

    res.json({
      status: 'ok',
      creationOptions: options,
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'WebAuthn registration initiation failed' });
  }
});

app.post('/webauthn/register/complete', requireRole(), createUserRateLimiter('webauthn_register_complete', 10), async (req, res) => {
  try {
    const userId = req.user.id;
    const { device_name, device_type } = req.body;
    const credential = req.body;

    if (!credential || !credential.response || !credential.id) {
      return res.status(400).json({ message: 'Invalid credential response' });
    }

    const expectedChallenge = await getLatestWebauthnChallenge(userId, 'registration');

    if (!expectedChallenge) {
      return res.status(400).json({ message: 'No pending registration challenge found. Please start registration again.' });
    }

    const verification = await verifyRegistrationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || `http://${req.hostname || 'localhost'}:3000`,
      expectedRPID: getRpId(req),
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ message: 'Registration verification failed' });
    }

    const { credentialPublicKey, credentialID, counter } = verification.registrationInfo;

    await consumeWebauthnChallenge(userId, 'registration');

    const storedCredentialId = Buffer.from(credentialID).toString('base64');
    const storedPublicKey = Buffer.from(credentialPublicKey).toString('base64');

    await pool.query(
      `INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, device_name, device_type, transports, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, true)`,
      [
        userId,
        storedCredentialId,
        storedPublicKey,
        counter,
        device_name || 'Security Key',
        device_type || 'hardware',
        JSON.stringify(credential.response.transports || []),
      ]
    );

    await sendAuditEvent('auth.webauthn_registered', userId, req.user.email, {
      device_name: device_name || 'Security Key',
      credential_id: credentialID.toString('base64').substring(0, 20) + '...',
    });

    res.json({ status: 'ok', message: 'Hardware security key registered' });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'WebAuthn registration completion failed' });
  }
});

app.post('/webauthn/authenticate/begin', createUserRateLimiter('webauthn_auth', 10, 15 * 60 * 1000, { keyByEmail: true }), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userResult = await pool.query('SELECT id FROM users WHERE email = $1 AND active = true', [email]);
    if (!userResult.rows[0]) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userId = userResult.rows[0].id;
    const credentials = await pool.query(
      "SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND is_active = true AND credential_id NOT LIKE 'challenge:%'",
      [userId]
    );

    if (credentials.rows.length === 0) {
      return res.status(400).json({ message: 'No hardware security keys registered for this user' });
    }

    const options = generateAuthenticationOptions({
      rpID: getRpId(req),
      allowCredentials: credentials.rows.map(c => ({
        id: Buffer.from(c.credential_id, 'base64'),
        type: 'public-key',
      })),
      userVerification: 'preferred',
    });

    await storeWebauthnChallenge(userId, options.challenge, 'authentication');

    res.json({
      status: 'ok',
      authenticationOptions: options,
      userId,
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'WebAuthn authentication initiation failed' });
  }
});

app.post('/webauthn/authenticate/complete', createUserRateLimiter('webauthn_auth', 10), async (req, res) => {
  try {
    const credential = req.body;

    if (!credential || !credential.id || !credential.response || !credential.response.signature) {
      return res.status(400).json({ message: 'Invalid authentication response' });
    }

    const credId = base64urlToBase64(credential.id);

    const credResult = await pool.query(
      "SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND is_active = true AND credential_id NOT LIKE 'challenge:%'",
      [credId]
    );

    if (!credResult.rows[0]) {
      return res.status(400).json({ message: 'Credential not found' });
    }

    const cred = credResult.rows[0];

    const expectedChallenge = await getLatestWebauthnChallenge(cred.user_id, 'authentication');

    if (!expectedChallenge) {
      return res.status(400).json({ message: 'No pending authentication challenge. Please start authentication again.' });
    }

    const verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge,
      expectedOrigin: process.env.WEBAUTHN_ORIGIN || `http://${req.hostname || 'localhost'}:3000`,
      expectedRPID: getRpId(req),
      credential: {
        id: Buffer.from(cred.credential_id, 'base64'),
        publicKey: Buffer.from(cred.public_key, 'base64'),
        counter: cred.counter,
        transports: cred.transports || [],
      },
    });

    if (!verification.verified) {
      return res.status(400).json({ message: 'Authentication verification failed' });
    }

    await pool.query(
      'UPDATE webauthn_credentials SET counter = $1, last_used_at = NOW() WHERE id = $2',
      [verification.authenticationInfo.newCounter, cred.id]
    );

    await consumeWebauthnChallenge(cred.user_id, 'authentication');

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [cred.user_id]);
    const user = userResult.rows[0];

    if (!user || !user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const { sessionId, accessToken: token } = await issueLoginSession(user, req, res);

    await sendAuditEvent('auth.webauthn_login', user.id, user.email, {
      credential_id: credId.substring(0, 20) + '...',
      session_id: sessionId,
    });

    res.json({
      message: 'Hardware security key authentication successful',
      token,
      session_id: sessionId,
      user: sanitizeUser(user),
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'WebAuthn authentication completion failed' });
  }
});

app.get('/webauthn/credentials', requireRole(), createUserRateLimiter('webauthn_list', 60), async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const result = await pool.query(
      "SELECT id, credential_id, device_name, device_type, counter, is_active, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 AND credential_id NOT LIKE 'challenge:%' ORDER BY created_at DESC LIMIT $2 OFFSET $3",
      [userId, limit, offset]
    );
    res.json(result.rows.map(r => ({
      ...r,
      credential_id: r.credential_id.substring(0, 20) + '...',
    })));
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to list credentials' });
  }
});

app.delete('/webauthn/credentials/:id', requireRole(), createUserRateLimiter('webauthn_delete', 20), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      "DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 AND is_active = true AND credential_id NOT LIKE 'challenge:%' RETURNING id",
      [parseInt(req.params.id), userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Credential not found' });
    }
    await sendAuditEvent('auth.webauthn_removed', userId, req.user.email);
    res.json({ message: 'Security key removed' });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to remove credential' });
  }
});

// ── OAuth Enterprise Login ─────────────────────────────────────────────────

app.get('/oauth/providers', requireRole('admin'), createUserRateLimiter('oauth_providers_list', 60), async (req, res) => {
  try {
    const tenantId = req.user.tenant_id || 'default';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const result = await pool.query(
      'SELECT id, provider, client_id, redirect_uri, scopes, enabled, tenant_id FROM oauth_providers WHERE tenant_id = $1 ORDER BY provider LIMIT $2 OFFSET $3',
      [tenantId, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to list OAuth providers' });
  }
});

app.post('/oauth/providers', requireRole('admin'), createUserRateLimiter('oauth_providers_create', 20), async (req, res) => {
  try {
    const { provider, client_id, client_secret, redirect_uri, scopes } = req.body;
    const tenantId = req.user.tenant_id || 'default';
    if (!provider || !client_id || !client_secret) {
      return res.status(400).json({ message: 'provider, client_id, client_secret are required' });
    }
    const encryptedSecret = encryptOAuthSecret(client_secret);
    const result = await pool.query(
      `INSERT INTO oauth_providers (provider, client_id, client_secret, redirect_uri, scopes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, provider, client_id, redirect_uri, scopes, enabled, tenant_id`,
      [provider, client_id, encryptedSecret, redirect_uri || '', scopes || 'openid email profile', tenantId]
    );
    await sendAuditEvent('auth.oauth_provider_created', req.user.id, req.user.email, { provider, tenant_id: tenantId });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Provider already configured for this tenant' });
    }
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to create OAuth provider' });
  }
});

app.post('/oauth/login/:provider', createUserRateLimiter('oauth_login', 20), async (req, res) => {
  try {
    const { provider } = req.params;
    const { tenant_id } = req.body;
    if (!['google', 'microsoft', 'github', 'okta'].includes(provider)) {
      return res.status(400).json({ message: `Unsupported OAuth provider "${provider}"` });
    }
    const tenantId = tenant_id || 'default';
    const redirectTo = req.body.redirect_to || '/dashboard';

    const provResult = await pool.query(
      'SELECT * FROM oauth_providers WHERE provider = $1 AND tenant_id = $2 AND enabled = true',
      [provider, tenantId]
    );
    if (!provResult.rows[0]) {
      return res.status(404).json({ message: `OAuth provider "${provider}" not configured` });
    }

    const prov = provResult.rows[0];
    const state = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    // OIDC providers bind a nonce into the id_token; GitHub's plain OAuth2
    // flow has no nonce parameter.
    const nonce = ['google', 'microsoft', 'okta'].includes(provider)
      ? crypto.randomBytes(16).toString('hex')
      : null;

    await pool.query(
      'INSERT INTO oauth_states (state, provider, tenant_id, redirect_to, nonce, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [state, provider, tenantId, redirectTo, nonce, expiresAt]
    );

    const oktaBase = provider === 'okta' ? resolveOktaBaseUrl(prov.client_id) : null;
    if (provider === 'okta' && !oktaBase) {
      return res.status(400).json({ message: 'Invalid Okta client_id; expected <subdomain>.okta.com' });
    }
    const providerConfigs = {
      google: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        params: {
          client_id: prov.client_id,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          response_type: 'code',
          scope: prov.scopes || 'openid email profile',
          state,
          nonce,
          access_type: 'offline',
          prompt: 'consent',
        },
      },
      microsoft: {
        authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
        params: {
          client_id: prov.client_id,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          response_type: 'code',
          scope: prov.scopes || 'openid email profile',
          state,
          nonce,
        },
      },
      github: {
        authUrl: 'https://github.com/login/oauth/authorize',
        params: {
          client_id: prov.client_id,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          scope: 'read:user user:email',
          state,
        },
      },
      okta: {
        authUrl: `${oktaBase}/oauth2/v1/authorize`,
        params: {
          client_id: prov.client_id,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          response_type: 'code',
          scope: prov.scopes || 'openid email profile',
          state,
          nonce,
        },
      },
    };

    const config = providerConfigs[provider];
    if (!config) {
      return res.status(400).json({ message: `Unsupported OAuth provider "${provider}"` });
    }
    const params = new URLSearchParams(config.params);
    const redirectUrl = `${config.authUrl}?${params.toString()}`;

    res.json({
      redirect_url: redirectUrl,
      state,
      provider,
      nonce,
    });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'OAuth login initiation failed' });
  }
});

app.post('/oauth/callback/:provider', createUserRateLimiter('oauth_callback', 20), async (req, res) => {
  try {
    const { provider } = req.params;
    const { code, state } = req.body;
    if (!['google', 'microsoft', 'github', 'okta'].includes(provider)) {
      return res.status(400).json({ message: `Unsupported OAuth provider "${provider}"` });
    }

    if (!code || !state) {
      return res.status(400).json({ message: 'code and state are required' });
    }

    const stateResult = await pool.query(
      'SELECT * FROM oauth_states WHERE state = $1 AND provider = $2 AND expires_at > NOW()',
      [state, provider]
    );
    if (!stateResult.rows[0]) {
      return res.status(400).json({ message: 'Invalid or expired state parameter' });
    }

    const oauthState = stateResult.rows[0];
    await pool.query('DELETE FROM oauth_states WHERE state = $1', [state]);

    const provResult = await pool.query(
      'SELECT * FROM oauth_providers WHERE provider = $1 AND tenant_id = $2 AND enabled = true',
      [provider, oauthState.tenant_id]
    );
    if (!provResult.rows[0]) {
      return res.status(404).json({ message: 'Provider not found' });
    }

    const prov = provResult.rows[0];

    const oktaBaseForCallback = provider === 'okta' ? resolveOktaBaseUrl(prov.client_id) : null;
    if (provider === 'okta' && !oktaBaseForCallback) {
      return res.status(400).json({ message: 'Invalid Okta client_id; expected <subdomain>.okta.com' });
    }
    let tokenUrl, userInfoUrl, userInfoHeaders;
    const tokenConfigs = {
      google: {
        tokenUrl: 'https://oauth2.googleapis.com/token',
        userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
      },
      microsoft: {
        tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
      },
      github: {
        tokenUrl: 'https://github.com/login/oauth/access_token',
        userInfoUrl: 'https://api.github.com/user',
        userInfoHeaders: { Accept: 'application/json' },
      },
      okta: {
        tokenUrl: `${oktaBaseForCallback}/oauth2/v1/token`,
        userInfoUrl: `${oktaBaseForCallback}/oauth2/v1/userinfo`,
      },
    };

    const tokenConfig = tokenConfigs[provider];
    if (!tokenConfig) {
      return res.status(400).json({ message: `Unsupported OAuth provider "${provider}"` });
    }

    try {
      const clientSecret = isEncryptedOAuthSecret(prov.client_secret) ? decryptOAuthSecret(prov.client_secret) : prov.client_secret;
      const tokenResponse = await axios.post(
        tokenConfig.tokenUrl,
        new URLSearchParams({
          code,
          client_id: prov.client_id,
          client_secret: clientSecret,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          grant_type: 'authorization_code',
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000,
        }
      );

      const accessToken = tokenResponse.data.access_token;
      const idToken = tokenResponse.data.id_token;

      const userInfoResponse = await axios.get(tokenConfig.userInfoUrl, {
        headers: { Authorization: `Bearer ${accessToken}`, ...(tokenConfig.userInfoHeaders || {}) },
        timeout: 10000,
      });

      const userInfo = userInfoResponse.data;
      // No synthetic identities: an address derived from the login handle
      // would let an unverified account masquerade as a mailbox it does not
      // own. Every provider must return a real, provider-verified address.
      const rawEmail = userInfo.email || userInfo.mail || userInfo.userPrincipalName || '';
      let email = normalizeEmail(rawEmail);
      const name = userInfo.name || userInfo.displayName || userInfo.login || email || String(userInfo.sub || '');
      const providerUserId = String(userInfo.id || userInfo.sub || userInfo.login || '');
      if (!providerUserId) {
        return res.status(403).json({ message: 'Provider did not return a stable subject identifier' });
      }

      // id_token: claim checks (expiry, exact issuer, audience, nonce) then
      // signature verification against the provider JWKS. Fails closed, so a
      // discovery outage rejects the login instead of skipping the check.
      const idTokenValidation = await verifyOAuthIdToken(idToken, provider, prov, email, { nonce: oauthState.nonce });
      if (!idTokenValidation.valid) {
        return res.status(401).json({ message: 'OAuth id_token validation failed: ' + idTokenValidation.reason });
      }

      // GitHub exposes the authoritative verified address only via
      // /user/emails; the profile email is frequently private or unverified.
      // A verified address is mandatory - there is no synthetic fallback.
      if (provider === 'github') {
        let emailsData;
        try {
          const emailsRes = await axios.get('https://api.github.com/user/emails', {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            timeout: 5000,
          });
          emailsData = emailsRes.data;
        } catch (err) {
          return res.status(403).json({ message: 'GitHub email could not be verified' });
        }
        const emails = Array.isArray(emailsData) ? emailsData : [];
        const verifiedEmail = emails.find(function (entry) { return entry && entry.primary === true && entry.verified === true; })
          || emails.find(function (entry) { return entry && entry.verified === true; });
        if (!verifiedEmail || !verifiedEmail.email) {
          return res.status(403).json({ message: 'GitHub account has no verified email' });
        }
        email = normalizeEmail(verifiedEmail.email);
      }

      let emailVerifiedRaw = userInfo.email_verified;
      if (emailVerifiedRaw === undefined) emailVerifiedRaw = userInfo.verified;
      if (emailVerifiedRaw === undefined) emailVerifiedRaw = userInfo.verified_email;
      let emailVerified = emailVerifiedRaw;
      if (typeof emailVerified === 'string') emailVerified = emailVerified.toLowerCase() === 'true';

      if (['google', 'microsoft', 'okta'].includes(provider)) {
        const decoded = idToken ? jwt.decode(idToken) : null;
        const idTokenEmailVerified = decoded && (decoded.email_verified === true || decoded.email_verified === 'true');
        const verified = emailVerified === true || idTokenEmailVerified === true;
        if (!verified) {
          return res.status(403).json({ message: 'Email not verified by provider' });
        }
      }

      const emailError = validateEmail(email);
      if (emailError) {
        return res.status(403).json({ message: 'Verified email required for provisioning' });
      }

      let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      let userData;

      if (userResult.rows.length === 0) {
        const tempPassword = crypto.randomBytes(16).toString('hex');
        const hashedPass = await bcrypt.hash(tempPassword, BCRYPT_COST);
        userResult = await pool.query(
          'INSERT INTO users (email, password, name, tenant_id, password_changed_at) VALUES ($1, $2, $3, $4, NOW()) RETURNING *',
          [email, hashedPass, name, oauthState.tenant_id]
        );
        userData = userResult.rows[0];
      } else {
        userData = userResult.rows[0];
        if (userData.tenant_id && userData.tenant_id !== oauthState.tenant_id) {
          return res.status(403).json({ message: 'Email already registered in another tenant' });
        }
      }

      if (!userData.active) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      const encryptedAccessToken = accessToken ? encryptOAuthSecret(accessToken) : null;
      const encryptedRefreshToken = tokenResponse.data.refresh_token ? encryptOAuthSecret(tokenResponse.data.refresh_token) : null;
      await pool.query(
        `INSERT INTO oauth_links (user_id, provider, provider_user_id, access_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, provider_user_id) DO UPDATE SET access_token = $4, refresh_token = COALESCE($5, oauth_links.refresh_token), expires_at = $6`,
        [userData.id, provider, providerUserId, encryptedAccessToken, encryptedRefreshToken,
         tokenResponse.data.expires_in ? new Date(Date.now() + tokenResponse.data.expires_in * 1000) : null]
      );

      const { sessionId, accessToken: token } = await issueLoginSession(userData, req, res);

      await sendAuditEvent('auth.oauth_login', userData.id, email, { provider, session_id: sessionId });

      res.json({
        message: `OAuth ${provider} login successful`,
        token,
        session_id: sessionId,
        user: sanitizeUser(userData),
        provider,
      });
    } catch (oauthErr) {
      if (res.headersSent) return;
      // Never log upstream response bodies or error text: providers echo
      // request parameters (client secrets, codes, PII) in both. Log only a
      // static status bucket plus the provider name — no value derived from
      // the upstream response may reach the logs.
      const sc = oauthErr && oauthErr.response ? oauthErr.response.status : null;
      const statusClass = typeof sc === 'number' && sc >= 500 ? 'upstream-5xx' : 'upstream-4xx-or-unknown';
      console.error('OAuth token exchange error:', { provider, statusClass });
      res.status(502).json({ message: `OAuth ${provider} authentication failed` });
    }
  } catch (err) {
    if (res.headersSent) return;
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'OAuth callback processing failed' });
  }
});

app.get('/oauth/links', requireRole(), createUserRateLimiter('oauth_links_list', 60), async (req, res) => {
  try {
    const userId = req.user.id;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const result = await pool.query(
      'SELECT provider, provider_user_id, created_at FROM oauth_links WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [userId, limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to list OAuth links' });
  }
});

app.delete('/oauth/links/:provider', requireRole(), createUserRateLimiter('oauth_links_delete', 20), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'DELETE FROM oauth_links WHERE user_id = $1 AND provider = $2 RETURNING id',
      [userId, req.params.provider]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Link not found' });
    }
    res.json({ message: 'OAuth link disconnected' });
  } catch (err) {
    safeLog(console.error, 'Request failed', err);
    res.status(500).json({ message: 'Failed to remove OAuth link' });
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'Auth Service is healthy' });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', promClient.register.contentType);
  res.end(await promClient.register.metrics());
});

module.exports = {
  app,
  requireRole,
  requireScimAuth,
  pool,
  parseScimApiKeys,
  resolveScimTenant,
  isAllowedScimRole,
  isValidScimUserId,
  SCIM_TENANT_KEYS,
  generateApiKey,
  parseApiKeyFormat,
  validateApiKeyScopes,
  scimScopeForRequest,
  apiKeyHasScope,
  normalizeApiKeyScopes,
  apiKeyStateError,
  API_KEY_SCOPES,
  API_KEY_DEFAULT_EXPIRY_DAYS,
  API_KEY_MAX_EXPIRY_DAYS,
  storeWebauthnChallenge,
  getLatestWebauthnChallenge,
  consumeWebauthnChallenge,
  WEBAUTHN_CHALLENGE_TTL_MINUTES,
  normalizeEmail,
  validateEmail,
  validatePassword,
  clampPasswordPolicy,
  validatePasswordPolicyInput,
  isCommonPassword,
  isPasswordReused,
  enforcePasswordHistory,
  recordPasswordHistory,
  setUserPassword,
  passwordExpiryStatus,
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_HARD_FLOOR,
  PASSWORD_MIN_LENGTH_CAP,
  PASSWORD_HISTORY_MAX_RETENTION,
  COMMON_PASSWORD_LIST_VERSION,
  hashToken,
  rotateRefreshToken,
  revokeRefreshTokenForLogout,
  sanitizeUser,
  resolveOktaBaseUrl,
  generateSamlRequestId,
  buildSamlAuthnRequest,
  extractSamlInResponseTo,
  SAML_AUTHN_REQUEST_TTL_MINUTES,
  SAML_AUTHN_REQUEST_ID_PATTERN,
  SAML_TENANT_ID,
  getScimKeyId,
  requireCsrfDoubleSubmit,
  mintCsrfCookie,
  validateOAuthIdToken,
  authStoreUnavailable,
  storeMfaChallengeJti,
  mfaChallengeJtiExists,
  consumeMfaChallengeJti,
  issuerMatchesProvider,
  oidcDiscoveryUrlFor,
  computeCacheTtlMs,
  fetchDiscoveryDocument,
  normalizeJwksBundle,
  verifyIdTokenSignature,
  getSigningKeys,
  verifyOAuthIdTokenSignature,
  verifyOAuthIdToken,
  OIDC_DISCOVERY_DEFAULT_TTL_MS,
  OIDC_SIGNING_ALGORITHMS,
};

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Auth service running on port ${PORT}`);
  });
}
