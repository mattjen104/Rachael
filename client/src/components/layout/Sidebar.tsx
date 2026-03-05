import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOrgFiles } from "@/hooks/use-org-data";
import { useCrtTheme } from "@/lib/crt-theme";

interface SidebarProps {
  activeFile: string;
  onSelectFile: (filename: string) => void;
  toggleClipboard: () => void;
  isClipboardActive: boolean;
  viewMode: "unified" | "editor" | "agenda";
  onSwitchView: (mode: "unified" | "editor" | "agenda") => void;
  onOpenCapture: () => void;
}

export default function Sidebar({ activeFile, onSelectFile, toggleClipboard, isClipboardActive, viewMode, onSwitchView, onOpenCapture }: SidebarProps) {
  const { data: orgFiles = [] } = useOrgFiles();
  const { cycleTheme, t } = useCrtTheme();
  const [filesExpanded, setFilesExpanded] = React.useState(false);

  const icloudStreams = [
    { name: "Camera Roll", count: 12 },
    { name: "Notes App", count: 3 },
    { name: "Files", count: 0 },
  ];

  return (
    <aside className="w-64 border-r border-border bg-card flex flex-col h-full flex-shrink-0">
      <div className="p-3 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2 font-semibold text-primary phosphor-glow-bright">
          <span className="text-sm">#</span>
          <span>OrgCloud Space</span>
        </div>
        <button
          onClick={cycleTheme}
          className="p-1 hover:bg-muted transition-colors text-muted-foreground hover:text-foreground font-mono text-xs"
          title={`Theme: ${t.label}`}
          data-testid="theme-cycle-btn"
        >
          [▣]
        </button>
      </div>

      <div className="flex border-b border-border">
        <button
          onClick={() => onSwitchView("unified")}
          data-testid="view-unified"
          className={cn(
            "flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[10px] font-semibold transition-colors uppercase tracking-wider",
            viewMode === "unified"
              ? "text-primary border-b-2 border-primary bg-primary/5 phosphor-glow"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <span className="text-[10px]">≡</span>
          All
        </button>
        <button
          onClick={() => onSwitchView("editor")}
          data-testid="view-editor"
          className={cn(
            "flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[10px] font-semibold transition-colors uppercase tracking-wider",
            viewMode === "editor"
              ? "text-primary border-b-2 border-primary bg-primary/5 phosphor-glow"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <span className="text-[10px]">{"{}"}</span>
          Edit
        </button>
        <button
          onClick={() => onSwitchView("agenda")}
          data-testid="view-agenda"
          className={cn(
            "flex-1 flex items-center justify-center gap-1 px-2 py-2 text-[10px] font-semibold transition-colors uppercase tracking-wider",
            viewMode === "agenda"
              ? "text-primary border-b-2 border-primary bg-primary/5 phosphor-glow"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <span className="text-[10px]">[#]</span>
          Agenda
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border">
        <button
          onClick={onOpenCapture}
          data-testid="button-capture"
          className="w-full flex items-center gap-2 px-3 py-2 bg-primary/10 text-primary hover:bg-primary/20 transition-colors text-xs font-bold phosphor-glow"
        >
          <span>[+]</span>
          Capture
          <span className="ml-auto text-[9px] text-primary/60 font-mono">c</span>
        </button>
      </div>

      <ScrollArea className="flex-1 py-2">
        <div className="px-3 py-1 mt-2 mb-1">
          <button
            onClick={() => setFilesExpanded(!filesExpanded)}
            className="flex items-center gap-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider w-full hover:text-foreground transition-colors"
            data-testid="toggle-files"
          >
            <span className="text-[10px] w-3 inline-block">{filesExpanded ? "▾" : "▸"}</span>
            <span>Workspace Files</span>
            <span className="text-[9px] ml-auto opacity-60">[{orgFiles.length}]</span>
          </button>
        </div>
        {filesExpanded && (
          <div className="space-y-[2px] px-2 mb-2">
            {orgFiles.map((file) => (
              <button
                key={file.id}
                onClick={() => onSelectFile(file.name)}
                data-testid={`sidebar-file-${file.name}`}
                className={cn(
                  "w-full flex items-center gap-2 px-2 py-1.5 text-sm text-left transition-colors font-mono",
                  activeFile === file.name && viewMode === "editor"
                    ? "bg-primary/10 text-primary phosphor-glow"
                    : "text-foreground hover:bg-muted/50"
                )}
              >
                <span className={cn("text-xs", activeFile === file.name && viewMode === "editor" ? "text-primary" : "text-muted-foreground")}>§</span>
                {file.name}
              </button>
            ))}
          </div>
        )}

        <div className="px-3 py-1 mt-4 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <span className="text-[10px]">▾</span>
          <span>Capture Streams</span>
        </div>
        <div className="space-y-[2px] px-2">
          <button
            onClick={toggleClipboard}
            data-testid="toggle-clipboard"
            className={cn(
              "w-full flex items-center justify-between px-2 py-1.5 text-sm text-left transition-colors font-mono mb-1 group",
              isClipboardActive
                ? "bg-secondary/10 text-secondary phosphor-glow"
                : "text-foreground hover:bg-muted/50"
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs">⎘</span>
              <span>System Clipboard</span>
            </div>
            <span className="text-[10px] text-secondary px-1 opacity-0 group-hover:opacity-100 transition-opacity">
              [live]
            </span>
          </button>

          {icloudStreams.map((stream) => (
            <button
              key={stream.name}
              className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-left transition-colors text-foreground hover:bg-muted/50 group"
            >
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">☁</span>
                <span>{stream.name}</span>
              </div>
              {stream.count > 0 && (
                <span className="text-[10px] font-mono text-primary">
                  [{stream.count}]
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="px-3 py-1 mt-6 mb-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
          <span className="text-[10px]">▾</span>
          <span>Hardware</span>
        </div>
        <div className="space-y-[2px] px-2 pb-4">
          <a
            href="/tui"
            className="w-full flex items-center justify-between px-2 py-1.5 text-sm text-left transition-colors font-mono text-foreground hover:bg-muted/50"
            data-testid="link-tui"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">#</span>
              <span>LilyGO T-Keyboard</span>
            </div>
            <span className="text-[10px] font-mono text-primary">
              [SSH]
            </span>
          </a>
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border flex items-center gap-2 text-xs text-muted-foreground phosphor-glow-dim">
        <span>☁</span>
        <span>iCloud Sync Active</span>
      </div>
    </aside>
  );
}
