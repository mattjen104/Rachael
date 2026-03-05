import React from "react";
import { cn } from "@/lib/utils";
import { useCrtTheme } from "@/lib/crt-theme";

interface SidebarProps {
  viewMode: "org" | "agenda" | "roam" | "clipboard";
  onSwitchView: (mode: "org" | "agenda" | "roam" | "clipboard") => void;
}

const views: { key: "org" | "agenda" | "roam" | "clipboard"; label: string; icon: string }[] = [
  { key: "clipboard", label: "Capture", icon: "⎘" },
  { key: "agenda", label: "Agenda", icon: "[#]" },
  { key: "roam", label: "Roam", icon: "{*}" },
  { key: "org", label: "Org", icon: "*" },
];

export default function Sidebar({ viewMode, onSwitchView }: SidebarProps) {
  const { cycleTheme, t } = useCrtTheme();

  return (
    <aside className="w-14 border-r border-border bg-card flex flex-col h-full flex-shrink-0 items-center">
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
