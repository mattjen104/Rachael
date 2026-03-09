import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useHeadingsSearch, useClipboardItems, useClipboardHistory } from "@/hooks/use-org-data";
import { queryClient, apiRequest } from "@/lib/queryClient";

interface MinibufferCommand {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

interface MinibufferProps {
  onClose: () => void;
  onSwitchView: (view: "org" | "agenda" | "roam" | "clipboard") => void;
  onOpenCapture: () => void;
  onCycleTheme: () => void;
  onCommandExecuted: (label: string) => void;
  onJumpToHeading?: (sourceFile: string, title: string, lineNumber: number) => void;
}

export default function Minibuffer({
  onClose,
  onSwitchView,
  onOpenCapture,
  onCycleTheme,
  onCommandExecuted,
  onJumpToHeading,
}: MinibufferProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<"command" | "search" | "clipboard" | "create-file">("command");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const searchQuery = mode === "search" ? query : "";
  const { data: headings = [] } = useHeadingsSearch(searchQuery);
  const { data: clipboardItems = [] } = useClipboardItems();
  const { data: historyItems = [] } = useClipboardHistory();

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const exec = useCallback((label: string, fn: () => void) => {
    fn();
    onCommandExecuted(label);
    onClose();
  }, [onCommandExecuted, onClose]);

  const commands: MinibufferCommand[] = useMemo(() => [
    { id: "switch-to-clipboard", label: "switch-to-clipboard", hint: "⎘", action: () => exec("Switched to Clipboard", () => onSwitchView("clipboard")) },
    { id: "switch-to-agenda", label: "switch-to-agenda", hint: "[#]", action: () => exec("Switched to Agenda", () => onSwitchView("agenda")) },
    { id: "switch-to-roam", label: "switch-to-roam", hint: "{*}", action: () => exec("Switched to Roam", () => onSwitchView("roam")) },
    { id: "switch-to-org", label: "switch-to-org", hint: "*", action: () => exec("Switched to Org Buffer", () => onSwitchView("org")) },
    { id: "org-capture", label: "org-capture", hint: "c", action: () => exec("Org Capture", () => onOpenCapture()) },
    { id: "cycle-theme", label: "cycle-theme", hint: "#", action: () => exec("Theme cycled", () => onCycleTheme()) },
    { id: "search-headings", label: "search-headings", hint: "/", action: () => { setMode("search"); setQuery(""); setSelectedIdx(0); } },
    { id: "clipboard-search", label: "clipboard-search", hint: "⎘", action: () => { setMode("clipboard"); setQuery(""); setSelectedIdx(0); } },
    { id: "create-file", label: "create-file", hint: "+", action: () => { setMode("create-file"); setQuery(""); setSelectedIdx(0); } },
  ], [exec, onSwitchView, onOpenCapture, onCycleTheme]);

  const filteredCommands = useMemo(() => {
    if (mode !== "command") return [];
    if (!query.trim()) return commands;
    const q = query.toLowerCase();
    return commands.filter(c => c.label.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
  }, [query, commands, mode]);

  const headingItems = useMemo(() => {
    if (mode !== "search") return [];
    return headings.slice(0, 20).map((h) => ({
      id: `heading-${h.sourceFile}-${h.lineNumber}`,
      label: `${"*".repeat(h.level)} ${h.status ? h.status + " " : ""}${h.title}`,
      hint: `${h.sourceFile}:${h.lineNumber}`,
      action: () => {
        if (onJumpToHeading) {
          exec(`Jumped to ${h.title}`, () => onJumpToHeading(h.sourceFile, h.title, h.lineNumber));
        } else {
          exec(`Jumped to ${h.title}`, () => onSwitchView("org"));
        }
      },
    }));
  }, [headings, mode, exec, onSwitchView, onJumpToHeading]);

  const clipboardSearchItems = useMemo(() => {
    if (mode !== "clipboard") return [];
    const all = [...clipboardItems, ...historyItems];
    const q = query.toLowerCase();
    const filtered = q ? all.filter(item =>
      item.content.toLowerCase().includes(q) ||
      (item.urlTitle && item.urlTitle.toLowerCase().includes(q))
    ) : all;
    return filtered.slice(0, 20).map((item) => ({
      id: `clip-${item.id}`,
      label: item.urlTitle || item.content.slice(0, 80).replace(/\n/g, " "),
      hint: item.type,
      action: () => {
        navigator.clipboard.writeText(item.content).then(() => {
          exec("Copied to clipboard", () => {});
        }).catch(() => {
          exec("Copy failed", () => {});
        });
      },
    }));
  }, [clipboardItems, historyItems, query, mode, exec]);

  const items = mode === "search" ? headingItems
    : mode === "clipboard" ? clipboardSearchItems
    : mode === "create-file" ? []
    : filteredCommands;

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, mode]);

  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector("[data-selected='true']");
      if (selected) {
        selected.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIdx]);

  const handleCreateFile = async () => {
    const name = query.trim();
    if (!name) return;
    const fileName = name.endsWith(".org") ? name : `${name}.org`;
    try {
      await apiRequest("POST", "/api/org-files", { name: fileName, content: "" });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      exec(`Created ${fileName}`, () => {});
    } catch {
      exec(`Failed to create ${fileName}`, () => {});
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (mode !== "command") {
        setMode("command");
        setQuery("");
      } else {
        onClose();
      }
      return;
    }
    if (mode === "create-file" && e.key === "Enter") {
      e.preventDefault();
      handleCreateFile();
      return;
    }
    if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) {
      e.preventDefault();
      setSelectedIdx(i => Math.min(i + 1, items.length - 1));
      return;
    }
    if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) {
      e.preventDefault();
      setSelectedIdx(i => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (items[selectedIdx]) {
        items[selectedIdx].action();
      }
      return;
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    if (mode === "command" && val === "/") {
      setMode("search");
      setQuery("");
      return;
    }
    setQuery(val);
  };

  const prompt = mode === "search" ? "Search: "
    : mode === "clipboard" ? "Clipboard: "
    : mode === "create-file" ? "New file: "
    : "M-x ";

  return (
    <div className="flex flex-col w-full font-mono z-50" data-testid="minibuffer">
      {items.length > 0 && (
        <div
          ref={listRef}
          className="max-h-[calc(8*1.4em+16px)] overflow-y-auto border-t border-border bg-card"
          data-testid="minibuffer-completions"
        >
          {items.map((item, i) => (
            <button
              key={item.id}
              data-selected={i === selectedIdx}
              onClick={() => item.action()}
              onMouseEnter={() => setSelectedIdx(i)}
              className={cn(
                "w-full text-left px-4 py-0.5 flex items-center gap-2 transition-colors",
                i === selectedIdx
                  ? "bg-muted text-foreground phosphor-glow"
                  : "text-foreground"
              )}
              data-testid={`minibuffer-item-${item.id}`}
            >
              <span className="flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="text-muted-foreground ml-2 flex-shrink-0">{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {items.length === 0 && query.length > 0 && mode !== "create-file" && (
        <div className="border-t border-border bg-card px-4 py-1 text-muted-foreground phosphor-glow-dim">
          {mode === "search" ? "No headings found" : mode === "clipboard" ? "No matching clips" : "No matching commands"}
        </div>
      )}

      <div className="h-6 flex items-center bg-muted border-t border-border px-4 flex-shrink-0">
        <span className="text-muted-foreground mr-1 flex-shrink-0">{prompt}</span>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent text-foreground outline-none phosphor-glow caret-foreground"
          spellCheck={false}
          autoComplete="off"
          placeholder={mode === "create-file" ? "filename.org" : undefined}
          data-testid="minibuffer-input"
        />
      </div>
    </div>
  );
}
