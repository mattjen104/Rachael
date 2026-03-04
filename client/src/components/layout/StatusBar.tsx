import React from "react";
import { Cloud, GitBranch, AlertCircle, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface StatusBarProps {
  file: string;
  mode: "NORMAL" | "INSERT" | "VISUAL";
}

export default function StatusBar({ file, mode }: StatusBarProps) {
  // Doom Emacs style mode colors
  const modeColors = {
    NORMAL: "bg-[#51afef] text-[#282c34]", // Blue
    INSERT: "bg-[#98be65] text-[#282c34]", // Green
    VISUAL: "bg-[#c678dd] text-[#282c34]", // Purple
  };

  return (
    <div className="h-6 flex w-full text-xs font-mono select-none z-50 flex-shrink-0">
      {/* Mode Indicator */}
      <div className={cn(
        "flex items-center justify-center font-bold px-4 uppercase transition-colors",
        modeColors[mode]
      )}>
        {mode}
      </div>

      {/* File Info */}
      <div className="bg-[#3f444a] text-[#bbc2cf] flex items-center px-4 flex-1 gap-4">
        <span className="flex items-center gap-1">
          <GitBranch className="w-3 h-3" /> main
        </span>
        <span className="font-semibold text-white">{file}</span>
        <span className="text-[#5B6268]">[Org]</span>
        <span className="flex items-center gap-1 ml-auto text-[#98be65]">
          <CheckCircle2 className="w-3 h-3" /> Sync OK
        </span>
      </div>

      {/* Right side stats */}
      <div className="bg-[#21242b] text-[#5B6268] flex items-center px-4 gap-4 border-t border-border">
        <span>utf-8[unix]</span>
        <span>42%</span>
        <span>11:4</span> {/* Row:Col mock */}
      </div>
    </div>
  );
}
