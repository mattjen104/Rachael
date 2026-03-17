import React, { useState, useEffect, useCallback } from "react";
import { useTvMode } from "@/hooks/use-tv-mode";

const TV_OVERLAY_SEEN_KEY = "orgcloud-tv-overlay-seen";

const SHORTCUTS = [
  { keys: "1–8", desc: "Switch views (Agenda, Tree, Programs, Results, Reader, Transcripts, Cockpit, Snow)" },
  { keys: "Space", desc: "Open command palette" },
  { keys: "/", desc: "Search everything" },
  { keys: ":", desc: "Shell / CLI commands" },
  { keys: "c", desc: "Quick capture" },
  { keys: "j / k", desc: "Navigate up / down in lists" },
  { keys: "Enter", desc: "Select / confirm" },
  { keys: "Escape", desc: "Go back / close" },
  { keys: "Tab", desc: "Toggle control mode" },
];

export default function TvShortcutOverlay() {
  const { isTvMode } = useTvMode();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isTvMode) return;
    try {
      if (localStorage.getItem(TV_OVERLAY_SEEN_KEY) !== "1") {
        setVisible(true);
      }
    } catch {}
  }, [isTvMode]);

  const dismiss = useCallback(() => {
    setVisible(false);
    try { localStorage.setItem(TV_OVERLAY_SEEN_KEY, "1"); } catch {}
  }, []);

  useEffect(() => {
    if (!visible) return;
    const handler = () => {
      dismiss();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [visible, dismiss]);

  if (!visible) return null;

  return (
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/85"
      onClick={dismiss}
      data-testid="tv-shortcut-overlay"
    >
      <div className="max-w-[800px] w-full mx-8 font-mono text-foreground">
        <h1 className="text-[48px] font-bold mb-2 phosphor-glow-bright text-center">
          OrgCloud TV Mode
        </h1>
        <p className="text-[24px] text-muted-foreground mb-8 text-center">
          Connect a Bluetooth keyboard and use these shortcuts
        </p>
        <div className="space-y-3">
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="flex items-center gap-6 px-6 py-3 bg-muted/30 rounded">
              <span className="text-[28px] font-bold text-primary w-[140px] shrink-0 text-right phosphor-glow">
                {s.keys}
              </span>
              <span className="text-[22px] text-foreground">
                {s.desc}
              </span>
            </div>
          ))}
        </div>
        <p className="text-[20px] text-muted-foreground mt-8 text-center animate-pulse">
          Press any key to dismiss
        </p>
      </div>
    </div>
  );
}
