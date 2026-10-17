import { describe, it, expect, vi } from "vitest";
import axios, { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from "axios";
import {
  API_TIMEOUT_MS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_DELAY_MS,
  attachRetryInterceptor,
  computeRetryDelay,
  isIdempotentMethod,
  isRetryableError,
  normalizeApiError,
  redactSensitiveString,
} from "./api-errors";

const SECRET_PAYLOAD = {
  error: "upstream said no",
  access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop",
  password: "hunter2-not-a-real-secret",
};

function makeResponse(
  config: InternalAxiosRequestConfig,
  status: number
): AxiosResponse {
  return {
    data: SECRET_PAYLOAD,
    status,
    statusText: String(status),
    headers: {},
    config,
  } as AxiosResponse;
}

function makeAxiosError(
  config: InternalAxiosRequestConfig,
  status: number
): AxiosError {
  return new AxiosError("Request failed", `ERR_${status}`, config, undefined, makeResponse(config, status));
}

function makeNetworkError(config: InternalAxiosRequestConfig): AxiosError {
  const error = new AxiosError("Network Error", "ERR_NETWORK", config);
  error.response = undefined;
  return error;
}

describe("normalizeApiError", () => {
  it("never surfaces the upstream payload, tokens or passwords", () => {
    const config = { method: "get", url: "/payroll" } as InternalAxiosRequestConfig;
    const normalized = normalizeApiError(makeAxiosError(config, 400));
    const serialized = JSON.stringify(normalized);

    expect(serialized).not.toContain("upstream said no");
    expect(serialized).not.toContain("access_token");
    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("hunter2");
    expect(normalized.status).toBe(400);
    expect(normalized.code).toBe("http_400");
  });

  it("maps HTTP statuses to stable codes and safe copy", () => {
    const config = { method: "get", url: "/leave" } as InternalAxiosRequestConfig;

    expect(normalizeApiError(makeAxiosError(config, 401))).toMatchObject({
      status: 401,
      code: "http_401",
      retryable: false,
    });
    expect(normalizeApiError(makeAxiosError(config, 429)).retryable).toBe(true);
    expect(normalizeApiError(makeAxiosError(config, 503))).toMatchObject({
      status: 503,
      code: "http_503",
      retryable: true,
    });
    // Unknown statuses still fall back to a generic message, never the body.
    const unknown = normalizeApiError(makeAxiosError(config, 418));
    expect(unknown.message).not.toContain("upstream");
    expect(unknown.code).toBe("http_418");
  });

  it("classifies transport failures and timeouts", () => {
    const config = { method: "get", url: "/employees" } as InternalAxiosRequestConfig;
    const network = normalizeApiError(makeNetworkError(config));
    expect(network).toMatchObject({ status: null, code: "network", retryable: true });

    const timeout = new AxiosError("timeout of 15000ms exceeded", "ECONNABORTED", config);
    expect(normalizeApiError(timeout)).toMatchObject({
      status: null,
      code: "timeout",
      retryable: true,
    });

    const canceled = new AxiosError("canceled", "ERR_CANCELED", config);
    expect(normalizeApiError(canceled).retryable).toBe(false);
  });

  it("degrades safely for arbitrary thrown values", () => {
    for (const thrown of [new Error("boom: token=abc123"), "raw string", null, undefined]) {
      const normalized = normalizeApiError(thrown);
      expect(normalized.message.length).toBeGreaterThan(0);
      expect(JSON.stringify(normalized)).not.toContain("abc123");
      expect(normalized.retryable).toBe(false);
    }
  });
});

describe("redactSensitiveString", () => {
  it("redacts JWTs, bearer headers and key=value secrets", () => {
    const input =
      "Authorization: Bearer abcdef1234567890 token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop password=hunter2";
    const redacted = redactSensitiveString(input);

    expect(redacted).not.toContain("abcdef1234567890");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[redacted");
  });

  it("leaves ordinary text intact", () => {
    expect(redactSensitiveString("payroll list failed for tenant 42")).toBe(
      "payroll list failed for tenant 42"
    );
  });
});

describe("retry policy", () => {
  const config = { method: "get", url: "/analytics/department" } as InternalAxiosRequestConfig;

  it("only treats idempotent methods as retryable", () => {
    expect(isIdempotentMethod("GET")).toBe(true);
    expect(isIdempotentMethod("head")).toBe(true);
    expect(isIdempotentMethod("OPTIONS")).toBe(true);
    expect(isIdempotentMethod("post")).toBe(false);
    expect(isIdempotentMethod("put")).toBe(false);
    expect(isIdempotentMethod("delete")).toBe(false);
    expect(isIdempotentMethod(undefined)).toBe(false);
  });

  it("fails fast on deterministic 4xx and retries 429/5xx", () => {
    expect(isRetryableError(makeAxiosError(config, 400))).toBe(false);
    expect(isRetryableError(makeAxiosError(config, 403))).toBe(false);
    expect(isRetryableError(makeAxiosError(config, 404))).toBe(false);
    expect(isRetryableError(makeAxiosError(config, 409))).toBe(false);
    expect(isRetryableError(makeAxiosError(config, 422))).toBe(false);
    expect(isRetryableError(makeAxiosError(config, 408))).toBe(true);
    expect(isRetryableError(makeAxiosError(config, 429))).toBe(true);
    expect(isRetryableError(makeAxiosError(config, 500))).toBe(true);
    expect(isRetryableError(makeAxiosError(config, 504))).toBe(true);
    expect(isRetryableError(makeNetworkError(config))).toBe(true);
  });

  it("bounds an exponential backoff with full jitter", () => {
    const alwaysMax = () => 1;
    const alwaysMin = () => 0;

    expect(computeRetryDelay(0, alwaysMax)).toBe(RETRY_BASE_DELAY_MS);
    expect(computeRetryDelay(1, alwaysMax)).toBe(RETRY_BASE_DELAY_MS * 2);
    expect(computeRetryDelay(0, alwaysMin)).toBe(0);
    expect(computeRetryDelay(99, alwaysMax)).toBe(RETRY_MAX_DELAY_MS);
    expect(computeRetryDelay(-3, alwaysMax)).toBe(RETRY_BASE_DELAY_MS);

    // Jitter must keep the delay inside the ceiling for the attempt.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ceiling = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
      for (const sample of [0.1, 0.5, 0.99]) {
        const delay = computeRetryDelay(attempt, () => sample);
        expect(delay).toBeLessThanOrEqual(ceiling);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("attachRetryInterceptor against a stubbed client", () => {
  function makeClient(handler: (config: InternalAxiosRequestConfig, call: number) => AxiosResponse) {
    const client = axios.create();
    let calls = 0;
    client.defaults.adapter = async (config) => {
      calls += 1;
      return handler(config as InternalAxiosRequestConfig, calls);
    };
    attachRetryInterceptor(client);
    return { client, calls: () => calls };
  }

  it("retries a GET up to the bounded maximum and then succeeds", async () => {
    const { client, calls } = makeClient((config, call) => {
      if (call < 3) throw makeAxiosError(config, 503);
      return makeResponse(config, 200);
    });

    const response = await client.get("/analytics/department");
    expect(response.status).toBe(200);
    expect(calls()).toBe(RETRY_MAX_ATTEMPTS + 1);
  });

  it("stops after the bounded maximum and rejects with the original error", async () => {
    const { client, calls } = makeClient((config) => {
      throw makeAxiosError(config, 502);
    });

    await expect(client.get("/employees")).rejects.toBeInstanceOf(AxiosError);
    expect(calls()).toBe(RETRY_MAX_ATTEMPTS + 1);
  });

  it("does not retry a 400", async () => {
    const { client, calls } = makeClient((config) => {
      throw makeAxiosError(config, 400);
    });

    await expect(client.get("/leave")).rejects.toBeInstanceOf(AxiosError);
    expect(calls()).toBe(1);
  });

  it("never replays a non-idempotent mutation", async () => {
    const { client, calls } = makeClient((config) => {
      throw makeAxiosError(config, 503);
    });

    await expect(client.post("/attendance/clock-in", { employeeId: "a@b.c" })).rejects.toBeInstanceOf(
      AxiosError
    );
    expect(calls()).toBe(1);
  });

  it("only logs through normalized errors, never the raw payload", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = makeClient((config) => {
      throw makeAxiosError(config, 500);
    });

    const error = await client.get("/payroll").catch((e) => e);
    const normalized = normalizeApiError(error);
    console.error(normalized.message);

    const logged = consoleError.mock.calls.flat().join(" ");
    expect(logged).not.toContain("access_token");
    expect(logged).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    consoleError.mockRestore();
  });

  it("exposes a finite default timeout", () => {
    expect(API_TIMEOUT_MS).toBeGreaterThan(0);
    expect(API_TIMEOUT_MS).toBeLessThanOrEqual(60000);
  });
});
