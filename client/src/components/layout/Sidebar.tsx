import React from "react";
import { FileText, Cloud, Clipboard, ChevronDown, Hash, Calendar, Code, Plus, Monitor } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOrgFiles } from "@/hooks/use-org-data";
import { useCrtTheme, PHOSPHOR_PROFILES, type ThemeKey } from "@/lib/crt-theme";

interface SidebarProps {
  activeFile: string;
  onSelectFile: (filename: string) => void;
  toggleClipboard: () => void;
  isClipboardActive: boolean;
  viewMode: "editor" | "agenda";
  onSwitchView: (mode: "editor" | "agenda") => void;
  onOpenCapture: () => void;
}

export default function Sidebar({ activeFile, onSelectFile, toggleClipboard, isClipboardActive, viewMode, onSwitchView, onOpenCapture }: SidebarProps) {
  const { data: orgFiles = [] } = useOrgFiles();
  const { theme, cycleTheme, t } = useCrtTheme();

  const icloudStreams = [
    { name: "Camera Roll", count: 12 },
    { name: "Notes App", count: 3 },
    { name: "Files", count: 0 },
  ];

  return (
    <aside className="w-64 border-r border-border bg-card flex flex-col h-full flex-shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-primary phosphor-glow-bright">
          <Hash className="w-4 h-4" />
          <span>OrgCloud Space</span>
        </div>
        <button
          onClick={cycleTheme}
          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
          title={`Theme: ${t.label}`}
          data-testid="theme-cycle-btn"
        >
          <Monitor className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="flex border-b border-border">
        <button
          onClick={() => onSwitchView("editor")}
          data-testid="view-editor"
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold transition-colors",
            viewMode === "editor"
              ? "text-primary border-b-2 border-primary bg-primary/5 phosphor-glow"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Code className="w-3 h-3" />
          Editor
        </button>
        <button
          onClick={() => onSwitchView("agenda")}
          data-testid="view-agenda"
          className={cn(
            "flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold transition-colors",
            viewMode === "agenda"
              ? "text-primary border-b-2 border-primary bg-primary/5 phosphor-glow"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <Calendar className="w-3 h-3" />
          Agenda
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={onOpenCapture}
          data-testid="button-capture"
          className="w-full flex items-center gap-2 px-3 py-2 rounded-sm bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs font-bold phosphor-glow"
        >
          <Plus className="w-3.5 h-3.5" />
          Capture
          <span className="ml-auto text-[9px] text-primary/60 font-mono">c</span>
        </button>
      </div>

      <ScrollArea className="flex-1 py-2">
        <div className="px-3 py-1 mt-2 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center justify-between">
          <div className="flex items-center gap-1">
            <ChevronDown className="w-3 h-3" />
            <span>Workspace</span>
          </div>
        </div>
        <div className="space-y-[2px] px-2">
          {orgFiles.map((file) => (
            <button
              key={file.id}
              onClick={() => onSelectFile(file.name)}
              data-testid={`sidebar-file-${file.name}`}
              className={cn(
                "w-full flex items-center gap-2 px-2 py-1.5 rounded-sm text-sm text-left transition-colors font-mono",
                activeFile === file.name && viewMode === "editor"
                  ? "bg-primary/10 text-primary phosphor-glow"
                  : "text-foreground hover:bg-muted/50"
              )}
            >
              <FileText className={cn("w-4 h-4", activeFile === file.name && viewMode === "editor" ? "text-primary" : "text-muted-foreground")} />
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
            data-testid="toggle-clipboard"
            className={cn(
              "w-full flex items-center justify-between px-2 py-1.5 rounded-sm text-sm text-left transition-colors font-mono mb-1 group",
              isClipboardActive
                ? "bg-secondary/10 text-secondary phosphor-glow"
                : "text-foreground hover:bg-muted/50"
            )}
          >
            <div className="flex items-center gap-2">
              <Clipboard className="w-4 h-4" />
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
                <Cloud className="w-4 h-4 text-muted-foreground" />
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
            data-testid="link-tui"
          >
            <div className="flex items-center gap-2">
              <Hash className="w-4 h-4 text-muted-foreground" />
              <span>LilyGO T-Keyboard</span>
            </div>
            <span className="text-[10px] bg-primary/20 text-primary px-1.5 rounded-full">
              SSH
            </span>
          </a>
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border flex items-center gap-2 text-xs text-muted-foreground phosphor-glow-dim">
        <Cloud className="w-3 h-3" />
        <span>iCloud Sync Active</span>
      </div>
    </aside>
  );
}
