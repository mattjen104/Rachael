import React from "react";
import { cn } from "@/lib/utils";
import { useCrtTheme } from "@/lib/crt-theme";

export type ViewMode = "outliner" | "agenda" | "control";

interface SidebarProps {
  viewMode: ViewMode;
  onSwitchView: (mode: ViewMode) => void;
}

const views: { key: ViewMode; label: string; icon: string }[] = [
  { key: "agenda", label: "Agenda", icon: "☰" },
  { key: "outliner", label: "Outliner", icon: "{*}" },
  { key: "control", label: "Control", icon: "⌘" },
];

export default function Sidebar({ viewMode, onSwitchView }: SidebarProps) {
  const { cycleTheme, t } = useCrtTheme();

  return (
    <aside className="w-10 border-r border-border bg-card flex flex-col h-full flex-shrink-0 items-center">
      <div className="py-2 border-b border-border w-full flex items-center justify-center">
        <button
          onClick={cycleTheme}
          className="text-foreground phosphor-glow font-bold"
          title={`Theme: ${t.label}`}
          data-testid="theme-cycle-btn"
        >
          #
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center py-2 gap-0.5 w-full">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => onSwitchView(v.key)}
            data-testid={`view-${v.key}`}
            className={cn(
              "w-full flex flex-col items-center py-2 px-1 transition-colors text-center",
              viewMode === v.key
                ? "text-foreground bg-muted border-r-2 border-foreground phosphor-glow"
                : "text-muted-foreground hover:text-foreground"
            )}
            title={v.label}
          >
            <span className="font-bold">{v.icon}</span>
          </button>
        ))}
      </div>

      <div className="py-2 border-t border-border w-full flex items-center justify-center">
        <span className="text-muted-foreground phosphor-glow-dim" title="iCloud Sync Active">☁</span>
      </div>
    </aside>
  );
}
