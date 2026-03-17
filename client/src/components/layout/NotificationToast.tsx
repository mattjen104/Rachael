import React, { useState, useEffect, useRef } from "react";

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
        const res = await fetch(`/api/notifications?since=${lastSeenRef.current}`);
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
    fetch(`/api/notifications/${id}/read`, { method: "POST" }).catch(() => {});
  };

  if (toasts.length === 0) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: "3rem",
        right: "0.5rem",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "0.5rem",
        maxWidth: "22rem",
        pointerEvents: "auto",
      }}
      data-testid="notification-toast-container"
    >
      {toasts.slice(0, 3).map((t) => (
        <div
          key={t.id}
          data-testid={`notification-toast-${t.id}`}
          onClick={() => dismiss(t.id)}
          style={{
            background: "#0d1117",
            border: "1px solid #00ff41",
            borderLeft: "3px solid #00ff41",
            padding: "0.5rem 0.75rem",
            fontFamily: "'IBM Plex Mono', monospace",
            fontSize: "0.75rem",
            color: "#00ff41",
            cursor: "pointer",
            animation: "slideIn 0.3s ease-out",
            boxShadow: "0 0 10px rgba(0,255,65,0.15)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.25rem" }}>
            <span style={{ fontWeight: 700 }}>[{t.source.toUpperCase()}]</span>
            <span style={{ opacity: 0.5 }}>x</span>
          </div>
          <div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>{t.label}</div>
          {t.output && (
            <div style={{ opacity: 0.7, whiteSpace: "pre-wrap", maxHeight: "4rem", overflow: "hidden" }}>
              {t.output.slice(0, 120)}{t.output.length > 120 ? "..." : ""}
            </div>
          )}
        </div>
      ))}
      <style>{`
        @keyframes slideIn {
          from { transform: translateX(100%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
