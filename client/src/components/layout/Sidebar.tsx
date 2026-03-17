import React from "react";
import { useTvMode } from "@/hooks/use-tv-mode";

export type ViewMode = "agenda" | "tree" | "programs" | "results" | "reader" | "transcripts" | "cockpit" | "snow";

interface SidebarProps {
  current: ViewMode;
  onSwitch: (mode: ViewMode) => void;
}

const VIEWS: Array<{ mode: ViewMode; label: string; fullLabel: string; key: string }> = [
  { mode: "agenda", label: "AGD", fullLabel: "Agenda", key: "1" },
  { mode: "tree", label: "TRE", fullLabel: "Tree", key: "2" },
  { mode: "programs", label: "PRG", fullLabel: "Programs", key: "3" },
  { mode: "results", label: "RES", fullLabel: "Results", key: "4" },
  { mode: "reader", label: "RDR", fullLabel: "Reader", key: "5" },
  { mode: "transcripts", label: "TRS", fullLabel: "Transcripts", key: "6" },
  { mode: "cockpit", label: "CKP", fullLabel: "Cockpit", key: "7" },
  { mode: "snow", label: "SNW", fullLabel: "Snow", key: "8" },
];

export default function Sidebar({ current, onSwitch }: SidebarProps) {
  const { isTvMode } = useTvMode();

  return (
    <div
      className={`flex flex-row items-center gap-0 border-b border-border bg-background font-mono ${
        isTvMode ? "text-[22px] px-3 py-1" : "text-[10px] px-1"
      }`}
      data-testid="sidebar"
    >
      {VIEWS.map(v => (
        <button
          key={v.mode}
          data-testid={`nav-${v.mode}`}
          className={`cursor-pointer select-none transition-colors tv-focus-ring ${
            isTvMode ? "px-5 py-3" : "px-2 py-1"
          } ${
            current === v.mode
              ? "text-primary bg-primary/10 font-bold"
              : "text-muted-foreground hover:text-primary"
          }`}
          onClick={() => onSwitch(v.mode)}
        >
          {v.key}:{isTvMode ? v.fullLabel : v.label}
        </button>
      ))}
    </div>
  );
}
