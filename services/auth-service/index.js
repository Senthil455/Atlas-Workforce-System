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

promClient.collectDefaultMetrics();

const app = express();
app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));

const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

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

const PORT = process.env.PORT || 8010;
const NODE_ENV = process.env.NODE_ENV || 'development';
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_DEFAULT_PASSWORD = process.env.ADMIN_DEFAULT_PASSWORD;
const ACCESS_EXPIRY = '15m';
const REFRESH_EXPIRY_DAYS = 7;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const AUDIT_SERVICE_URL = process.env.AUDIT_SERVICE_URL || 'http://audit-compliance-service:8011';
const AUDIT_INTERNAL_KEY = process.env.AUDIT_INTERNAL_KEY;
const SAML_IDP_SSO_URL = process.env.SAML_IDP_SSO_URL || 'https://idp.example.com/sso';
const SAML_IDP_ENTITY_ID = process.env.SAML_IDP_ENTITY_ID || 'https://idp.example.com/metadata';
const SAML_IDP_CERT = (process.env.SAML_IDP_CERT || '').replace(/\\n/g, '\n');
const SCIM_API_KEY = process.env.SCIM_API_KEY;

if (!JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required');
  process.exit(1);
}

if (!ADMIN_DEFAULT_PASSWORD) {
  console.error('FATAL: ADMIN_DEFAULT_PASSWORD environment variable is required');
  process.exit(1);
}

if (!AUDIT_INTERNAL_KEY) {
  console.error('FATAL: AUDIT_INTERNAL_KEY environment variable is required');
  process.exit(1);
}

if (!SCIM_API_KEY) {
  console.error('FATAL: SCIM_API_KEY environment variable is required');
  process.exit(1);
}

const jwtSecret = JWT_SECRET;

const sslConfig = process.env.POSTGRES_SSL === 'true' || NODE_ENV === 'production'
  ? { rejectUnauthorized: true }
  : false;

const pool = new Pool({
  connectionString: process.env.POSTGRES_URL,
  ssl: sslConfig,
});

if (!process.env.POSTGRES_URL) {
  console.error('FATAL: POSTGRES_URL environment variable is required');
  process.exit(1);
}

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.log('Auth Redis Client Error', err));
(async () => {
  try {
    await redisClient.connect();
  } catch (err) {
    console.error('Auth Redis connection failed, nonce check disabled:', err);
  }
})();

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

function validatePassword(password) {
  if (!password || password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain at least one uppercase letter';
  }
  if (!/[0-9]/.test(password)) {
    return 'Password must contain at least one number';
  }
  return null;
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function signAccessToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, tenant_id: user.tenant_id || 'default' },
    jwtSecret,
    { expiresIn: ACCESS_EXPIRY }
  );
}

function signMfaToken(userId) {
  return jwt.sign(
    { id: userId, mfa_validated: true, purpose: 'mfa_step_up' },
    jwtSecret,
    { expiresIn: '5m' }
  );
}

async function createRefreshToken(userId) {
  const token = crypto.randomBytes(48).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + REFRESH_EXPIRY_DAYS);

  await pool.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, tokenHash, expiresAt]
  );

  return token;
}

async function revokeRefreshToken(refreshToken) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  await pool.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
}

async function verifyRefreshToken(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const result = await pool.query(
    `SELECT rt.*, u.id, u.email, u.name, u.role, u.department, u.position, u.tenant_id
     FROM refresh_tokens rt
     JOIN users u ON u.id = rt.user_id
     WHERE rt.token_hash = $1 AND rt.expires_at > NOW()`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function revokeAllUserSessions(userId) {
  await pool.query('UPDATE sessions SET is_active = false WHERE user_id = $1', [userId]);
  await pool.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
}

async function recordFailedAttempt(email) {
  const lockedUntil = new Date();
  lockedUntil.setMinutes(lockedUntil.getMinutes() + LOCKOUT_MINUTES);

  await pool.query(
    `INSERT INTO failed_attempts (email, attempts, locked_until)
     VALUES ($1, 1, NULL)
     ON CONFLICT (email) DO UPDATE SET
       attempts = failed_attempts.attempts + 1,
       locked_until = CASE
         WHEN failed_attempts.attempts + 1 >= $2 THEN $3
         ELSE failed_attempts.locked_until
       END`,
    [email, MAX_FAILED_ATTEMPTS, lockedUntil]
  );
}

async function clearFailedAttempts(email) {
  await pool.query('DELETE FROM failed_attempts WHERE email = $1', [email]);
}

async function isAccountLocked(email) {
  const result = await pool.query(
    'SELECT attempts, locked_until FROM failed_attempts WHERE email = $1',
    [email]
  );
  const row = result.rows[0];
  if (!row) return false;
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    return true;
  }
  if (row.locked_until && new Date(row.locked_until) <= new Date()) {
    await pool.query('DELETE FROM failed_attempts WHERE email = $1', [email]);
    return false;
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
      const payload = jwt.verify(token, jwtSecret);
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

function requireScimAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const authHeader = req.headers.authorization;

  if (apiKey && apiKey === SCIM_API_KEY) {
    return next();
  }

  if (authHeader?.startsWith('Bearer ')) {
    try {
      const payload = jwt.verify(authHeader.slice(7), jwtSecret);
      req.user = payload;
      return next();
    } catch {
      // Fall through to error
    }
  }

  return res.status(401).json({
    schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
    detail: 'Authentication required',
    status: '401'
  });
}

const rateLimitStore = new Map();

function createUserRateLimiter(action, maxRequests = 20, windowMs = 15 * 60 * 1000) {
  return (req, res, next) => {
    const identifier = req.user?.id || req.ip;
    const key = `${identifier}:${action}`;
    const now = Date.now();

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

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - entry.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil((entry.startTime + windowMs) / 1000));

    if (entry.count > maxRequests) {
      return res.status(429).json({
        message: 'Too many requests. Please try again later.',
        retryAfter: Math.ceil((entry.startTime + windowMs - now) / 1000)
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

async function sendAuditEvent(eventType, userId, email, details = {}) {
  try {
    await axios.post(`${AUDIT_SERVICE_URL}/api/v1/audit/log`, {
      event_type: eventType,
      user_id: userId,
      email,
      timestamp: new Date().toISOString(),
      details,
      service: 'auth-service'
    }, {
      headers: { 'X-Internal-Key': AUDIT_INTERNAL_KEY },
      timeout: 3000
    });
  } catch (err) {
    console.error(`Audit log failed for ${eventType}:`, err.message);
  }
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
    status: String(status)
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
      locked_until TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_mfa (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mfa_secret VARCHAR(255) NOT NULL,
      backup_codes JSONB DEFAULT '[]'::jsonb,
      mfa_enabled BOOLEAN DEFAULT false
    );
  `);

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
      token VARCHAR(64) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email VARCHAR(255) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS rotated_tokens (
      id SERIAL PRIMARY KEY,
      token_hash VARCHAR(64) NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const adminCheck = await pool.query('SELECT * FROM users WHERE email = $1', [
    'admin@atlas.io',
  ]);
  if (adminCheck.rows.length === 0) {
    const hashedPass = await bcrypt.hash(ADMIN_DEFAULT_PASSWORD, BCRYPT_COST);
    await pool.query(
      'INSERT INTO users (email, password, name, role, department, position, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
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
  console.error('Database initialization failed:', err);
});

app.post('/register', createUserRateLimiter('register', 10), async (req, res) => {
  const { email, password, name, department, position, tenant_id } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ message: 'Email, password, and name are required' });
  }

  const passwordError = validatePassword(password);
  if (passwordError) {
    return res.status(400).json({ message: passwordError });
  }

  try {
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) {
      return res.status(400).json({ message: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, BCRYPT_COST);
    const result = await pool.query(
      'INSERT INTO users (email, password, name, role, department, position, tenant_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, name, role, department, position, tenant_id',
      [
        email,
        hashedPassword,
        name,
        'employee',
        department || 'General',
        position || 'Staff',
        tenant_id || 'default'
      ]
    );

    await sendAuditEvent('auth.register', result.rows[0].id, email, {
      role: 'employee',
      tenant_id: tenant_id || 'default'
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: sanitizeUser(result.rows[0]),
    });
  } catch (error) {
    console.error(error);
    if (error.code === '23505') {
      return res.status(409).json({ message: 'User already exists' });
    }
    res.status(500).json({ message: 'Server error during registration' });
  }
});

app.post('/login', createUserRateLimiter('login', 20), async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  try {
    if (await isAccountLocked(email)) {
      return res.status(423).json({
        message: `Account locked. Try again in ${LOCKOUT_MINUTES} minutes.`,
      });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];

    if (!user) {
      await recordFailedAttempt(email);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    if (!user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await recordFailedAttempt(email);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    await clearFailedAttempts(email);

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

    const token = signAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);

    const sessionId = uuidv4();
    await pool.query(
      `INSERT INTO sessions (id, user_id, token_hash, ip_address, user_agent, device_id, is_active, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, true, $7)`,
      [sessionId, user.id, hashToken(refreshToken), req.ip, req.headers['user-agent'] || '', deviceId || null,
       new Date(Date.now() + REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000)]
    );

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    await sendAuditEvent('auth.login', user.id, email, {
      device_trusted: deviceTrusted,
      mfa_required: mfaRequired,
      device_id: deviceId,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      session_id: sessionId
    });

    res.status(200).json({
      message: 'Logged in successfully',
      token,
      session_id: sessionId,
      user: sanitizeUser(user),
      device_trusted: deviceTrusted,
      mfa_required: mfaRequired
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during login' });
  }
});

app.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  if (!refreshToken) {
    return res.status(400).json({ message: 'Refresh token is required' });
  }

  try {
    const row = await verifyRefreshToken(refreshToken);
    if (!row) {
      const tokenHash = hashToken(refreshToken);
      const rotatedCheck = await pool.query(
        'SELECT user_id FROM rotated_tokens WHERE token_hash = $1',
        [tokenHash]
      );
      if (rotatedCheck.rows[0]) {
        const userId = rotatedCheck.rows[0].user_id;
        await revokeAllUserSessions(userId);
        await pool.query('DELETE FROM rotated_tokens WHERE token_hash = $1', [tokenHash]);
        await sendAuditEvent('auth.refresh_token_reuse', userId, null, { action: 'all_sessions_revoked' });
        return res.status(401).json({ message: 'Token reuse detected. All sessions revoked.' });
      }
      return res.status(401).json({ message: 'Invalid or expired refresh token' });
    }

    const oldTokenHash = hashToken(refreshToken);
    await pool.query(
      'INSERT INTO rotated_tokens (token_hash, user_id) VALUES ($1, $2)',
      [oldTokenHash, row.id]
    );
    await pool.query("DELETE FROM rotated_tokens WHERE created_at < NOW() - INTERVAL '1 hour'");

    await revokeRefreshToken(refreshToken);

    const user = {
      id: row.id,
      email: row.email,
      role: row.role,
    };
    const token = signAccessToken(user);
    const newRefreshToken = await createRefreshToken(row.user_id);

    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: REFRESH_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      message: 'Token refreshed',
      token,
      user: sanitizeUser(row),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during token refresh' });
  }
});

app.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  const sessionId = req.headers['x-session-id'];
  let userId = null;
  let userEmail = null;

  try {
    if (refreshToken) {
      const row = await verifyRefreshToken(refreshToken);
      if (row) {
        userId = row.id;
        userEmail = row.email;
      }
      await revokeRefreshToken(refreshToken);
    }

    if (sessionId) {
      await pool.query('UPDATE sessions SET is_active = false WHERE id = $1', [sessionId]);
    } else if (refreshToken) {
      await pool.query('UPDATE sessions SET is_active = false WHERE token_hash = $1', [hashToken(refreshToken)]);
    }

    res.clearCookie('refreshToken');

    if (userId) {
      await sendAuditEvent('auth.logout', userId, userEmail, {
        session_id: sessionId,
        ip_address: req.ip
      });
    }

    res.status(200).json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error during logout' });
  }
});

app.post('/mfa/setup', requireRole(), createUserRateLimiter('mfa_setup', 5), async (req, res) => {
  try {
    const userId = req.user.id;
    const secret = authenticator.generateSecret();
    const backupCodes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').slice(0, 8).toUpperCase());

    await pool.query(`
      INSERT INTO user_mfa (user_id, mfa_secret, backup_codes, mfa_enabled)
      VALUES ($1, $2, $3::jsonb, false)
      ON CONFLICT (user_id) DO UPDATE SET
        mfa_secret = EXCLUDED.mfa_secret,
        backup_codes = EXCLUDED.backup_codes,
        mfa_enabled = false
    `, [userId, secret, JSON.stringify(backupCodes)]);

    const otpauth = authenticator.keyuri(req.user.email, 'Atlas Workforce', secret);

    res.json({
      secret,
      qr_code_uri: otpauth,
      backup_codes: backupCodes
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'MFA setup failed' });
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
    console.error(error);
    res.status(500).json({ message: 'MFA verification failed' });
  }
});

app.post('/mfa/validate', requireRole(), createUserRateLimiter('mfa_validate', 10), async (req, res) => {
  try {
    const { token, backup_code } = req.body;
    if (!token && !backup_code) {
      return res.status(400).json({ message: 'Token or backup code is required' });
    }

    const userId = req.user.id;
    const result = await pool.query('SELECT * FROM user_mfa WHERE user_id = $1 AND mfa_enabled = true', [userId]);
    if (!result.rows[0]) {
      return res.status(400).json({ message: 'MFA is not enabled for this user' });
    }

    const mfa = result.rows[0];

    if (token) {
      const isValid = authenticator.check(token, mfa.mfa_secret);
      if (isValid) {
        const mfaToken = signMfaToken(userId);
        await sendAuditEvent('auth.mfa_validate', userId, req.user.email, { method: 'totp' });
        return res.json({ message: 'Token validated', validated: true, mfa_token: mfaToken });
      }
    }

    if (backup_code) {
      const codes = typeof mfa.backup_codes === 'string' ? JSON.parse(mfa.backup_codes) : mfa.backup_codes;
      if (Array.isArray(codes)) {
        const idx = codes.indexOf(backup_code);
        if (idx !== -1) {
          codes.splice(idx, 1);
          await pool.query('UPDATE user_mfa SET backup_codes = $1::jsonb WHERE user_id = $2', [JSON.stringify(codes), userId]);
          const mfaToken = signMfaToken(userId);
          await sendAuditEvent('auth.mfa_validate', userId, req.user.email, { method: 'backup_code' });
          return res.json({ message: 'Backup code accepted', validated: true, mfa_token: mfaToken });
        }
      }
    }

    res.status(400).json({ message: 'Invalid token or backup code' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'MFA validation failed' });
  }
});

app.post('/mfa/disable', requireRole(), async (req, res) => {
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
    console.error(error);
    res.status(500).json({ message: 'Failed to disable MFA' });
  }
});

app.get('/mfa/status', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query('SELECT mfa_enabled FROM user_mfa WHERE user_id = $1', [userId]);

    res.json({
      mfa_enabled: result.rows[0]?.mfa_enabled || false,
      mfa_setup: !!result.rows[0]
    });
  } catch (error) {
    console.error(error);
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
    console.error(error);
    res.status(500).json({ message: 'Device registration failed' });
  }
});

app.get('/devices', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT id, device_id, device_name, device_type, os, browser, ip_address, is_trusted, last_used_at, created_at FROM user_devices WHERE user_id = $1 ORDER BY last_used_at DESC NULLS LAST',
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to list devices' });
  }
});

app.put('/devices/:id/trust', requireRole(), async (req, res) => {
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
    console.error(error);
    res.status(500).json({ message: 'Failed to update device trust' });
  }
});

app.delete('/devices/:id', requireRole(), async (req, res) => {
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
    console.error(error);
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
    console.error(error);
    res.status(500).json({ message: 'Device verification failed' });
  }
});

app.get('/scim/v2/Users', requireScimAuth, createUserRateLimiter('scim_list', 30), async (req, res) => {
  try {
    const count = Math.min(parseInt(req.query.count) || 10, 100);
    const startIndex = Math.max(parseInt(req.query.startIndex) || 1, 1);
    const offset = startIndex - 1;

    let whereClause = '';
    let queryParams = [];

    if (req.query.filter) {
      const userNameMatch = req.query.filter.match(/userName\s+eq\s+"([^"]+)"/i);
      const emailMatch = req.query.filter.match(/emails\[type\s+eq\s+"work"\].*value\s+eq\s+"([^"]+)"/i);
      const filterValue = userNameMatch?.[1] || emailMatch?.[1];

      if (filterValue) {
        whereClause = 'WHERE email = $1';
        queryParams.push(filterValue);
      }
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
    console.error(err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.post('/scim/v2/Users', requireScimAuth, createUserRateLimiter('scim_create', 20), async (req, res) => {
  try {
    const { userName, name, emails, roles, active, externalId } = req.body;

    if (!userName) {
      return sendScimError(res, 400, 'userName is required');
    }

    const email = emails?.[0]?.value || userName;
    const givenName = name?.givenName || '';
    const familyName = name?.familyName || '';
    const displayName = name?.formatted || `${givenName} ${familyName}`.trim() || email;
    const role = roles?.[0]?.value || 'employee';
    const userActive = active !== undefined ? active : true;

    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (exists.rows.length > 0) {
      return sendScimError(res, 409, 'User already exists');
    }

    const tempPassword = crypto.randomBytes(16).toString('hex');
    const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_COST);

    const result = await pool.query(
      'INSERT INTO users (email, password, name, role, active) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [email, hashedPassword, displayName, role, userActive]
    );

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const scimUser = formatScimUser(result.rows[0], baseUrl);

    await sendAuditEvent('scim.user_created', result.rows[0].id, email, {
      method: 'scim',
      source: externalId || 'SCIM provisioned'
    });

    res.status(201).json(scimUser);
  } catch (err) {
    console.error(err);
    if (err.code === '23505') {
      return sendScimError(res, 409, 'User already exists');
    }
    return sendScimError(res, 500, 'Internal error');
  }
});

app.get('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_get', 60), async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(formatScimUser(result.rows[0], baseUrl));
  } catch (err) {
    console.error(err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.put('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_update', 20), async (req, res) => {
  try {
    const { userName, name, emails, roles, active } = req.body;

    const email = emails?.[0]?.value || userName;
    const givenName = name?.givenName || '';
    const familyName = name?.familyName || '';
    const displayName = name?.formatted || `${givenName} ${familyName}`.trim() || email;
    const role = roles?.[0]?.value;

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
    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx} RETURNING *`;

    const result = await pool.query(query, updateValues);
    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(formatScimUser(result.rows[0], baseUrl));
  } catch (err) {
    console.error(err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.patch('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_patch', 20), async (req, res) => {
  try {
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
        } else if (op.path === 'roles[0].value') {
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
            updateFields.push(`role = $${paramIdx++}`);
            updateValues.push(op.value.roles[0].value);
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

    const query = `UPDATE users SET ${updateFields.join(', ')} WHERE id = $${paramIdx} RETURNING *`;

    const result = await pool.query(query, updateValues);
    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json(formatScimUser(result.rows[0], baseUrl));
  } catch (err) {
    console.error(err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.delete('/scim/v2/Users/:id', requireScimAuth, createUserRateLimiter('scim_delete', 10), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE users SET active = false, updated_at = NOW() WHERE id = $1 RETURNING id',
      [req.params.id]
    );

    if (!result.rows[0]) {
      return sendScimError(res, 404, 'User not found');
    }

    await sendAuditEvent('scim.user_deactivated', parseInt(req.params.id), null, {
      method: 'scim'
    });

    res.status(204).send();
  } catch (err) {
    console.error(err);
    return sendScimError(res, 500, 'Internal error');
  }
});

app.post('/saml/acs', createUserRateLimiter('saml_acs', 20), async (req, res) => {
  try {
    const { SAMLResponse } = req.body;
    if (!SAMLResponse) {
      return res.status(400).json({ message: 'SAMLResponse is required' });
    }

    const decodedXml = Buffer.from(SAMLResponse, 'base64').toString('utf-8');

    if (!SAML_IDP_CERT && NODE_ENV === 'production') {
      console.warn('SAML_IDP_CERT not configured — signature verification disabled');
    }

    if (SAML_IDP_CERT) {
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

        for (let i = 0; i < audienceNodes.length; i++) {
          if (audienceNodes[i].textContent === SAML_IDP_ENTITY_ID) {
            break;
          }
        }
      }
    }

    const nameIdMatch = decodedXml.match(/<saml2:NameID[^>]*>([^<]+)<\/saml2:NameID>/);
    const emailMatch = decodedXml.match(/<saml2:Attribute[^>]*?Name="[^"]*email[^"]*"[^>]*>[\s\S]*?<saml2:AttributeValue[^>]*>([^<]+)<\/saml2:AttributeValue>/i);
    const firstNameMatch = decodedXml.match(/<saml2:Attribute[^>]*?Name="[^"]*firstName[^"]*"[^>]*>[\s\S]*?<saml2:AttributeValue[^>]*>([^<]+)<\/saml2:AttributeValue>/i);
    const lastNameMatch = decodedXml.match(/<saml2:Attribute[^>]*?Name="[^"]*lastName[^"]*"[^>]*>[\s\S]*?<saml2:AttributeValue[^>]*>([^<]+)<\/saml2:AttributeValue>/i);

    const emailSimpleMatch = decodedXml.match(/<NameID[^>]*>([^<]+)<\/NameID>/);
    const email = emailMatch?.[1] || nameIdMatch?.[1] || emailSimpleMatch?.[1];
    const firstName = firstNameMatch?.[1] || '';
    const lastName = lastNameMatch?.[1] || '';
    const displayName = `${firstName} ${lastName}`.trim() || email;

    if (!email) {
      return res.status(400).json({ message: 'Could not extract user identity from SAML response' });
    }

    let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    let userData;

    if (userResult.rows.length === 0) {
      const tempPassword = crypto.randomBytes(16).toString('hex');
      const hashedPassword = await bcrypt.hash(tempPassword, BCRYPT_COST);
      userResult = await pool.query(
        'INSERT INTO users (email, password, name) VALUES ($1, $2, $3) RETURNING *',
        [email, hashedPassword, displayName || email]
      );
      userData = userResult.rows[0];
    } else {
      userData = userResult.rows[0];
    }

    if (!userData.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const token = signAccessToken(userData);
    const refreshToken = await createRefreshToken(userData.id);

    await sendAuditEvent('auth.saml_login', userData.id, email, {
      ip_address: req.ip
    });

    res.json({
      message: 'SAML login successful',
      token,
      user: sanitizeUser(userData)
    });
  } catch (err) {
    console.error(err);
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
    const entityId = `${req.protocol}://${req.get('host')}/saml/metadata`;
    const acsUrl = `${req.protocol}://${req.get('host')}/saml/acs`;

    const samlRequest = `<?xml version="1.0"?>
<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${crypto.randomBytes(16).toString('hex')}" Version="2.0" IssueInstant="${new Date().toISOString()}" Destination="${SAML_IDP_SSO_URL}" AssertionConsumerServiceURL="${acsUrl}" ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${entityId}</saml:Issuer>
  <samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress" AllowCreate="true"/>
</samlp:AuthnRequest>`;

    const encodedRequest = Buffer.from(samlRequest).toString('base64');

    res.json({
      redirect_url: `${SAML_IDP_SSO_URL}?SAMLRequest=${encodeURIComponent(encodedRequest)}`,
      saml_request: encodedRequest,
      entity_id: entityId,
      acs_url: acsUrl
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'SAML login initiation failed' });
  }
});

app.post('/auth/passwordless/request', createUserRateLimiter('passwordless_request', 5), async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const userResult = await pool.query('SELECT id, email FROM users WHERE email = $1 AND active = true', [email]);
    if (!userResult.rows[0]) {
      return res.status(404).json({ message: 'User not found or inactive' });
    }

    const user = userResult.rows[0];
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);

    await pool.query(
      'INSERT INTO passwordless_tokens (token, user_id, email, expires_at) VALUES ($1, $2, $3, $4)',
      [tokenHash, user.id, email, expiresAt]
    );

    await sendAuditEvent('auth.passwordless_requested', user.id, email);

    res.json({
      message: 'Magic link sent',
      token,
      expires_in: 900
    });
  } catch (err) {
    console.error(err);
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
    const result = await pool.query(
      'SELECT * FROM passwordless_tokens WHERE token = $1 AND used = false AND expires_at > NOW()',
      [tokenHash]
    );

    if (!result.rows[0]) {
      return res.status(400).json({ message: 'Invalid or expired token' });
    }

    await pool.query('UPDATE passwordless_tokens SET used = true WHERE token = $1', [tokenHash]);

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [result.rows[0].user_id]);
    const user = userResult.rows[0];

    if (!user || !user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const accessToken = signAccessToken(user);
    const refreshToken = await createRefreshToken(user.id);

    await sendAuditEvent('auth.passwordless_login', user.id, user.email);

    res.json({
      message: 'Logged in successfully',
      token: accessToken,
      user: sanitizeUser(user)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Magic link verification failed' });
  }
});

app.get('/sessions', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT id, ip_address, user_agent, device_id, is_active, created_at, expires_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to list sessions' });
  }
});

app.delete('/sessions/:id', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'UPDATE sessions SET is_active = false WHERE id = $1::uuid AND user_id = $2 RETURNING id',
      [req.params.id, userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Session not found' });
    }
    res.json({ message: 'Session revoked' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Failed to revoke session' });
  }
});

app.delete('/sessions', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const currentSessionId = req.headers['x-session-id'];

    if (currentSessionId) {
      await pool.query(
        'UPDATE sessions SET is_active = false WHERE user_id = $1 AND id != $2::uuid',
        [userId, currentSessionId]
      );
    } else {
      await pool.query(
        'UPDATE sessions SET is_active = false WHERE user_id = $1',
        [userId]
      );
    }

    await sendAuditEvent('auth.sessions_revoked', userId, req.user.email, {
      except_session_id: currentSessionId
    });

    res.json({ message: 'Other sessions revoked' });
  } catch (error) {
    console.error(error);
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

async function storeChallenge(userId, challenge) {
  await pool.query(
    'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_name, device_type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (credential_id) DO NOTHING',
    [userId, `challenge:${challenge}`, challenge, 'pending', 'pending']
  );
}

async function consumeChallenge(userId, challenge) {
  const result = await pool.query(
    'DELETE FROM webauthn_credentials WHERE user_id = $1 AND credential_id = $2 RETURNING id',
    [userId, `challenge:${challenge}`]
  );
  return result.rowCount > 0;
}

app.post('/webauthn/register/begin', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { device_name, device_type } = req.body;

    const userResult = await pool.query('SELECT id, email, name FROM users WHERE id = $1', [userId]);
    const user = userResult.rows[0];

    const existing = await pool.query(
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND is_active = true',
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

    await storeChallenge(userId, options.challenge);

    res.json({
      status: 'ok',
      creationOptions: options,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'WebAuthn registration initiation failed' });
  }
});

app.post('/webauthn/register/complete', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const { device_name, device_type } = req.body;
    const credential = req.body;

    if (!credential || !credential.response || !credential.id) {
      return res.status(400).json({ message: 'Invalid credential response' });
    }

    const challengeRow = await pool.query(
      'SELECT public_key as challenge FROM webauthn_credentials WHERE user_id = $1 AND credential_id LIKE $2 AND device_name = $3',
      [userId, 'challenge:%', 'pending']
    );

    if (!challengeRow.rows[0]) {
      return res.status(400).json({ message: 'No pending registration challenge found. Please start registration again.' });
    }

    const expectedChallenge = challengeRow.rows[0].challenge;

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

    await pool.query(
      'DELETE FROM webauthn_credentials WHERE user_id = $1 AND credential_id LIKE $2',
      [userId, 'challenge:%']
    );

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
    console.error(err);
    res.status(500).json({ message: 'WebAuthn registration completion failed' });
  }
});

app.post('/webauthn/authenticate/begin', createUserRateLimiter('webauthn_auth', 10), async (req, res) => {
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
      'SELECT credential_id FROM webauthn_credentials WHERE user_id = $1 AND is_active = true',
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

    await pool.query(
      'INSERT INTO webauthn_credentials (user_id, credential_id, public_key, device_name, device_type) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (credential_id) DO NOTHING',
      [userId, `challenge:${options.challenge}`, options.challenge, 'pending', 'pending']
    );

    res.json({
      status: 'ok',
      authenticationOptions: options,
      userId,
    });
  } catch (err) {
    console.error(err);
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
      'SELECT * FROM webauthn_credentials WHERE credential_id = $1 AND is_active = true',
      [credId]
    );

    if (!credResult.rows[0]) {
      return res.status(400).json({ message: 'Credential not found' });
    }

    const cred = credResult.rows[0];

    const challengeResult = await pool.query(
      "SELECT public_key FROM webauthn_credentials WHERE user_id = $1 AND credential_id LIKE 'challenge:%' AND device_name = 'pending'",
      [cred.user_id]
    );

    if (!challengeResult.rows[0]) {
      return res.status(400).json({ message: 'No pending authentication challenge. Please start authentication again.' });
    }

    const expectedChallenge = challengeResult.rows[0].public_key;

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

    await pool.query(
      "DELETE FROM webauthn_credentials WHERE user_id = $1 AND credential_id LIKE 'challenge:%'",
      [cred.user_id]
    );

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [cred.user_id]);
    const user = userResult.rows[0];

    if (!user || !user.active) {
      return res.status(403).json({ message: 'Account is deactivated' });
    }

    const token = signAccessToken(user);
    await createRefreshToken(user.id);

    await sendAuditEvent('auth.webauthn_login', user.id, user.email, {
      credential_id: credId.substring(0, 20) + '...',
    });

    res.json({
      message: 'Hardware security key authentication successful',
      token,
      user: sanitizeUser(user),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'WebAuthn authentication completion failed' });
  }
});

app.get('/webauthn/credentials', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT id, credential_id, device_name, device_type, counter, is_active, created_at, last_used_at FROM webauthn_credentials WHERE user_id = $1 ORDER BY created_at DESC',
      [userId]
    );
    res.json(result.rows.map(r => ({
      ...r,
      credential_id: r.credential_id.substring(0, 20) + '...',
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to list credentials' });
  }
});

app.delete('/webauthn/credentials/:id', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 AND is_active = true RETURNING id',
      [parseInt(req.params.id), userId]
    );
    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Credential not found' });
    }
    await sendAuditEvent('auth.webauthn_removed', userId, req.user.email);
    res.json({ message: 'Security key removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to remove credential' });
  }
});

// ── OAuth Enterprise Login ─────────────────────────────────────────────────

app.get('/oauth/providers', async (req, res) => {
  try {
    const tenantId = req.query.tenant_id || 'default';
    const result = await pool.query(
      'SELECT id, provider, client_id, redirect_uri, scopes, enabled FROM oauth_providers WHERE tenant_id = $1 ORDER BY provider',
      [tenantId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to list OAuth providers' });
  }
});

app.post('/oauth/providers', async (req, res) => {
  try {
    const { provider, client_id, client_secret, redirect_uri, scopes, tenant_id } = req.body;
    if (!provider || !client_id || !client_secret) {
      return res.status(400).json({ message: 'provider, client_id, client_secret are required' });
    }
    const result = await pool.query(
      `INSERT INTO oauth_providers (provider, client_id, client_secret, redirect_uri, scopes, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, provider, client_id, redirect_uri, scopes, enabled`,
      [provider, client_id, client_secret, redirect_uri || '', scopes || 'openid email profile', tenant_id || 'default']
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'Provider already configured for this tenant' });
    }
    console.error(err);
    res.status(500).json({ message: 'Failed to create OAuth provider' });
  }
});

app.post('/oauth/login/:provider', createUserRateLimiter('oauth_login', 20), async (req, res) => {
  try {
    const { provider } = req.params;
    const { tenant_id } = req.body;
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

    await pool.query(
      'INSERT INTO oauth_states (state, provider, tenant_id, redirect_to, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [state, provider, tenantId, redirectTo, expiresAt]
    );

    const providerConfigs = {
      google: {
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        params: {
          client_id: prov.client_id,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          response_type: 'code',
          scope: prov.scopes || 'openid email profile',
          state,
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
        authUrl: `${prov.client_id.includes('.okta.com') ? `https://${prov.client_id.split('.')[0]}.okta.com` : 'https://dev-000000.okta.com'}/oauth2/v1/authorize`,
        params: {
          client_id: prov.client_id,
          redirect_uri: prov.redirect_uri || `${req.protocol}://${req.get('host')}/oauth/callback/${provider}`,
          response_type: 'code',
          scope: prov.scopes || 'openid email profile',
          state,
        },
      },
    };

    const config = providerConfigs[provider] || providerConfigs.google;
    const params = new URLSearchParams(config.params);
    const redirectUrl = `${config.authUrl}?${params.toString()}`;

    res.json({
      redirect_url: redirectUrl,
      state,
      provider,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'OAuth login initiation failed' });
  }
});

app.post('/oauth/callback/:provider', createUserRateLimiter('oauth_callback', 20), async (req, res) => {
  try {
    const { provider } = req.params;
    const { code, state } = req.body;

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
        tokenUrl: `${prov.client_id.includes('.okta.com') ? `https://${prov.client_id.split('.')[0]}.okta.com` : 'https://dev-000000.okta.com'}/oauth2/v1/token`,
        userInfoUrl: `${prov.client_id.includes('.okta.com') ? `https://${prov.client_id.split('.')[0]}.okta.com` : 'https://dev-000000.okta.com'}/oauth2/v1/userinfo`,
      },
    };

    const tokenConfig = tokenConfigs[provider] || tokenConfigs.google;

    try {
      const tokenResponse = await axios.post(
        tokenConfig.tokenUrl,
        new URLSearchParams({
          code,
          client_id: prov.client_id,
          client_secret: prov.client_secret,
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
      const email = userInfo.email || userInfo.mail || userInfo.userPrincipalName || `${userInfo.login}@${provider}.oauth`;
      const name = userInfo.name || userInfo.displayName || userInfo.login || email;
      const providerUserId = String(userInfo.id || userInfo.sub || userInfo.login || email);

      let userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
      let userData;

      if (userResult.rows.length === 0) {
        const tempPassword = crypto.randomBytes(16).toString('hex');
        const hashedPass = await bcrypt.hash(tempPassword, BCRYPT_COST);
        userResult = await pool.query(
          'INSERT INTO users (email, password, name, tenant_id) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, hashedPass, name, oauthState.tenant_id]
        );
        userData = userResult.rows[0];
      } else {
        userData = userResult.rows[0];
      }

      if (!userData.active) {
        return res.status(403).json({ message: 'Account is deactivated' });
      }

      await pool.query(
        `INSERT INTO oauth_links (user_id, provider, provider_user_id, access_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider, provider_user_id) DO UPDATE SET access_token = $4, refresh_token = COALESCE($5, oauth_links.refresh_token), expires_at = $6`,
        [userData.id, provider, providerUserId, accessToken, tokenResponse.data.refresh_token || null,
         tokenResponse.data.expires_in ? new Date(Date.now() + tokenResponse.data.expires_in * 1000) : null]
      );

      const token = signAccessToken(userData);
      const refreshToken = await createRefreshToken(userData.id);

      await sendAuditEvent('auth.oauth_login', userData.id, email, { provider });

      res.json({
        message: `OAuth ${provider} login successful`,
        token,
        user: sanitizeUser(userData),
        provider,
      });
    } catch (oauthErr) {
      console.error('OAuth token exchange error:', oauthErr.response?.data || oauthErr.message);
      res.status(502).json({ message: `OAuth ${provider} authentication failed` });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'OAuth callback processing failed' });
  }
});

app.get('/oauth/links', requireRole(), async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      'SELECT provider, provider_user_id, created_at FROM oauth_links WHERE user_id = $1',
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to list OAuth links' });
  }
});

app.delete('/oauth/links/:provider', requireRole(), async (req, res) => {
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
    console.error(err);
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

app.listen(PORT, () => {
  console.log(`Auth service running on port ${PORT}`);
});

module.exports = { app, requireRole, pool };
