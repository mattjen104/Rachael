import React from "react";
import type { ViewMode } from "./Sidebar";
import { useRuntime, useControlState, useBridgeStatus } from "@/hooks/use-org-data";

interface StatusBarProps {
  viewMode: ViewMode;
  lastCommand?: string | null;
  onOpenMinibuffer?: () => void;
}

export default function StatusBar({ viewMode, lastCommand, onOpenMinibuffer }: StatusBarProps) {
  const { data: runtime } = useRuntime();
  const { data: control } = useControlState();
  const { data: bridgeStatus } = useBridgeStatus();

  const controlMode = control?.mode || "human";
  const pendingCount = control?.pendingTakeoverPoints?.length || 0;
  const bridgeConnected = bridgeStatus?.extension?.connected || false;

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
        <span
          className={`px-1 py-0 font-bold text-[9px] rounded ${
            controlMode === "agent" ? "bg-blue-500/20 text-blue-400" : "bg-orange-500/20 text-orange-400"
          }`}
          data-testid="status-control-mode"
        >
          {controlMode.toUpperCase()}
        </span>
        {pendingCount > 0 && (
          <span className="text-yellow-400 font-bold" data-testid="status-pending-count">
            ⚡{pendingCount}
          </span>
        )}
        <span className="text-primary font-bold">{viewMode.toUpperCase()}</span>
        <span className={bridgeConnected ? "text-green-500" : "text-muted-foreground/50"} data-testid="status-bridge" title={bridgeConnected ? "Bridge connected" : "Bridge offline"}>
          {bridgeConnected ? "⚡" : "⚡"}
        </span>
        {lastCommand && <span className="text-muted-foreground">— {lastCommand}</span>}
      </div>
      <div className="flex items-center gap-2">
        <span>M-x / Space</span>
        <span>Tab:control</span>
        <span>6:cockpit</span>
      </div>
    </div>
  );
}
