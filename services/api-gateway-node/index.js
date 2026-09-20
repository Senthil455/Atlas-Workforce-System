require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { createProxyMiddleware } = require('http-proxy-middleware');
const redis = require('redis');
const axios = require('axios');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const dns = require('dns');
const { promisify } = require('util');
const promClient = require('prom-client');
const resolveDns = promisify(dns.resolve4);

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

const auditRetryQueueDepth = new promClient.Gauge({
  name: 'atlas_audit_retry_queue_depth',
  help: 'Depth of audit retry queue',
});

const auditRetryDlqDepth = new promClient.Gauge({
  name: 'atlas_audit_retry_dlq_depth',
  help: 'Depth of audit retry DLQ',
});

promClient.collectDefaultMetrics();

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const redisClient = redis.createClient({ url: REDIS_URL });

redisClient.on('error', (err) => console.log('Redis Client Error', err));
redisClient.on('connect', () => console.log('Connected to Redis successfully'));

(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Failed to connect to Redis, caching disabled:', err);
  }
})();

async function checkCache(req, res, next) {
  if (req.method !== 'GET') {
    return next();
  }

  if (req.path.startsWith('/api/live')) {
    return next();
  }

  if (!redisClient.isOpen) {
    return next();
  }

  const tenantId = req.user?.tenant_id || 'public';
  const role = req.user?.role || 'public';
  const userScope = req.user ? `${req.user.id}:${tenantId}:${role}` : 'public:public:public';
  const key = `cache:${userScope}:${req.originalUrl}`;
  const lockKey = `lock:${key}`;
  const maxRetries = 3;
  const retryDelays = [50, 100, 200];

  async function tryGetCache(attempt) {
    try {
      const cachedData = await redisClient.get(key);
      if (cachedData) {
        res.setHeader('X-Cache', 'HIT');
        res.setHeader('Content-Type', 'application/json');
        return res.send(cachedData);
      }

      const lockAcquired = await redisClient.set(lockKey, '1', { NX: true, EX: 5 });
      if (lockAcquired) {
        const originalSend = res.send.bind(res);
        res.send = function (body) {
          // Only cache successful 2xx responses; errors (4xx/5xx) must not be cached
          const status = res.statusCode;
          const cacheControl = res.getHeader('Cache-Control');
          const shouldCache = status >= 200 && status < 300 && cacheControl !== 'no-store';
          if (shouldCache) {
            redisClient.setEx(key, 300, typeof body === 'string' ? body : JSON.stringify(body)).catch(() => {});
          }
          redisClient.del(lockKey).catch(() => {});
          return originalSend(body);
        };
        return next();
      }

      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, retryDelays[attempt]));
        return tryGetCache(attempt + 1);
      }

      return next();
    } catch (err) {
      console.error('Cache error:', err);
      return next();
    }
  }

  return tryGetCache(0);
}

const app = express();
const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const INTERNAL_JWT_SECRET = process.env.INTERNAL_JWT_SECRET;
const AUDIT_INTERNAL_KEY = process.env.AUDIT_INTERNAL_KEY;
const AUDIT_SERVICE_URL = process.env.AUDIT_COMPLIANCE_SERVICE_URL || 'http://audit-compliance-service:8011';
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET || '';
const SLACK_WEBHOOK_SECRET = process.env.SLACK_WEBHOOK_SECRET || '';

if (!INTERNAL_JWT_SECRET) {
  console.error('FATAL: INTERNAL_JWT_SECRET is required');
  process.exit(1);
}

if (!AUDIT_INTERNAL_KEY) {
  console.error('FATAL: AUDIT_INTERNAL_KEY is required');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is required');
  process.exit(1);
}

// Refuse known default secrets in every environment (including development).
// The guard must not be conditional on NODE_ENV; otherwise docker-compose
// defaults make it inert and every `docker compose up` would run with
// forgeable secrets with zero warnings.
if (INTERNAL_JWT_SECRET === 'atlas-internal-jwt-secret-change-me' || JWT_SECRET === 'change-me-to-a-long-random-string') {
  console.error('FATAL: refusing to start with known default secrets (INTERNAL_JWT_SECRET / JWT_SECRET); set strong values via .env');
  process.exit(1);
}

const jwtSecret = JWT_SECRET;

const MFA_STEPUP_SECRET = process.env.MFA_STEPUP_SECRET || process.env.MFA_JWT_SECRET || JWT_SECRET;
if (MFA_STEPUP_SECRET === JWT_SECRET) {
  console.warn('WARNING: MFA_STEPUP_SECRET is not set or equals JWT_SECRET; step-up tokens share session secret - set a dedicated secret for production');
}
const MFA_STEPUP_AUD = 'mfa-step-up';
const MFA_STEPUP_ISS = 'atlas-auth';

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
app.use(cookieParser());
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
app.use(morgan('dev'));

const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests, please try again later' }
});
app.use(globalLimiter);

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

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many auth requests, please try again later' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts, please try again later' }
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many API requests, please try again later' }
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many requests to sensitive endpoints, please try again later' }
});

app.use('/api/auth', authLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth/register', authLimiter);

app.use('/api/payroll', sensitiveLimiter);
app.use('/api/compliance', sensitiveLimiter);
app.use('/api/audit', sensitiveLimiter);
app.use('/api/billing', sensitiveLimiter);

const services = {
  auth: process.env.AUTH_SERVICE_URL || 'http://auth-service:8010',
  employee: process.env.EMPLOYEE_SERVICE_URL || 'http://employee-service:8001',
  payroll: process.env.PAYROLL_SERVICE_URL || 'http://payroll-service:8002',
  analytics: process.env.ANALYTICS_SERVICE_URL || 'http://analytics-service:8003',
  notification:
    process.env.NOTIFICATION_SERVICE_URL || 'http://notification-service:8004',
  attendance:
    process.env.ATTENDANCE_SERVICE_URL || 'http://attendance-service:8005',
  leave:
    process.env.LEAVE_SERVICE_URL || 'http://leave-service:8006',
  ats: process.env.ATS_SERVICE_URL || 'http://ats-service:8012',
  lms: process.env.LMS_SERVICE_URL || 'http://lms-service:8013',
  performance:
    process.env.PERFORMANCE_SERVICE_URL || 'http://performance-service:8014',
  copilot:
    process.env.AI_COPILOT_SERVICE_URL || 'http://ai-copilot-service:8015',
  audit:
    process.env.AUDIT_COMPLIANCE_SERVICE_URL || 'http://audit-compliance-service:8011',
  compliance:
    process.env.AUDIT_COMPLIANCE_SERVICE_URL || 'http://audit-compliance-service:8011',
  integration:
    process.env.INTEGRATION_SERVICE_URL || 'http://integration-service:8016',
  lifecycle:
    process.env.EMPLOYEE_LIFECYCLE_SERVICE_URL || 'http://employee-lifecycle-service:8020',
  security:
    process.env.SECURITY_SERVICE_URL || 'http://security-service:8050',
  ai: process.env.AI_SERVICE_URL || 'http://ai-service:8065',
  live: process.env.LIVE_SERVICE_URL || 'http://live-service:8060',
  workforce:
    process.env.WORKFORCE_SERVICE_URL || 'http://workforce-planning-service:8017',
};

async function resolveServiceHostnames() {
  const hostnameCache = new Map();
  const TTL = 5 * 60 * 1000;
  for (const [name, url] of Object.entries(services)) {
    try {
      const hostname = new URL(url).hostname;
      if (!hostnameCache.has(hostname)) {
        const addresses = await resolveDns(hostname);
        if (addresses && addresses.length > 0) {
          hostnameCache.set(hostname, { ips: addresses, timestamp: Date.now() });
          console.log(`  DNS resolved ${hostname} → ${addresses[0]}`);
        }
      }
    } catch (err) {
      console.warn(`  DNS resolution failed for ${name}: ${err.code || err.message}`);
    }
  }
  return hostnameCache;
}

async function getServiceIp(hostname, cache) {
  const entry = cache.get(hostname);
  if (entry && Date.now() - entry.timestamp < 5 * 60 * 1000) {
    return entry.ips[0];
  }
  try {
    const addresses = await resolveDns(hostname);
    if (addresses && addresses.length > 0) {
      cache.set(hostname, { ips: addresses, timestamp: Date.now() });
      return addresses[0];
    }
  } catch {
    if (entry) return entry.ips[0];
  }
  return null;
}

async function startupHealthCheck() {
  console.log('Running upstream health checks...');
  const entries = Object.entries(services);
  const results = await Promise.allSettled(
    entries.map(([name, url]) => checkServiceHealth(url, name))
  );
  const failed = entries.filter((_, i) => results[i].status === 'fulfilled' && results[i].value === false);
  if (failed.length > 0) {
    console.warn(`Gateway started with ${failed.length} unreachable upstream(s): ${failed.map(([n]) => n).join(', ')}`);
  } else {
    console.log('All upstream services are reachable.');
  }
}

async function checkServiceHealth(url, label) {
  try {
    const resp = await axios.get(`${url}/health`, { timeout: 3000 });
    if (resp.status === 200) {
      console.log(`  ✓ ${label} reachable at ${url}`);
      return true;
    }
    console.warn(`  ⚠ ${label} at ${url} returned status ${resp.status}`);
    return false;
  } catch (err) {
    console.warn(`  ✗ ${label} unreachable at ${url}: ${err.code || err.message}`);
    const hostname = new URL(url).hostname;
    try {
      const altIp = await getServiceIp(hostname, hostnameCache);
      if (altIp) {
        const altUrl = url.replace(hostname, altIp);
        console.log(`  → Trying IP fallback for ${label}: ${altUrl}`);
        const resp = await axios.get(`${altUrl}/health`, { timeout: 3000, headers: { Host: hostname } });
        if (resp.status === 200) {
          console.log(`  ✓ ${label} reachable via IP fallback ${altIp}`);
          return true;
        }
      }
    } catch (fallbackErr) {
      console.warn(`  ✗ ${label} IP fallback also failed`);
    }
    return false;
  }
}

let hostnameCache = new Map();
(async () => {
  hostnameCache = await resolveServiceHostnames();
})();

startupHealthCheck();

const ALLOWED_WS_PATHS = new Set(['/ws', '/notification/ws']);

function isWsPath(pathname) {
  if (ALLOWED_WS_PATHS.has(pathname)) return true;
  if (pathname === '/api/live/ws' || pathname.startsWith('/api/live/ws/')) return true;
  return false;
}
const PUBLIC_AUTH_PATHS = ['/api/auth/login', '/api/auth/register'];

function isPublicPath(path) {
  if (path === '/health' || path === '/metrics') return true;
  return PUBLIC_AUTH_PATHS.some((p) => path === p || path.startsWith(p + '?'));
}

function deviceTrustHeaderMiddleware(req, res, next) {
  const deviceId = req.headers['x-device-id'];
  const deviceFingerprint = req.headers['x-device-fingerprint'];

  if (deviceId) {
    req.headers['x-device-id'] = deviceId;
  }
  if (deviceFingerprint) {
    req.headers['x-device-fingerprint'] = deviceFingerprint;
  }

  const sessionId = req.headers['x-session-id'];
  if (sessionId) {
    req.headers['x-session-id'] = sessionId;
  }

  next();
}

app.use(deviceTrustHeaderMiddleware);

function auditProxyMiddleware(req, res, next) {
  if (req.method === 'GET') {
    return next();
  }

  res.on('finish', () => {
    if (res.statusCode >= 400) {
      return;
    }

    const auditPayload = {
      event_type: `gateway.${req.method.toLowerCase()}`,
      path: req.path,
      method: req.method,
      user_id: req.user?.id || null,
      user_email: req.user?.email || null,
      user_role: req.user?.role || null,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      device_id: req.headers['x-device-id'] || null,
      session_id: req.headers['x-session-id'] || null,
      correlation_id: req.headers['x-correlation-id'] || null,
      status_code: res.statusCode,
      timestamp: new Date().toISOString(),
      service: 'api-gateway'
    };

    axios.post(`${AUDIT_SERVICE_URL}/api/v1/audit/log`, auditPayload, {
      headers: { 'X-Internal-Key': AUDIT_INTERNAL_KEY },
      timeout: 2000
    }).catch(err => {
      if (err.code !== 'ECONNREFUSED' && err.code !== 'ECONNABORTED') {
        console.error('Audit proxy error:', err.message);
      }
      enqueueAuditRetry(auditPayload);
    });
  });

  next();
}

const SENSITIVE_ROUTES = ['/api/payroll', '/api/compliance', '/api/audit'];

async function mfaStepUpMiddleware(req, res, next) {
  if (req.method === 'GET') {
    return next();
  }

  const isSensitive = SENSITIVE_ROUTES.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + '/')
  );

  if (!isSensitive) {
    return next();
  }

  const mfaToken = req.headers['x-mfa-token'];
  if (!mfaToken) {
    return res.status(403).json({
      message: 'MFA validation required for this resource',
      mfa_required: true,
      mfa_challenge_url: '/api/auth/mfa/challenge',
      detail: 'Please validate your identity with MFA before accessing sensitive resources'
    });
  }

  try {
    const payload = jwt.verify(mfaToken, MFA_STEPUP_SECRET, {
      algorithms: ['HS256'],
      audience: MFA_STEPUP_AUD,
      issuer: MFA_STEPUP_ISS,
    });

    if (!payload.mfa_validated || payload.purpose !== 'mfa_step_up') {
      return res.status(403).json({
        message: 'Invalid MFA token',
        mfa_required: true,
        detail: 'Step-up token missing required claims'
      });
    }

    const tokenUserId = String(payload.sub || payload.user_id || payload.id || '');
    const tokenTenantId = String(payload.tenant_id || payload.tenantId || 'default');
    const authedUserId = String(req.user?.id || '');
    const authedTenantId = String(req.user?.tenant_id || 'default');

    if (!authedUserId) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    if (!tokenUserId || tokenUserId !== authedUserId) {
      return res.status(403).json({
        message: 'MFA token does not belong to authenticated user',
        mfa_required: true,
        detail: 'Step-up token subject mismatch'
      });
    }

    if (tokenTenantId !== authedTenantId) {
      return res.status(403).json({
        message: 'MFA token tenant mismatch',
        mfa_required: true,
        detail: 'Step-up token tenant mismatch'
      });
    }

    const jti = payload.jti;
    if (!jti) {
      return res.status(403).json({
        message: 'MFA token missing jti',
        mfa_required: true,
        detail: 'Step-up token is not single-use'
      });
    }

    if (redisClient.isOpen) {
      const jtiKey = `mfa_jti:${jti}`;
      const exists = await redisClient.get(jtiKey);
      if (exists) {
        return res.status(403).json({
          message: 'MFA token already used',
          mfa_required: true,
          detail: 'Step-up token has been replayed'
        });
      }
      const expMs = payload.exp ? payload.exp * 1000 : Date.now() + 5 * 60 * 1000;
      const ttlSec = Math.max(1, Math.ceil((expMs - Date.now()) / 1000));
      try {
        await redisClient.set(jtiKey, '1', { EX: ttlSec, NX: true });
      } catch (e) {
        console.error('MFA jti store failed', e.message);
      }
    } else {
      console.warn('MFA jti replay check skipped - Redis not connected');
    }

    req.headers['x-mfa-validated'] = 'true';
    return next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(403).json({
        message: 'MFA token expired',
        mfa_required: true,
        detail: 'Step-up token expired, re-authenticate with MFA'
      });
    }
    if (err.name === 'JsonWebTokenError' || err.name === 'NotBeforeError') {
      return res.status(403).json({
        message: 'Invalid MFA token',
        mfa_required: true,
        detail: err.message
      });
    }
    console.error('MFA token verification failed', err.message);
    return res.status(403).json({
      message: 'MFA validation failed',
      mfa_required: true,
      detail: err.message
    });
  }
}

const PUBLIC_PREFIXES = [
  '/health',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/passwordless/request',
  '/api/auth/passwordless/verify',
  '/api/auth/saml/acs',
  '/api/auth/saml/login',
  '/api/auth/saml/metadata',
  '/saml/acs',
  '/saml/login',
  '/saml/metadata',
  '/api/webhooks/slack',
  '/api/auth/webauthn/authenticate/begin',
  '/api/auth/webauthn/authenticate/complete',
  '/api/auth/oauth/login',
  '/api/auth/oauth/callback',
];

function isPublicOrAuthPath(path) {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

async function authMiddleware(req, res, next) {
  if (isPublicOrAuthPath(req.path)) {
    return next();
  }

  const protectedPrefixes = [
    '/api/employee',
    '/api/payroll',
    '/api/analytics',
    '/api/notification',
    '/api/attendance',
    '/api/leave',
    '/api/ats',
    '/api/lms',
    '/api/performance',
    '/api/copilot',
    '/api/audit',
    '/api/compliance',
    '/api/integration',
    '/api/lifecycle',
    '/api/security',
    '/api/ai',
    '/api/billing',
    '/api/live',
    '/api/command-center',
    '/api/learning',
    '/api/workforce',
  ];

  const needsAuth = protectedPrefixes.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + '/')
  );

  if (!needsAuth) {
    return next();
  }

  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (req.path.startsWith('/api/live')) {
    try {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      token = url.searchParams.get('token');
    } catch {}
  }
  if (!token) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  let payload;
  try {
    payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      console.error('JWT auth failure: token expired for', req.path);
      return res.status(401).json({ message: 'Token expired' });
    }
    if (err.name === 'JsonWebTokenError') {
      console.error('JWT auth failure: invalid token for', req.path);
      return res.status(401).json({ message: 'Invalid token' });
    }
    if (err.name === 'NotBeforeError') {
      console.error('JWT auth failure: token not yet active for', req.path);
      return res.status(401).json({ message: 'Token not yet active' });
    }
    console.error('JWT auth failure: unknown error', err.message, 'for', req.path);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  // Check denylist for revoked sessions / logged-out tokens (added by auth-service on revoke/logout)
  if (redisClient.isOpen && payload) {
    try {
      const checks = [];
      if (payload.jti) checks.push(redisClient.get(`denylist:jti:${payload.jti}`).then(v => v ? 'jti' : null));
      if (payload.sid) checks.push(redisClient.get(`denylist:sid:${payload.sid}`).then(v => v ? 'sid' : null));
      if (checks.length) {
        const results = await Promise.all(checks);
        if (results.some(Boolean)) {
          console.error('JWT auth failure: token denylisted for', req.path, payload.jti || payload.sid);
          return res.status(401).json({ message: 'Session revoked' });
        }
      }
    } catch (e) {
      console.error('Denylist check failed, allowing request', e.message);
    }
  }

  req.user = payload;
  next();
}

app.use(authMiddleware);

function rbacMiddleware(req, res, next) {
  if (isPublicOrAuthPath(req.path)) {
    return next();
  }

  const role = req.user?.role || 'employee';
  const path = req.path;

  if (path.startsWith('/api/payroll') && !['admin', 'hr'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for payroll' });
  }

  if (path.startsWith('/api/analytics') && !['admin', 'manager', 'hr'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for analytics' });
  }

  if (path.startsWith('/api/employee') && req.method !== 'GET' && !['admin', 'hr'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges to modify employees' });
  }

  if (path.startsWith('/api/audit') && !['admin', 'auditor'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for audit' });
  }

  if (path.startsWith('/api/compliance') && !['admin', 'compliance', 'hr'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for compliance' });
  }

  if (path.startsWith('/api/security') && !['admin', 'compliance', 'auditor'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for security' });
  }

  if (path.startsWith('/api/billing') && !['admin', 'hr', 'manager'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for billing' });
  }

  if (path.startsWith('/api/command-center') && !['admin', 'manager', 'hr'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for command center' });
  }

  if (path.startsWith('/api/workforce') && !['admin', 'hr', 'manager'].includes(role)) {
    return res.status(403).json({ message: 'Forbidden: Insufficient privileges for workforce planning' });
  }

  next();
}

app.use(rbacMiddleware);

app.use(auditProxyMiddleware);
app.use(mfaStepUpMiddleware);

function csrfMiddleware(req, res, next) {
  if (isPublicOrAuthPath(req.path)) return next();

  // Refresh and logout are cookie-based and must not require double-submit
  const csrfExempt = ['/api/auth/refresh', '/api/auth/logout', '/api/auth/token'];
  if (csrfExempt.some((p) => req.path === p || req.path.startsWith(p + '/') || req.path.startsWith(p + '?'))) {
    return next();
  }

  if (req.user && !req.cookies?.csrf_token) {
    const csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('csrf_token', csrfToken, {
      httpOnly: false,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });
  }

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const cookieToken = req.cookies?.csrf_token;
  // Only enforce double-submit when a csrf cookie exists (browser session).
  // Clients without a cookie jar (curl, seed scripts, k6) will not be blocked.
  if (!cookieToken) {
    return next();
  }

  const headerToken = req.headers['x-csrf-token'];

  if (!headerToken || headerToken !== cookieToken) {
    return res.status(403).json({ message: 'CSRF token validation failed' });
  }

  next();
}

app.use(csrfMiddleware);

function cacheInvalidationMiddleware(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', async () => {
      if (res.statusCode < 400 && redisClient.isOpen) {
        const tenantId = req.user?.tenant_id || 'public';
        const userScope = req.user ? `${req.user.id}:${tenantId}:*` : `public:public:*`;
        const pattern = `cache:${userScope}:*`;
        try {
          let cursor = 0;
          do {
            const reply = await redisClient.scan(cursor, { MATCH: pattern, COUNT: 100 });
            cursor = reply.cursor;
            if (reply.keys.length > 0) {
              await redisClient.del(reply.keys);
            }
          } while (cursor !== 0);
        } catch (err) {
          console.error('Cache key scan error:', err);
        }
      }
    });
  }
  next();
}

app.use(cacheInvalidationMiddleware);

function verifySlackRequest(req) {
  const signature = req.headers['x-slack-signature'];
  const timestamp = req.headers['x-slack-request-timestamp'];

  if (SLACK_SIGNING_SECRET && signature && timestamp) {
    const ts = parseInt(String(timestamp), 10);
    if (Number.isNaN(ts)) {
      return { valid: false, reason: 'Invalid timestamp' };
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - ts) > 60 * 5) {
      return { valid: false, reason: 'Stale timestamp' };
    }
    const rawBody = req.rawBody || '';
    const baseString = `v0:${timestamp}:${rawBody}`;
    const hmac = crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString, 'utf8').digest('hex');
    const expected = `v0=${hmac}`;
    try {
      const sigBuf = Buffer.from(String(signature), 'utf8');
      const expBuf = Buffer.from(expected, 'utf8');
      if (sigBuf.length !== expBuf.length) {
        return { valid: false, reason: 'Invalid signature length' };
      }
      if (!crypto.timingSafeEqual(sigBuf, expBuf)) {
        return { valid: false, reason: 'Invalid signature' };
      }
      return { valid: true };
    } catch {
      return { valid: false, reason: 'Signature verification failed' };
    }
  }

  if (SLACK_WEBHOOK_SECRET) {
    const provided = req.headers['x-slack-webhook-secret'] || req.headers['x-webhook-secret'] || req.headers['x-internal-key'];
    if (provided) {
      try {
        const a = Buffer.from(String(provided), 'utf8');
        const b = Buffer.from(SLACK_WEBHOOK_SECRET, 'utf8');
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
          return { valid: true };
        }
      } catch {
        // fall through
      }
    }
  }

  return { valid: false, reason: 'Missing or invalid Slack signature' };
}

app.post('/api/webhooks/slack', express.urlencoded({
  extended: true,
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}), async (req, res) => {
  if (!SLACK_SIGNING_SECRET && !SLACK_WEBHOOK_SECRET) {
    if (NODE_ENV !== 'development') {
      console.error('Slack webhook rejected: no signing secret configured');
      return res.status(503).json({ response_type: 'ephemeral', text: 'Webhook not configured' });
    }
    console.warn('Slack webhook verification bypassed in development (no secret configured)');
  } else {
    const verification = verifySlackRequest(req);
    if (!verification.valid) {
      console.warn(`Slack webhook auth failed: ${verification.reason}`);
      return res.status(401).json({ response_type: 'ephemeral', text: 'Invalid webhook signature' });
    }
  }

  try {
    const { text, user_name } = req.body;

    const employeeId = user_name || 'slack_user';
    const tenantId = 'default';

    const parts = text ? text.split(' ') : [];
    if (parts.length < 3) {
      return res.json({
        response_type: "ephemeral",
        text: "Please use format: `/atlas-leave YYYY-MM-DD to YYYY-MM-DD Reason`"
      });
    }

    const startDate = parts[0];
    const endDate = parts[2];
    const leaveType = 'VACATION';
    const reason = parts.slice(3).join(' ') || 'Slack request';

    const leaveServiceUrl = `${services.leave}/request`;
    const response = await axios.post(leaveServiceUrl, {
      employeeId, startDate, endDate, leaveType, reason
    }, {
      headers: { 'X-Tenant-Id': tenantId }
    });

    return res.json({
      response_type: "in_channel",
      text: `Leave request submitted for ${startDate} to ${endDate}`
    });
  } catch (err) {
    console.error('Slack Webhook Error:', err.message);
    res.json({ response_type: "ephemeral", text: 'Failed to submit leave request. Please try again.' });
  }
});

app.post('/api/billing/create-checkout-session', express.json(), async (req, res) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }
    const tenantId = req.user.tenant_id;
    if (!tenantId) {
      return res.status(400).json({ message: 'Tenant context missing' });
    }

    const employeeServiceUrl = `${services.employee}/employees`;
    const response = await axios.get(employeeServiceUrl, {
      headers: { 'X-Tenant-Id': tenantId }
    });

    const headcount = response.data?.total || 1;
    const perSeatPrice = 10;
    const totalAmount = headcount * perSeatPrice;

    return res.json({
      checkoutUrl: `https://mock-stripe.atlas.io/checkout/${tenantId}?amount=${totalAmount}`,
      headcount,
      totalAmount,
      currency: 'USD'
    });
  } catch (err) {
    console.error('Billing Error:', err.message);
    res.status(500).json({ message: 'Internal error generating checkout session' });
  }
});

function proxyService(target, prefix, pathRewrite) {
  if (!target || typeof target !== 'string' || (!target.startsWith('http://') && !target.startsWith('https://'))) {
    console.error(`Invalid proxy target for prefix "${prefix}": ${target}`);
    throw new Error(`Invalid proxy target: ${target}`);
  }

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite,
    on: {
      proxyReq(proxyReq, req) {
        const correlationId = req.headers['x-correlation-id'] || crypto.randomUUID();
        proxyReq.setHeader('x-correlation-id', correlationId);
        // Overwrite tenant header with verified claim so downstream cannot be spoofed
        const tenantId = req.headers['x-tenant-id'] || req.headers['X-Tenant-Id'] || req.user?.tenant_id;
        if (tenantId) {
          proxyReq.setHeader('x-tenant-id', tenantId);
          proxyReq.setHeader('X-Tenant-Id', tenantId);
        }
      }
    }
  });
  return (req, res, next) => {
    if (req.user) {
      const internalPayload = {
        user_id: req.user.id,
        user_role: req.user.role,
        tenant_id: req.user.tenant_id || 'default',
        email: req.user.email || '',
        exp: Math.floor(Date.now() / 1000) + 10
      };
      const internalToken = jwt.sign(internalPayload, INTERNAL_JWT_SECRET, { algorithm: 'HS256' });
      req.headers['x-internal-auth'] = internalToken;
      // Overwrite client-supplied tenant header with verified claim
      const tenantId = req.user.tenant_id || 'default';
      req.headers['x-tenant-id'] = tenantId;
      req.headers['X-Tenant-Id'] = tenantId;
    }
    req.url = prefix + req.url;
    checkCache(req, res, (err) => {
      if (err) return next(err);
      proxy(req, res, next);
    });
  };
}

app.use('/api/auth', proxyService(services.auth, '/api/auth', { '^/api/auth': '' }));
app.use('/scim', proxyService(services.auth, '/scim', { '^/scim': '' }));
app.use('/saml', proxyService(services.auth, '/saml', { '^/saml': '' }));

app.use('/api/employee', proxyService(services.employee, '/api/employee', { '^/api/employee': '' }));
app.use('/api/analytics', proxyService(services.analytics, '/api/analytics', { '^/api/analytics': '/analytics' }));
app.use('/api/attendance', proxyService(services.attendance, '/api/attendance', { '^/api/attendance': '/api/attendance' }));
app.use('/api/leave', proxyService(services.leave, '/api/leave', { '^/api/leave': '/api/leave' }));
app.use('/api/payroll', proxyService(services.payroll, '/api/payroll', { '^/api/payroll': '/api/payroll' }));
app.use('/api/notification', proxyService(services.notification, '/api/notification', { '^/api/notification': '' }));

app.use('/api/ats', proxyService(services.ats, '/api/ats', { '^/api/ats': '/api/v1' }));
app.use('/api/lms', proxyService(services.lms, '/api/lms', { '^/api/lms': '/api/v1' }));
app.use('/api/performance', proxyService(services.performance, '/api/performance', { '^/api/performance': '/api/v1' }));
app.use('/api/copilot', proxyService(services.copilot, '/api/copilot', { '^/api/copilot': '' }));
app.use('/api/audit', proxyService(services.audit, '/api/audit', { '^/api/audit': '' }));
app.use('/api/compliance', proxyService(services.compliance, '/api/compliance', { '^/api/compliance': '/api/v1' }));

app.use('/api/integration', proxyService(services.integration, '/api/integration', { '^/api/integration': '/api/v1/integration' }));
app.use('/api/lifecycle', proxyService(services.lifecycle, '/api/lifecycle', { '^/api/lifecycle': '/api/v1/lifecycle' }));
app.use('/api/security', proxyService(services.security, '/api/security', { '^/api/security': '/api/v1/security' }));
app.use('/api/ai', proxyService(services.ai, '/api/ai', { '^/api/ai': '/api/v1/ai' }));
app.use('/api/live', proxyService(services.live, '/api/live', { '^/api/live': '/api/v1/live' }));

app.use('/api/command-center', proxyService(services.analytics, '/api/command-center', { '^/api/command-center': '/api/v1/command-center' }));
app.use('/api/workforce', proxyService(services.workforce, '/api/workforce', { '^/api/workforce': '/api/v1/workforce' }));
app.use('/api/learning', proxyService(services.lms, '/api/learning', { '^/api/learning': '/api/v1/learning' }));

const AUDIT_RETRY_QUEUE = 'audit_retry_queue';
const AUDIT_RETRY_PROCESSING = 'audit_retry_processing';
const AUDIT_RETRY_DLQ = 'audit_retry_dlq';
const MAX_AUDIT_RETRY_ATTEMPTS = 10;
const MAX_AUDIT_QUEUE_SIZE = 10000;

async function updateAuditQueueMetrics() {
  if (!redisClient.isOpen) return;
  try {
    const depth = await redisClient.lLen(AUDIT_RETRY_QUEUE);
    auditRetryQueueDepth.set(depth);
    const dlqDepth = await redisClient.lLen(AUDIT_RETRY_DLQ);
    auditRetryDlqDepth.set(dlqDepth);
  } catch {}
}
setInterval(updateAuditQueueMetrics, 15000);

async function enqueueAuditRetry(payload) {
  if (!redisClient.isOpen) return;
  try {
    const depth = await redisClient.lLen(AUDIT_RETRY_QUEUE);
    auditRetryQueueDepth.set(depth);
    if (depth >= MAX_AUDIT_QUEUE_SIZE) {
      console.error('Audit retry queue full, dropping event', {
        event_type: payload.event_type,
        path: payload.path,
        correlation_id: payload.correlation_id || payload.device_id,
        queueDepth: depth,
      });
      return;
    }
    const toStore = {
      ...payload,
      _attempts: 0,
      _firstEnqueuedAt: Date.now(),
      _nextRetryAt: Date.now(),
    };
    if (!toStore.correlation_id) {
      toStore.correlation_id = payload.correlation_id || payload.headers?.['x-correlation-id'] || `audit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    await redisClient.rPush(AUDIT_RETRY_QUEUE, JSON.stringify(toStore));
    const newDepth = await redisClient.lLen(AUDIT_RETRY_QUEUE);
    auditRetryQueueDepth.set(newDepth);
    if (newDepth >= MAX_AUDIT_QUEUE_SIZE * 0.8) {
      console.warn('Audit retry queue growing', { queueDepth: newDepth });
    }
  } catch (err) {
    console.error('Failed to enqueue audit retry:', err.message);
  }
}

let isDrainingAuditQueue = false;
async function drainAuditRetryQueue() {
  if (isDrainingAuditQueue) return;
  if (!redisClient.isOpen) return;
  isDrainingAuditQueue = true;
  try {
    while (true) {
      let item;
      try {
        if (typeof redisClient.lMove === 'function') {
          item = await redisClient.lMove(AUDIT_RETRY_QUEUE, AUDIT_RETRY_PROCESSING, 'RIGHT', 'LEFT');
        } else if (typeof redisClient.rPopLPush === 'function') {
          item = await redisClient.rPopLPush(AUDIT_RETRY_QUEUE, AUDIT_RETRY_PROCESSING);
        } else {
          item = await redisClient.lPop(AUDIT_RETRY_QUEUE);
          if (item) {
            await redisClient.rPush(AUDIT_RETRY_PROCESSING, item);
          }
        }
      } catch (e) {
        item = await redisClient.lPop(AUDIT_RETRY_QUEUE);
        if (item) await redisClient.rPush(AUDIT_RETRY_PROCESSING, item);
      }
      if (!item) break;

      let payload;
      try {
        payload = JSON.parse(item);
      } catch {
        await redisClient.lRem(AUDIT_RETRY_PROCESSING, 1, item);
        continue;
      }

      const attempts = (payload._attempts || 0) + 1;
      const nextRetryAt = payload._nextRetryAt || 0;
      if (nextRetryAt && Date.now() < nextRetryAt) {
        await redisClient.lRem(AUDIT_RETRY_PROCESSING, 1, item);
        await redisClient.rPush(AUDIT_RETRY_QUEUE, item);
        break;
      }

      if (attempts > MAX_AUDIT_RETRY_ATTEMPTS) {
        console.error('Audit event discarded after max retries', {
          event_type: payload.event_type,
          path: payload.path,
          attempts,
          correlation_id: payload.correlation_id,
          firstEnqueuedAt: payload._firstEnqueuedAt,
        });
        await redisClient.lRem(AUDIT_RETRY_PROCESSING, 1, item);
        try {
          await redisClient.rPush(AUDIT_RETRY_DLQ, JSON.stringify({ ...payload, _attempts: attempts, _discardedAt: Date.now() }));
        } catch {}
        continue;
      }

      try {
        await axios.post(`${AUDIT_SERVICE_URL}/api/v1/audit/log`, payload, {
          headers: { 'X-Internal-Key': AUDIT_INTERNAL_KEY },
          timeout: 2000,
        });
        await redisClient.lRem(AUDIT_RETRY_PROCESSING, 1, item);
      } catch (err) {
        console.error('Audit retry failed, requeueing', {
          event_type: payload.event_type,
          attempts,
          correlation_id: payload.correlation_id,
          error: err.message,
        });
        await redisClient.lRem(AUDIT_RETRY_PROCESSING, 1, item);
        const backoffMs = Math.min(60000, 1000 * Math.pow(2, attempts - 1));
        const nextPayload = {
          ...payload,
          _attempts: attempts,
          _nextRetryAt: Date.now() + backoffMs,
          _lastError: err.message,
        };
        await redisClient.rPush(AUDIT_RETRY_QUEUE, JSON.stringify(nextPayload));
        await new Promise((r) => setTimeout(r, Math.min(backoffMs, 1000)));
      }
    }
  } catch (err) {
    console.error('Audit retry queue processing error:', err.message);
  } finally {
    isDrainingAuditQueue = false;
    updateAuditQueueMetrics().catch(() => {});
  }
}

setInterval(drainAuditRetryQueue, 5000);
setTimeout(drainAuditRetryQueue, 5000);

const server = app.listen(PORT, () => {
  console.log(`API Gateway listening on port ${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const isWs = isWsPath(pathname);
  if (isWs) {
    const token = parsedUrl.searchParams.get('token');
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
      const internalPayload = {
        user_id: payload.id || payload.sub,
        user_role: payload.role || 'employee',
        tenant_id: payload.tenant_id || 'default',
        exp: Math.floor(Date.now() / 1000) + 5
      };
      const internalToken = jwt.sign(internalPayload, INTERNAL_JWT_SECRET, { algorithm: 'HS256' });
      req.headers['x-internal-auth'] = internalToken;
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const isLive = pathname === '/api/live/ws' || pathname.startsWith('/api/live/ws/');
    let target;
    if (isLive) {
      target = new URL(services.live);
      // /api/live/ws/{channel} -> /api/v1/live/ws/{channel}
      target.pathname = pathname.replace(/^\/api\/live/, '/api/v1/live');
      target.search = parsedUrl.search;
    } else {
      target = new URL(services.notification);
      target.pathname = '/ws';
      target.search = parsedUrl.search;
    }
    const proxyReq = http.request(target.toString(), { method: 'GET', headers: req.headers });
    proxyReq.on('upgrade', (proxyRes, proxySocket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + proxyRes.headers['sec-websocket-accept'] + '\r\n' +
        '\r\n');
      socket.pipe(proxySocket).pipe(socket);
    });
    proxyReq.on('error', () => socket.destroy());
    proxyReq.end();
  } else {
    socket.destroy();
  }
});

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'API Gateway is running' });
});

app.get('/metrics', async (req, res) => {
	res.set('Content-Type', promClient.register.contentType);
	res.end(await promClient.register.metrics());
});

function globalErrorHandler(err, req, res, _next) {
	console.error('Unhandled error:', err.message, err.stack);
	const status = err.status || err.statusCode || 500;
	res.status(status).json({ error: 'Internal server error' });
}
app.use(globalErrorHandler);

process.on('SIGTERM', () => {
	console.log('SIGTERM received, shutting down gracefully...');
	server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
	console.log('SIGINT received, shutting down gracefully...');
	server.close(() => process.exit(0));
});
