import { useState, useEffect, useRef, useCallback } from "react";
import { getStoredApiKey } from "@/lib/queryClient";

export interface CockpitEvent {
  id: string;
  source: string;
  description: string;
  eventType: "info" | "action" | "take-over-point" | "error";
  sessionId?: string;
  timestamp: number;
  program?: string;
  metadata?: Record<string, unknown>;
}

export function useCockpitEvents() {
  const [events, setEvents] = useState<CockpitEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const apiKey = getStoredApiKey();
    const params = apiKey ? `?token=${encodeURIComponent(apiKey)}` : "";
    const es = new EventSource(`/api/cockpit/events${params}`);
    eventSourceRef.current = es;

    es.onopen = () => setConnected(true);

    es.onmessage = (msg) => {
      try {
        const event: CockpitEvent = JSON.parse(msg.data);
        setEvents(prev => {
          const next = [...prev, event];
          if (next.length > 500) return next.slice(-500);
          return next;
        });
      } catch {}
    };

    es.onerror = () => {
      setConnected(false);
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, []);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, connected, clearEvents };
}
