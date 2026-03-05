import React from "react";
import { GitBranch, CheckCircle2, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  file: string;
  mode: "NORMAL" | "INSERT" | "VISUAL";
  viewMode: "editor" | "agenda";
}

export default function StatusBar({ file, mode, viewMode }: StatusBarProps) {
  const modeColors = {
    NORMAL: "bg-[#51afef] text-[#282c34]",
    INSERT: "bg-[#98be65] text-[#282c34]",
    VISUAL: "bg-[#c678dd] text-[#282c34]",
  };

  return (
    <div className="h-6 flex w-full text-xs font-mono select-none z-50 flex-shrink-0">
      <div className={cn(
        "flex items-center justify-center font-bold px-4 uppercase transition-colors",
        viewMode === "agenda" ? "bg-[#ECBE7B] text-[#282c34]" : modeColors[mode]
      )}>
        {viewMode === "agenda" ? "AGENDA" : mode}
      </div>

      <div className="bg-[#3f444a] text-[#bbc2cf] flex items-center px-4 flex-1 gap-4">
        <span className="flex items-center gap-1">
          <GitBranch className="w-3 h-3" /> main
        </span>
        {viewMode === "agenda" ? (
          <>
            <span className="font-semibold text-white flex items-center gap-1">
              <Calendar className="w-3 h-3" />
              Org Agenda
            </span>
            <span className="text-[#5B6268]">[View]</span>
          </>
        ) : (
          <>
            <span className="font-semibold text-white">{file}</span>
            <span className="text-[#5B6268]">[Org]</span>
          </>
        )}
        <span className="flex items-center gap-1 ml-auto text-[#98be65]">
          <CheckCircle2 className="w-3 h-3" /> Sync OK
        </span>
      </div>

      <div className="bg-[#21242b] text-[#5B6268] flex items-center px-4 gap-4 border-t border-border">
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
