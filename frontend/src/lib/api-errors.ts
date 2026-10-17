import axios, {
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

/**
 * Transport hardening helpers shared by the API client.
 *
 * Everything here is dependency-free and free of app state so the module can
 * be unit tested without network access.
 */

/** Request timeout applied to every call on the shared client. */
export const API_TIMEOUT_MS = 15000;

/** Maximum number of extra attempts (so a GET runs at most 3 times). */
export const RETRY_MAX_ATTEMPTS = 2;

/** Base delay for exponential backoff, before jitter. */
export const RETRY_BASE_DELAY_MS = 300;

/** Upper bound for a single retry delay. */
export const RETRY_MAX_DELAY_MS = 4000;

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retryCount?: number;
}

const IDEMPOTENT_METHODS = ["get", "head", "options"];

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const STATUS_MESSAGES: Record<number, string> = {
  400: "The request was rejected. Check the values you entered and try again.",
  401: "Your session has expired. Sign in again.",
  403: "You do not have permission to do that.",
  404: "The requested item was not found.",
  405: "That action is not supported here.",
  408: "The request timed out. Try again.",
  409: "This change conflicts with the current state. Refresh and try again.",
  410: "This item is no longer available.",
  413: "The submitted data is too large.",
  415: "The server could not read the submitted format.",
  422: "The server rejected the submitted values.",
  429: "Too many requests. Wait a moment and try again.",
  500: "The server hit an unexpected error. Try again shortly.",
  502: "A backend service is unavailable. Try again shortly.",
  503: "A backend service is unavailable. Try again shortly.",
  504: "A backend service did not respond in time. Try again shortly.",
};

export interface NormalizedApiError {
  /** HTTP status, or null when the request never reached the server. */
  status: number | null;
  /** Stable machine-readable code such as http_500, timeout or network. */
  code: string;
  /** Human-readable message that is safe to show in the UI or logs. */
  message: string;
  /** Whether a bounded retry is allowed for this failure. */
  retryable: boolean;
}

/**
 * Only idempotent methods may be retried: replaying a POST could double-submit
 * a payment or a clock-in, which is never acceptable.
 */
export function isIdempotentMethod(method?: string): boolean {
  if (!method) return false;
  return IDEMPOTENT_METHODS.includes(method.toLowerCase());
}

export function isTimeoutError(error: unknown): boolean {
  const code = (error as AxiosError | undefined)?.code;
  return code === "ECONNABORTED" || code === "ETIMEDOUT";
}

export function isCanceledError(error: unknown): boolean {
  return axios.isCancel(error) || (error as AxiosError | undefined)?.code === "ERR_CANCELED";
}

/**
 * Retry policy: transport failures (no response), timeouts, 408/425/429 and
 * 5xx are retryable. Every other 4xx is a deterministic client error and must
 * fail fast. Cancellations are user intent and are never retried.
 */
export function isRetryableError(error: unknown): boolean {
  if (isCanceledError(error)) return false;
  const status = (error as AxiosError | undefined)?.response?.status;
  if (typeof status !== "number") return true;
  return RETRYABLE_STATUSES.has(status);
}

/**
 * Full-jitter exponential backoff: delay = random() * base * 2^attempt,
 * clamped to RETRY_MAX_DELAY_MS. `random` is injectable so tests can pin the
 * jitter source.
 */
export function computeRetryDelay(
  attempt: number,
  random: () => number = Math.random
): number {
  const safeAttempt = Math.max(0, Math.floor(attempt));
  const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** safeAttempt, RETRY_MAX_DELAY_MS);
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(ceiling * jitter);
}

/**
 * Removes token-shaped material from any string before it reaches a log or an
 * error UI. Conservative on purpose: it may over-redact, never under-redact.
 */
export function redactSensitiveString(value: string): string {
  return value
    .replace(/[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[redacted-jwt]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(
      /((?:token|secret|password|passwd|api[_-]?key|authorization|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?)[^"',\s&}]{4,}/gi,
      "$1[redacted]"
    );
}

/**
 * Turns any thrown value into a safe, presentable shape. It deliberately
 * ignores the upstream response body entirely: raw service payloads and the
 * tokens they sometimes echo never reach the UI or the console.
 */
export function normalizeApiError(error: unknown): NormalizedApiError {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status ?? null;
    if (status === null) {
      if (isTimeoutError(error)) {
        return {
          status: null,
          code: "timeout",
          message: "The request timed out. Check your connection and try again.",
          retryable: true,
        };
      }
      if (isCanceledError(error)) {
        return {
          status: null,
          code: "canceled",
          message: "The request was cancelled.",
          retryable: false,
        };
      }
      return {
        status: null,
        code: "network",
        message: "Could not reach the server. Check your connection and try again.",
        retryable: true,
      };
    }
    return {
      status,
      code: `http_${status}`,
      message: STATUS_MESSAGES[status] ?? "The request could not be completed.",
      retryable: isRetryableError(error),
    };
  }

  if (error instanceof Error) {
    return {
      status: null,
      code: "unexpected",
      message: "Something went wrong. Try again.",
      retryable: false,
    };
  }

  return {
    status: null,
    code: "unknown",
    message: "Something went wrong. Try again.",
    retryable: false,
  };
}

/**
 * Bounded retry with jitter for idempotent requests. Reuses the original
 * config so auth headers are re-applied by the request interceptor on each
 * attempt. Attach to the shared client after the auth refresh interceptor.
 */
export function attachRetryInterceptor(client: AxiosInstance): void {
  client.interceptors.response.use(undefined, async (error: AxiosError) => {
    const config = error.config as RetryableConfig | undefined;
    if (!config) return Promise.reject(error);
    if (!isIdempotentMethod(config.method)) return Promise.reject(error);
    if (!isRetryableError(error)) return Promise.reject(error);

    const attempt = config._retryCount ?? 0;
    if (attempt >= RETRY_MAX_ATTEMPTS) return Promise.reject(error);

    config._retryCount = attempt + 1;
    await new Promise((resolve) => setTimeout(resolve, computeRetryDelay(attempt)));
    return client.request(config);
  });
}
