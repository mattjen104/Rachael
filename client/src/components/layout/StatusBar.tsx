import React from "react";

interface StatusBarProps {
  viewMode: "org" | "agenda" | "roam" | "clipboard";
}

export default function StatusBar({ viewMode }: StatusBarProps) {
  const modeLabels: Record<string, string> = {
    org: "ORG",
    agenda: "AGENDA",
    roam: "ROAM",
    clipboard: "CAPTURE",
  };

  const viewDescriptions: Record<string, string> = {
    org: "All Files [Buffer]",
    agenda: "Org Agenda [View]",
    roam: "Backlinks [Graph]",
    clipboard: "Clipboard [Capture]",
  };

  return (
    <div className="h-6 flex w-full font-mono select-none z-50 flex-shrink-0">
      <div className="flex items-center justify-center font-bold px-4 uppercase transition-colors phosphor-glow-bright bg-primary text-primary-foreground">
        {modeLabels[viewMode]}
      </div>

      <div className="bg-muted text-foreground flex items-center px-4 flex-1 gap-4 phosphor-glow-dim">
        <span>Y- main</span>
        <span className="font-semibold text-primary phosphor-glow">
          {viewDescriptions[viewMode]}
        </span>
        <span className="flex items-center gap-1 ml-auto text-secondary phosphor-glow-dim">
          [✓] Sync OK
        </span>
      </div>

      <div className="bg-card text-muted-foreground flex items-center px-4 gap-4 border-t border-border">
        <span>utf-8[unix]</span>
      </div>
    </div>
  );
}
