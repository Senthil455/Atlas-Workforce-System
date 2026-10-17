/** @type {import('next').NextConfig} */
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// API origin is needed for the CSP connect-src allowlist. NEXT_PUBLIC_API_URL
// is inlined at build time; fall back to the local-dev gateway when unset.
const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080/api";
let apiOrigin = "http://localhost:8080";
let wsOrigin = "ws://localhost:8080";
try {
  const parsed = new URL(apiUrl);
  apiOrigin = parsed.origin;
  wsOrigin = `${parsed.protocol === "https:" ? "wss:" : "ws:"}//${parsed.host}`;
} catch {
  // Leave the localhost defaults in place; an invalid URL is caught by the
  // env guard in src/lib/env.ts at boot.
}

// Starter policy, shipped report-only so violations surface without breaking
// the app. Tightening plan (documented in the PR): drop 'unsafe-inline' from
// script-src once a nonce strategy lands via middleware, then flip the header
// name to enforcing. style-src keeps 'unsafe-inline' because the App Router
// emits inline style tags for streaming boundaries.
const cspReportOnly = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${apiOrigin} ${wsOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
].join("; ");

const isProduction = process.env.NODE_ENV === "production";

const securityHeaders = [
  // Report-only first: collect real violations before enforcing. There is no
  // report endpoint yet, so violations land in the browser console.
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    // Geolocation stays self-scoped: the attendance flow uses it for
    // geo-fence verification.
    value: "camera=(), microphone=(), geolocation=(self), payment=(), usb=()",
  },
];

if (isProduction) {
  securityHeaders.push({
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  });
}

const nextConfig = {
  output: "standalone",
  turbopack: {},
  webpack: (config) => {
    config.resolve.alias["@"] = path.join(__dirname, "src");
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
