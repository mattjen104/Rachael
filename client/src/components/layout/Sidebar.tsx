import React from "react";
import { cn } from "@/lib/utils";
import { useCrtTheme } from "@/lib/crt-theme";

interface SidebarProps {
  viewMode: "org" | "agenda" | "roam" | "clipboard";
  onSwitchView: (mode: "org" | "agenda" | "roam" | "clipboard") => void;
}

const views: { key: "org" | "agenda" | "roam" | "clipboard"; label: string; icon: string }[] = [
  { key: "org", label: "Org", icon: "*" },
  { key: "agenda", label: "Agenda", icon: "[#]" },
  { key: "roam", label: "Roam", icon: "{*}" },
  { key: "clipboard", label: "Capture", icon: "⎘" },
];

export default function Sidebar({ viewMode, onSwitchView }: SidebarProps) {
  const { cycleTheme, t } = useCrtTheme();

  return (
    <aside className="w-14 border-r border-border bg-card flex flex-col h-full flex-shrink-0 items-center">
      <div className="py-3 border-b border-border w-full flex items-center justify-center">
        <button
          onClick={cycleTheme}
          className="text-primary phosphor-glow-bright font-bold text-sm"
          title={`Theme: ${t.label}`}
          data-testid="theme-cycle-btn"
        >
          #
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center py-3 gap-1 w-full">
        {views.map((v) => (
          <button
            key={v.key}
            onClick={() => onSwitchView(v.key)}
            data-testid={`view-${v.key}`}
            className={cn(
              "w-full flex flex-col items-center py-2 px-1 transition-colors text-center",
              viewMode === v.key
                ? "text-primary bg-primary/10 border-r-2 border-primary phosphor-glow"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
            title={v.label}
          >
            <span className="text-[10px] font-bold">{v.icon}</span>
            <span className="text-[8px] uppercase tracking-wider mt-0.5 font-semibold">{v.label}</span>
          </button>
        ))}
      </div>

      <div className="py-3 border-t border-border w-full flex items-center justify-center">
        <span className="text-[8px] text-muted-foreground phosphor-glow-dim" title="iCloud Sync Active">☁</span>
      </div>
    </aside>
  );
}
