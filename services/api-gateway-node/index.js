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
          redisClient.setEx(key, 300, typeof body === 'string' ? body : JSON.stringify(body)).catch(() => {});
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
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET;
const INTERNAL_JWT_SECRET = process.env.INTERNAL_JWT_SECRET;
const AUDIT_INTERNAL_KEY = process.env.AUDIT_INTERNAL_KEY;
const AUDIT_SERVICE_URL = process.env.AUDIT_COMPLIANCE_SERVICE_URL || 'http://audit-compliance-service:8011';

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

const jwtSecret = JWT_SECRET;

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

function mfaStepUpMiddleware(req, res, next) {
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
  if (mfaToken) {
    try {
      const payload = jwt.verify(mfaToken, jwtSecret, { algorithms: ['HS256'] });
      if (payload.mfa_validated && payload.purpose === 'mfa_step_up') {
        req.headers['x-mfa-validated'] = 'true';
        return next();
      }
    } catch {
      // Token invalid, fall through to MFA required
    }
  }

  return res.status(403).json({
    message: 'MFA validation required for this resource',
    mfa_required: true,
    mfa_challenge_url: '/api/auth/mfa/challenge',
    detail: 'Please validate your identity with MFA before accessing sensitive resources'
  });
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
  '/api/webhooks',
  '/api/auth/webauthn/authenticate/begin',
  '/api/auth/webauthn/authenticate/complete',
  '/api/auth/oauth/login',
  '/api/auth/oauth/callback',
  '/api/auth/oauth/providers',
];

function isPublicOrAuthPath(path) {
  return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

function authMiddleware(req, res, next) {
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
  ];

  const needsAuth = protectedPrefixes.some(
    (prefix) => req.path === prefix || req.path.startsWith(prefix + '/')
  );

  if (!needsAuth) {
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authentication required' });
  }

  try {
    const token = authHeader.slice(7);
    const payload = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    req.user = payload;
    next();
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

  next();
}

app.use(rbacMiddleware);

app.use(auditProxyMiddleware);
app.use(mfaStepUpMiddleware);

function csrfMiddleware(req, res, next) {
  if (isPublicOrAuthPath(req.path)) return next();

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

  const headerToken = req.headers['x-csrf-token'];
  const cookieToken = req.cookies?.csrf_token;

  if (!headerToken || !cookieToken || headerToken !== cookieToken) {
    return res.status(403).json({ message: 'CSRF token validation failed' });
  }

  next();
}

app.use(csrfMiddleware);

function cacheInvalidationMiddleware(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    res.on('finish', () => {
      if (res.statusCode < 400 && redisClient.isOpen) {
        const tenantId = req.user?.tenant_id || 'public';
        const userScope = req.user ? `${req.user.id}:${tenantId}:*` : `public:public:*`;
        const pattern = `cache:${userScope}:*`;
        redisClient.keys(pattern).then((keys) => {
          if (keys.length > 0) {
            redisClient.del(keys).catch((err) => console.error('Cache invalidation error:', err));
          }
        }).catch((err) => console.error('Cache key scan error:', err));
      }
    });
  }
  next();
}

app.use(cacheInvalidationMiddleware);

app.post('/api/webhooks/slack', express.urlencoded({ extended: true }), async (req, res) => {
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
    console.error('Slack Webhook Error:', err.response?.data || err.message);
    res.json({ response_type: "ephemeral", text: `Failed to submit leave: ${err.response?.data?.message || 'Error'}` });
  }
});

app.post('/api/billing/create-checkout-session', express.json(), async (req, res) => {
  try {
    const tenantId = req.user?.tenant_id || 'default';

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
      const internalToken = jwt.sign(internalPayload, INTERNAL_JWT_SECRET);
      req.headers['x-internal-auth'] = internalToken;
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
app.use('/api/attendance', proxyService(services.attendance, '/api/attendance', { '^/api/attendance': '' }));
app.use('/api/leave', proxyService(services.leave, '/api/leave', { '^/api/leave': '' }));
app.use('/api/payroll', proxyService(services.payroll, '/api/payroll', { '^/api/payroll': '' }));
app.use('/api/notification', proxyService(services.notification, '/api/notification', { '^/api/notification': '' }));

app.use('/api/ats', proxyService(services.ats, '/api/ats', { '^/api/ats': '' }));
app.use('/api/lms', proxyService(services.lms, '/api/lms', { '^/api/lms': '' }));
app.use('/api/performance', proxyService(services.performance, '/api/performance', { '^/api/performance': '' }));
app.use('/api/copilot', proxyService(services.copilot, '/api/copilot', { '^/api/copilot': '' }));
app.use('/api/audit', proxyService(services.audit, '/api/audit', { '^/api/audit': '' }));
app.use('/api/compliance', proxyService(services.compliance, '/api/compliance', { '^/api/compliance': '/api/v1' }));

app.use('/api/integration', proxyService(services.integration, '/api/integration', { '^/api/integration': '/api/v1/integration' }));
app.use('/api/lifecycle', proxyService(services.lifecycle, '/api/lifecycle', { '^/api/lifecycle': '/api/v1/lifecycle' }));
app.use('/api/security', proxyService(services.security, '/api/security', { '^/api/security': '/api/v1/security' }));
app.use('/api/ai', proxyService(services.ai, '/api/ai', { '^/api/ai': '/api/v1/ai' }));

async function enqueueAuditRetry(payload) {
  if (!redisClient.isOpen) return;
  try {
    await redisClient.rPush('audit_retry_queue', JSON.stringify(payload));
  } catch (err) {
    console.error('Failed to enqueue audit retry:', err.message);
  }
}

setInterval(async () => {
  if (!redisClient.isOpen) return;
  try {
    while (true) {
      const item = await redisClient.lPop('audit_retry_queue');
      if (!item) break;
      const payload = JSON.parse(item);
      await axios.post(`${AUDIT_SERVICE_URL}/api/v1/audit/log`, payload, {
        headers: { 'X-Internal-Key': AUDIT_INTERNAL_KEY },
        timeout: 2000
      });
    }
  } catch (err) {
    console.error('Audit retry queue processing error:', err.message);
  }
}, 5000);

const server = app.listen(PORT, () => {
  console.log(`API Gateway listening on port ${PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const isWs = ALLOWED_WS_PATHS.has(pathname);
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
      const internalToken = jwt.sign(internalPayload, INTERNAL_JWT_SECRET);
      req.headers['x-internal-auth'] = internalToken;
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const target = new URL(services.notification);
    target.pathname = '/ws';
    target.search = parsedUrl.search;
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
