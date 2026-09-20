"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { getAccessToken } from "@/lib/auth";

const SSE_BASE = process.env.NEXT_PUBLIC_SSE_URL ?? "http://localhost:8080/api/live/sse";

interface SSEEvent {
  channel: string;
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export function useSSE(channel: string, enabled = true) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let mounted = true;

    function connect() {
      if (!mounted) return;
      const token = getAccessToken();
      const url = token ? `${SSE_BASE}/${channel}?token=${encodeURIComponent(token)}` : `${SSE_BASE}/${channel}`;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };

      es.onmessage = (msg) => {
        if (!mounted || !msg.data) return;
        try {
          const parsed = JSON.parse(msg.data) as SSEEvent;
          setEvents((prev) => [parsed, ...prev].slice(0, 200));
        } catch { /* ignore parse errors */ }
      };

      es.addEventListener("error", () => {
        setConnected(false);
        es.close();
        if (!mounted) return;
        retryRef.current++;
        const delay = Math.min(1000 * Math.pow(2, Math.min(retryRef.current, 5)), 30000);
        setTimeout(connect, delay);
      });
    }

    connect();
    return () => {
      mounted = false;
      eventSourceRef.current?.close();
    };
  }, [channel, enabled]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, connected, clear };
}

export function useSSEChannel<T = Record<string, unknown>>(channel: string, enabled = true) {
  const { events, connected } = useSSE(channel, enabled);
  const latest = events[0]?.data as T | undefined;
  return { events: events as { channel: string; event: string; data: T; timestamp: string }[], latest, connected };
}
