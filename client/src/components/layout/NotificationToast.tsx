import React, { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { apiUrl } from "@/lib/queryClient";

interface Notification {
  id: string;
  timestamp: number;
  label: string;
  output: string;
  source: string;
  command: string;
  read: boolean;
}

const MAX_TOASTS = 20;

export default function NotificationToast() {
  const [toasts, setToasts] = useState<Notification[]>([]);
  const lastSeenRef = useRef(Date.now());
  const seenIdsRef = useRef(new Set<string>());
  const pollingRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;

    async function poll() {
      if (!mounted || pollingRef.current) return;
      pollingRef.current = true;
      try {
        const res = await fetch(apiUrl(`/api/notifications?since=${lastSeenRef.current}`));
        if (!res.ok || !mounted) return;
        const data = await res.json();
        if (data.notifications && data.notifications.length > 0) {
          const fresh = data.notifications.filter((n: Notification) => !seenIdsRef.current.has(n.id));
          if (fresh.length > 0) {
            fresh.forEach((n: Notification) => seenIdsRef.current.add(n.id));
            const maxTs = Math.max(...fresh.map((n: Notification) => n.timestamp));
            lastSeenRef.current = maxTs;
            setToasts(prev => {
              const merged = [...prev, ...fresh];
              return merged.length > MAX_TOASTS ? merged.slice(-MAX_TOASTS) : merged;
            });
          }
        }
      } catch {} finally {
        pollingRef.current = false;
      }
      if (mounted) timer = setTimeout(poll, 3000);
    }

    timer = setTimeout(poll, 1000);
    return () => { mounted = false; clearTimeout(timer); };
  }, []);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timer = setTimeout(() => {
      setToasts(prev => prev.slice(1));
    }, 6000);
    return () => clearTimeout(timer);
  }, [toasts.length]);

  const dismiss = (id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    fetch(apiUrl(`/api/notifications/${id}/read`), { method: "POST" }).catch(() => {});
  };

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed top-12 right-2 z-[9999] flex flex-col gap-2 max-w-[22rem] pointer-events-auto"
      data-testid="notification-toast-container"
    >
      <AnimatePresence>
        {toasts.slice(0, 3).map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            transition={{ duration: 0.15 }}
            data-testid={`notification-toast-${t.id}`}
            onClick={() => dismiss(t.id)}
            className="bg-card border border-border border-l-2 border-l-primary px-3 py-2 font-mono text-xs text-foreground cursor-pointer rounded"
          >
            <div className="flex justify-between mb-1">
              <span className="font-bold text-primary">[{t.source.toUpperCase()}]</span>
              <span className="text-muted-foreground">x</span>
            </div>
            <div className="font-semibold mb-1">{t.label}</div>
            {t.output && (
              <div className="text-muted-foreground whitespace-pre-wrap max-h-16 overflow-hidden">
                {t.output.slice(0, 120)}{t.output.length > 120 ? "..." : ""}
              </div>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
