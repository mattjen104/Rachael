import React from "react";
import { Folder, FileText, Cloud, Clipboard, ChevronDown, Hash } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface SidebarProps {
  activeFile: string;
  onSelectFile: (filename: string) => void;
  toggleClipboard: () => void;
  isClipboardActive: boolean;
}

export default function Sidebar({ activeFile, onSelectFile, toggleClipboard, isClipboardActive }: SidebarProps) {
  const files = [
    { name: "dad.org", type: "org" },
    { name: "inbox.org", type: "org" },
    { name: "projects.org", type: "org" },
    { name: "journal.org", type: "org" },
    { name: "someday.org", type: "org" },
  ];

  const icloudStreams = [
    { name: "Camera Roll", count: 12 },
    { name: "Notes App", count: 3 },
    { name: "Files", count: 0 },
  ];

  return (
    <aside className="w-64 border-r border-border bg-[#21242b] flex flex-col h-full flex-shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-primary">
          <Hash className="w-4 h-4" />
          <span>OrgCloud Space</span>
        </div>
      </div>
      
      <ScrollArea className="flex-1 py-2">
        <div className="px-3 py-1 mt-2 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
          <div className="flex items-center gap-1">
            <ChevronDown className="w-3 h-3" />
            <span>Workspace</span>
          </div>
        </div>
        <div className="space-y-[2px] px-2">
          {files.map((file) => (
            <button
              key={file.name}
              onClick={() => onSelectFile(file.name)}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left transition-colors font-mono",
                activeFile === file.name 
                  ? "bg-primary/10 text-primary" 
                  : "text-foreground hover:bg-muted/50"
              )}
            >
              <FileText className={cn("w-4 h-4", activeFile === file.name ? "text-primary" : "text-muted-foreground")} />
              {file.name}
            </button>
          ))}
        </div>

        <div className="px-3 py-1 mt-6 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <ChevronDown className="w-3 h-3" />
          <span>Capture Streams</span>
        </div>
        <div className="space-y-[2px] px-2">
          <button
            onClick={toggleClipboard}
            className={cn(
              "w-full flex items-center justify-between px-2 py-1.5 rounded-sm text-sm text-left transition-colors font-mono mb-1 group",
              isClipboardActive 
                ? "bg-secondary/10 text-secondary" 
                : "text-foreground hover:bg-muted/50"
            )}
          >
            <div className="flex items-center gap-2">
              <Clipboard className={cn("w-4 h-4", isClipboardActive ? "text-secondary" : "text-[#c678dd]")} />
              <span>System Clipboard</span>
            </div>
            <span className="text-[10px] bg-secondary/20 text-secondary px-1.5 rounded-full opacity-0 group-hover:opacity-100 transition-opacity">
              live
            </span>
          </button>

          {icloudStreams.map((stream) => (
            <button
              key={stream.name}
              className="w-full flex items-center justify-between px-2 py-1.5 rounded-sm text-sm text-left transition-colors text-foreground hover:bg-muted/50 group"
            >
              <div className="flex items-center gap-2">
                <Cloud className="w-4 h-4 text-[#51afef]" />
                <span>{stream.name}</span>
              </div>
              {stream.count > 0 && (
                <span className="text-[10px] font-mono bg-primary/20 text-primary px-1.5 rounded-full">
                  {stream.count}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="px-3 py-1 mt-6 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <ChevronDown className="w-3 h-3" />
          <span>Hardware</span>
        </div>
        <div className="space-y-[2px] px-2 pb-4">
          <a
            href="/tui"
            className="w-full flex items-center justify-between px-2 py-1.5 rounded-sm text-sm text-left transition-colors font-mono text-foreground hover:bg-muted/50"
          >
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4 text-[#98be65]" />
              <span>LilyGO T-Keyboard</span>
            </div>
            <span className="text-[10px] bg-[#98be65]/20 text-[#98be65] px-1.5 rounded-full">
              SSH
            </span>
          </a>
        </div>
      </ScrollArea>
      
      <div className="p-3 border-t border-border flex items-center gap-2 text-xs text-muted-foreground">
        <Cloud className="w-3 h-3 text-[#98be65]" />
        <span>iCloud Sync Active</span>
      </div>
    </aside>
  );
}
