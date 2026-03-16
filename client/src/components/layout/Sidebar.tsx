import React from "react";

export type ViewMode = "agenda" | "tree" | "programs" | "results" | "reader" | "cockpit" | "snow";

interface SidebarProps {
  current: ViewMode;
  onSwitch: (mode: ViewMode) => void;
}

const VIEWS: Array<{ mode: ViewMode; label: string; key: string }> = [
  { mode: "agenda", label: "AGD", key: "1" },
  { mode: "tree", label: "TRE", key: "2" },
  { mode: "programs", label: "PRG", key: "3" },
  { mode: "results", label: "RES", key: "4" },
  { mode: "reader", label: "RDR", key: "5" },
  { mode: "cockpit", label: "CKP", key: "6" },
  { mode: "snow", label: "SNW", key: "7" },
];

export default function Sidebar({ current, onSwitch }: SidebarProps) {
  return (
    <div
      className="flex flex-row items-center gap-0 border-b border-border bg-background font-mono text-[10px] px-1"
      data-testid="sidebar"
    >
      {VIEWS.map(v => (
        <button
          key={v.mode}
          data-testid={`nav-${v.mode}`}
          className={`px-2 py-1 cursor-pointer select-none transition-colors ${
            current === v.mode
              ? "text-primary bg-primary/10 font-bold"
              : "text-muted-foreground hover:text-primary"
          }`}
          onClick={() => onSwitch(v.mode)}
        >
          {v.key}:{v.label}
        </button>
      ))}
    </div>
  );
}
