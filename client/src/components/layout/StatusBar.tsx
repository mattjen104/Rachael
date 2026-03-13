import React from "react";
import type { ViewMode } from "./Sidebar";
import { useRuntime } from "@/hooks/use-org-data";

interface StatusBarProps {
  viewMode: ViewMode;
  lastCommand?: string | null;
  onOpenMinibuffer?: () => void;
}

export default function StatusBar({ viewMode, lastCommand, onOpenMinibuffer }: StatusBarProps) {
  const { data: runtime } = useRuntime();

  return (
    <div
      className="flex items-center justify-between border-t border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground bg-background shrink-0 cursor-pointer select-none"
      data-testid="status-bar"
      onClick={onOpenMinibuffer}
    >
      <div className="flex items-center gap-2">
        <span className={runtime?.active ? "text-green-500" : "text-red-500"}>
          {runtime?.active ? "●" : "○"}
        </span>
        <span className="text-primary font-bold">{viewMode.toUpperCase()}</span>
        {lastCommand && <span className="text-muted-foreground">— {lastCommand}</span>}
      </div>
      <div className="flex items-center gap-2">
        <span>M-x / Space</span>
        <span>j/k:nav</span>
        <span>Tab:fold</span>
      </div>
    </div>
  );
}
