import React from "react";
import type { ViewMode } from "./Sidebar";
import { useRuntime, useControlState, useBridgeStatus } from "@/hooks/use-org-data";
import { useTvMode } from "@/hooks/use-tv-mode";

interface StatusBarProps {
  viewMode: ViewMode;
  lastCommand?: string | null;
  onOpenMinibuffer?: () => void;
}

export default function StatusBar({ viewMode, lastCommand, onOpenMinibuffer }: StatusBarProps) {
  const { data: runtime } = useRuntime();
  const { data: control } = useControlState();
  const { data: bridgeStatus } = useBridgeStatus();
  const { isTvMode } = useTvMode();

  const controlMode = control?.mode || "human";
  const pendingCount = control?.pendingTakeoverPoints?.length || 0;
  const bridgeConnected = bridgeStatus?.extension?.connected || false;

  const budget = runtime?.budget;
  const budgetPct = budget?.percentUsed ?? 0;
  const budgetColor = budgetPct > 80 ? "text-red-400" : budgetPct > 50 ? "text-yellow-400" : "text-green-400";

  return (
    <div
      className={`flex items-center justify-between border-t border-border bg-card shrink-0 cursor-pointer select-none font-mono text-muted-foreground ${
        isTvMode ? "px-4 py-2 text-[20px]" : "px-2 py-1 text-[10px]"
      }`}
      data-testid="status-bar"
      onClick={onOpenMinibuffer}
    >
      <div className={`flex items-center ${isTvMode ? "gap-4" : "gap-3"}`}>
        <span className={runtime?.active ? "text-green-500" : "text-red-500"} data-testid="status-runtime">
          {runtime?.active ? "\u25CF" : "\u25CB"}
        </span>
        <span
          className={`font-bold rounded ${
            isTvMode ? "px-2 py-0.5 text-[18px]" : "px-1.5 py-0.5 text-[9px]"
          } ${
            controlMode === "agent" ? "bg-blue-500/20 text-blue-400" : "bg-orange-500/20 text-orange-400"
          }`}
          data-testid="status-control-mode"
        >
          {controlMode.toUpperCase()}
        </span>
        {pendingCount > 0 && (
          <span className="text-yellow-400 font-bold" data-testid="status-pending-count">
            {pendingCount}
          </span>
        )}
        <span className="text-primary font-bold">{viewMode.toUpperCase()}</span>
        {budget && (
          <span className={budgetColor} data-testid="status-budget" title={`Budget: ${(budget.used || 0).toLocaleString()} / ${(budget.budget || 0).toLocaleString()} tokens (${budgetPct}%) | ~$${(budget.estimatedCostToday || 0).toFixed(4)}`}>
            ${(budget.estimatedCostToday || 0).toFixed(2)} {budgetPct}%
          </span>
        )}
        <span className={bridgeConnected ? "text-green-500" : "text-muted-foreground/40"} data-testid="status-bridge" title={bridgeConnected ? "Bridge connected" : "Bridge offline"}>
          {bridgeConnected ? "\u26A1" : "\u26A1"}
        </span>
        {lastCommand && <span className="text-muted-foreground">\u2014 {lastCommand}</span>}
      </div>
      <div className={`flex items-center ${isTvMode ? "gap-4" : "gap-3"} text-muted-foreground`}>
        <span>M-x / Space</span>
        <span className="text-border">\u2502</span>
        <span>Tab:control</span>
        <span className="text-border">\u2502</span>
        <span>6:cockpit</span>
      </div>
    </div>
  );
}
