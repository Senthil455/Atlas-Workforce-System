const USER_KEY = "atlas_user";

let inMemoryToken: string | null = null;
let _initialized = false;

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return true;
    const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    // pad base64 string for atob/Buffer compatibility
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    let json: string;
    if (typeof atob === "function") {
      json = atob(padded);
    } else {
      // Node fallback (e.g. during SSR)
      json = Buffer.from(padded, "base64").toString("utf-8");
    }
    const payload = JSON.parse(json);
    if (typeof payload.exp === "number") {
      return Date.now() >= payload.exp * 1000;
    }
    return false;
  } catch {
    return true;
  }
}

export function getAccessToken(): string | null {
  return inMemoryToken;
}

export function setTokens(access: string): void {
  inMemoryToken = access;
}

export function clearAuth(): void {
  inMemoryToken = null;
  _initialized = false;
  localStorage.removeItem(USER_KEY);
}

export async function initializeAuth(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  if (_initialized) return true;
  try {
    const res = await fetch("/api/auth/token");
    const data = await res.json();
    if (data.token && !isTokenExpired(data.token)) {
      inMemoryToken = data.token;
      _initialized = true;
      return true;
    }
    // token missing or expired - ensure we do not keep stale user
    if (data.token && isTokenExpired(data.token)) {
      clearAuth();
      // try to clear server cookie as well
      fetch("/api/auth/clear-cookie", { method: "POST" }).catch(() => {});
    }
  } catch {
    // network error — proceed as unauthenticated
  }
  _initialized = true;
  return false;
}

export function isInitialized(): boolean {
  return _initialized;
}

export function setStoredUser(user: object): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getStoredUser<T>(): T | null {
  if (typeof window === "undefined") return null;
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function isAuthenticated(): boolean {
  const token = getAccessToken();
  if (!token) return false;
  if (isTokenExpired(token)) return false;
  return true;
}
