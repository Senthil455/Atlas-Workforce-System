"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { isAuthenticated, isInitialized, initializeAuth } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [ready, setReady] = useState(isInitialized());

  useEffect(() => {
    if (!isInitialized()) {
      initializeAuth().then(() => setReady(true));
    }
  }, []);

  const authenticated = ready && isAuthenticated();

  useEffect(() => {
    if (ready && !authenticated && window.location.pathname !== "/login") {
      const currentPath = window.location.pathname + window.location.search;
      router.replace("/login?redirect=" + encodeURIComponent(currentPath));
    }
  }, [authenticated, ready, router, searchParams]);

  if (!ready || !authenticated) {
    return (
      <div className="flex h-screen items-center justify-center gap-4 p-8">
        <Skeleton className="h-12 w-12 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
