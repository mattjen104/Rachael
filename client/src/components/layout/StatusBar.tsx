import React from "react";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  file: string;
  mode: "NORMAL" | "INSERT" | "VISUAL";
  viewMode: "unified" | "editor" | "agenda";
}

export default function StatusBar({ file, mode, viewMode }: StatusBarProps) {
  const modeLabel = viewMode === "unified" ? "UNIFIED" : viewMode === "agenda" ? "AGENDA" : mode;

  return (
    <div className="h-6 flex w-full text-xs font-mono select-none z-50 flex-shrink-0">
      <div className="flex items-center justify-center font-bold px-4 uppercase transition-colors phosphor-glow-bright bg-primary text-primary-foreground">
        {modeLabel}
      </div>

      <div className="bg-muted text-foreground flex items-center px-4 flex-1 gap-4 phosphor-glow-dim">
        <span className="flex items-center gap-1">
          Y- main
        </span>
        {viewMode === "unified" ? (
          <>
            <span className="font-semibold text-primary phosphor-glow">
              ≡ All Files
            </span>
            <span className="text-muted-foreground">[Unified]</span>
          </>
        ) : viewMode === "agenda" ? (
          <>
            <span className="font-semibold text-primary phosphor-glow">
              [#] Org Agenda
            </span>
            <span className="text-muted-foreground">[View]</span>
          </>
        ) : (
          <>
            <span className="font-semibold text-primary phosphor-glow">{file}</span>
            <span className="text-muted-foreground">[Org]</span>
          </>
        )}
        <span className="flex items-center gap-1 ml-auto text-secondary phosphor-glow-dim">
          [✓] Sync OK
        </span>
      </div>

      <div className="bg-card text-muted-foreground flex items-center px-4 gap-4 border-t border-border">
        <span>utf-8[unix]</span>
        {viewMode === "editor" && (
          <>
            <span>42%</span>
            <span>11:4</span>
          </>
        )}
      </div>
    </div>
  );
}
