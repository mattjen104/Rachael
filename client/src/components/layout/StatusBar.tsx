import React from "react";

interface StatusBarProps {
  viewMode: "org" | "agenda" | "roam" | "clipboard";
  lastCommand?: string | null;
  onOpenMinibuffer?: () => void;
}

export default function StatusBar({ viewMode, lastCommand, onOpenMinibuffer }: StatusBarProps) {
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
      <div className="flex items-center justify-center font-bold px-4 uppercase transition-colors phosphor-glow-bright bg-foreground text-background">
        {modeLabels[viewMode]}
      </div>

      <div className="bg-muted text-foreground flex items-center px-4 flex-1 gap-4 phosphor-glow-dim">
        {lastCommand ? (
          <span className="phosphor-glow" data-testid="statusbar-echo">{lastCommand}</span>
        ) : (
          <>
            <span>Y- main</span>
            <span className="font-bold phosphor-glow">
              {viewDescriptions[viewMode]}
            </span>
            <span className="flex items-center gap-1 ml-auto text-muted-foreground">
              [✓] Sync OK
            </span>
          </>
        )}
      </div>

      <button
        onClick={onOpenMinibuffer}
        className="bg-card text-muted-foreground flex items-center px-4 gap-4 border-t border-border cursor-pointer hover:text-foreground hover:phosphor-glow transition-colors"
        data-testid="statusbar-mx-button"
      >
        <span>M-x</span>
      </button>
    </div>
  );
}
