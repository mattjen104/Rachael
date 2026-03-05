import React, { useState, useRef, useEffect, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useHeadingsSearch } from "@/hooks/use-org-data";

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
  onCarryOver: () => void;
  onCommandExecuted: (label: string) => void;
}

export default function Minibuffer({
  onClose,
  onSwitchView,
  onOpenCapture,
  onCycleTheme,
  onCarryOver,
  onCommandExecuted,
}: MinibufferProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<"command" | "search">("command");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const searchQuery = mode === "search" ? query : "";
  const { data: headings = [] } = useHeadingsSearch(searchQuery);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const exec = (label: string, fn: () => void) => {
    fn();
    onCommandExecuted(label);
    onClose();
  };

  const commands: MinibufferCommand[] = useMemo(() => [
    { id: "switch-to-clipboard", label: "switch-to-clipboard", hint: "⎘", action: () => exec("Switched to Clipboard", () => onSwitchView("clipboard")) },
    { id: "switch-to-agenda", label: "switch-to-agenda", hint: "[#]", action: () => exec("Switched to Agenda", () => onSwitchView("agenda")) },
    { id: "switch-to-roam", label: "switch-to-roam", hint: "{*}", action: () => exec("Switched to Roam", () => onSwitchView("roam")) },
    { id: "switch-to-org", label: "switch-to-org", hint: "*", action: () => exec("Switched to Org Buffer", () => onSwitchView("org")) },
    { id: "org-capture", label: "org-capture", hint: "c", action: () => exec("Org Capture", () => onOpenCapture()) },
    { id: "cycle-theme", label: "cycle-theme", hint: "#", action: () => exec("Theme cycled", () => onCycleTheme()) },
    { id: "carry-over-tasks", label: "carry-over-tasks", hint: "", action: () => exec("Tasks carried over", () => onCarryOver()) },
    { id: "search-headings", label: "search-headings", hint: "/", action: () => { setMode("search"); setQuery(""); setSelectedIdx(0); } },
  ], []);

  const filteredCommands = useMemo(() => {
    if (mode === "search") return [];
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
      action: () => exec(`Jumped to ${h.title}`, () => onSwitchView("org")),
    }));
  }, [headings, mode]);

  const items = mode === "search" ? headingItems : filteredCommands;

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (mode === "search") {
        setMode("command");
        setQuery("");
      } else {
        onClose();
      }
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

  const prompt = mode === "search" ? "Search: " : "M-x ";

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

      {items.length === 0 && query.length > 0 && (
        <div className="border-t border-border bg-card px-4 py-1 text-muted-foreground phosphor-glow-dim">
          {mode === "search" ? "No headings found" : "No matching commands"}
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
          data-testid="minibuffer-input"
        />
      </div>
    </div>
  );
}
