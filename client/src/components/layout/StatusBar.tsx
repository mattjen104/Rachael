import React from "react";

interface StatusBarProps {
  viewMode: "mail" | "agenda" | "roam" | "clipboard";
  lastCommand?: string | null;
  onOpenMinibuffer?: () => void;
}

export default function StatusBar({ viewMode, lastCommand, onOpenMinibuffer }: StatusBarProps) {
  const modeLabels: Record<string, string> = {
    mail: "MAIL",
    agenda: "AGENDA",
    roam: "ROAM",
    clipboard: "CAPTURE",
  };

  const viewDescriptions: Record<string, string> = {
    mail: "Outlook/Teams [Live]",
    agenda: "Org Agenda [View]",
    roam: "Backlinks [Graph]",
    clipboard: "Clipboard [Capture]",
  };

  return (
    <div className="h-6 flex w-full font-mono select-none z-50 flex-shrink-0 text-xs">
      <div className="flex items-center justify-center font-bold px-2 uppercase transition-colors phosphor-glow-bright bg-foreground text-background flex-shrink-0">
        {modeLabels[viewMode]}
      </div>

      <div className="bg-muted text-foreground flex items-center px-2 flex-1 min-w-0 gap-2 phosphor-glow-dim overflow-hidden">
        {lastCommand ? (
          <span className="phosphor-glow truncate" data-testid="statusbar-echo">{lastCommand}</span>
        ) : (
          <>
            <span className="font-bold phosphor-glow truncate">
              {viewDescriptions[viewMode]}
            </span>
            <span className="hidden sm:flex items-center gap-1 ml-auto text-muted-foreground flex-shrink-0">
              [✓] Sync
            </span>
          </>
        )}
      </div>

      <button
        onClick={onOpenMinibuffer}
        className="bg-card text-muted-foreground flex items-center px-2 border-t border-border cursor-pointer hover:text-foreground hover:phosphor-glow transition-colors flex-shrink-0"
        data-testid="statusbar-mx-button"
      >
        <span>M-x</span>
      </button>
    </div>
  );
}
