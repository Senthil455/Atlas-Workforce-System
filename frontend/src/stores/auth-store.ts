import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { User } from "@/types";
import {
  clearAuth,
  initializeAuth,
  setStoredUser,
  setTokens,
} from "@/lib/auth";
import { authApi } from "@/lib/api";

interface AuthState {
  user: User | null;
  isLoading: boolean;
  mfaRequired: boolean;
  mfaChallengeToken: string | null;
  login: (email: string, password: string) => Promise<{ mfaRequired: boolean; mfaChallengeToken?: string }>;
  validateMfa: (code: string, isBackupCode?: boolean) => Promise<void>;
  register: (data: {
    email: string;
    password: string;
    name: string;
    department?: string;
    position?: string;
  }) => Promise<void>;
  logout: () => void;
  setUser: (user: User | null) => void;
  initialize: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isLoading: false,
      mfaRequired: false,
      mfaChallengeToken: null,
      setUser: (user) => set({ user }),
      initialize: async () => {
        await initializeAuth();
      },
      login: async (email, password) => {
        set({ isLoading: true });
        try {
          const result = await authApi.login(email, password);
          // MFA required - do not set session yet, store challenge token for second step
          if (result.mfa_required && result.mfa_challenge_token) {
            set({ isLoading: false, mfaRequired: true, mfaChallengeToken: result.mfa_challenge_token });
            return { mfaRequired: true, mfaChallengeToken: result.mfa_challenge_token };
          }
          // Normal login - token must be present and challenge must not be valid for protected routes
          if (!result.token || !result.user) {
            throw new Error("Invalid login response");
          }
          setTokens(result.token);
          setStoredUser(result.user as User);
          await fetch("/api/auth/set-cookie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: result.token }),
          });
          set({ user: result.user as User, isLoading: false, mfaRequired: false, mfaChallengeToken: null });
          return { mfaRequired: false };
        } catch (e) {
          set({ isLoading: false });
          throw e;
        }
      },
      validateMfa: async (code, isBackupCode = false) => {
        const { mfaChallengeToken } = get();
        if (!mfaChallengeToken) throw new Error("No MFA challenge in progress");
        set({ isLoading: true });
        try {
          const result = await authApi.validateMfa(mfaChallengeToken, code, isBackupCode);
          setTokens(result.token);
          setStoredUser(result.user as User);
          await fetch("/api/auth/set-cookie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: result.token }),
          });
          set({ user: result.user as User, isLoading: false, mfaRequired: false, mfaChallengeToken: null });
        } catch (e) {
          set({ isLoading: false });
          throw e;
        }
      },
      register: async (payload) => {
        set({ isLoading: true });
        try {
          await authApi.register(payload);
          const result = await authApi.login(payload.email, payload.password);
          if (result.mfa_required && result.mfa_challenge_token) {
            set({ isLoading: false, mfaRequired: true, mfaChallengeToken: result.mfa_challenge_token });
            return;
          }
          if (!result.token || !result.user) throw new Error("Invalid register login response");
          setTokens(result.token);
          setStoredUser(result.user as User);
          await fetch("/api/auth/set-cookie", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ token: result.token }),
          });
          set({ user: result.user as User, isLoading: false, mfaRequired: false, mfaChallengeToken: null });
        } catch (e) {
          set({ isLoading: false });
          throw e;
        }
      },
      logout: async () => {
        try {
          await authApi.logout();
        } catch {
          // proceed with local cleanup regardless
        }
        clearAuth();
        set({ user: null, mfaRequired: false, mfaChallengeToken: null });
        await fetch("/api/auth/clear-cookie", { method: "POST" }).catch(() => {});
        if (typeof window !== "undefined") window.location.href = "/login";
      },
    }),
    {
      name: "atlas-auth",
      partialize: (s) => ({ user: s.user }),
    }
  )
);
