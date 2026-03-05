import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useHeadingsSearch, useOrgFiles } from "@/hooks/use-org-data";

interface MinibufferCommand {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

export interface CaptureData {
  template: "todo" | "note" | "link";
  title: string;
  fileName: string;
  scheduledDate?: string;
  tags?: string[];
  clipboardId?: number;
}

export interface CapturePrefill {
  title?: string;
  clipboardId?: number;
}

type Mode = "command" | "search" | "capture";
type CaptureStep = "template" | "title" | "file" | "scheduled" | "tags";

interface MinibufferProps {
  onClose: () => void;
  onSwitchView: (view: "org" | "agenda" | "roam" | "clipboard") => void;
  onCycleTheme: () => void;
  onCarryOver: () => void;
  onCommandExecuted: (label: string) => void;
  onCapture: (data: CaptureData) => void;
  prefill?: CapturePrefill | null;
  initialMode?: Mode;
}

export default function Minibuffer({
  onClose,
  onSwitchView,
  onCycleTheme,
  onCarryOver,
  onCommandExecuted,
  onCapture,
  prefill,
  initialMode,
}: MinibufferProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<Mode>(initialMode || "command");
  const [captureStep, setCaptureStep] = useState<CaptureStep>("template");
  const [captureData, setCaptureData] = useState<Partial<CaptureData>>(() => ({
    clipboardId: prefill?.clipboardId,
  }));
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedTemplateRef = useRef<"todo" | "note" | "link" | undefined>(undefined);

  const { data: orgFiles = [] } = useOrgFiles();

  const searchQuery = mode === "search" ? query : "";
  const { data: headings = [] } = useHeadingsSearch(searchQuery);

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode, captureStep]);

  const exec = useCallback((label: string, fn: () => void) => {
    fn();
    onCommandExecuted(label);
    onClose();
  }, [onCommandExecuted, onClose]);

  const enterCapture = useCallback(() => {
    setMode("capture");
    setCaptureStep("template");
    setQuery("");
    setSelectedIdx(0);
    setCaptureData({ clipboardId: prefill?.clipboardId });
    selectedTemplateRef.current = undefined;
  }, [prefill]);

  const advanceToTitle = useCallback((template: "todo" | "note" | "link") => {
    selectedTemplateRef.current = template;
    setCaptureData(d => ({ ...d, template }));
    setCaptureStep("title");
    setQuery(prefill?.title || "");
    setSelectedIdx(0);
  }, [prefill]);

  const advanceFromFile = useCallback((template: "todo" | "note" | "link") => {
    if (template === "note" || template === "link") {
      setCaptureStep("tags");
      setQuery("");
    } else {
      setCaptureStep("scheduled");
      setQuery(new Date().toISOString().split("T")[0]);
    }
    setSelectedIdx(0);
  }, []);

  const finalizeCapture = useCallback((currentCaptureData: Partial<CaptureData>, tagsQuery: string) => {
    const tags = tagsQuery.trim()
      ? tagsQuery.split(",").map(t => t.trim()).filter(Boolean)
      : undefined;

    const template = selectedTemplateRef.current || currentCaptureData.template || "note";
    const data: CaptureData = {
      template,
      title: currentCaptureData.title || "",
      fileName: currentCaptureData.fileName || orgFiles[0]?.name || "inbox.org",
      scheduledDate: currentCaptureData.scheduledDate,
      tags,
      clipboardId: currentCaptureData.clipboardId,
    };

    if (!data.title) return;

    onCapture(data);
    onCommandExecuted(`Captured: ${data.title} → ${data.fileName}`);
    onClose();
  }, [orgFiles, onCapture, onCommandExecuted, onClose]);

  const commands: MinibufferCommand[] = useMemo(() => [
    { id: "switch-to-clipboard", label: "switch-to-clipboard", hint: "⎘", action: () => exec("Switched to Clipboard", () => onSwitchView("clipboard")) },
    { id: "switch-to-agenda", label: "switch-to-agenda", hint: "[#]", action: () => exec("Switched to Agenda", () => onSwitchView("agenda")) },
    { id: "switch-to-roam", label: "switch-to-roam", hint: "{*}", action: () => exec("Switched to Roam", () => onSwitchView("roam")) },
    { id: "switch-to-org", label: "switch-to-org", hint: "*", action: () => exec("Switched to Org Buffer", () => onSwitchView("org")) },
    { id: "org-capture", label: "org-capture", hint: "c", action: enterCapture },
    { id: "cycle-theme", label: "cycle-theme", hint: "#", action: () => exec("Theme cycled", () => onCycleTheme()) },
    { id: "carry-over-tasks", label: "carry-over-tasks", hint: "", action: () => exec("Tasks carried over", () => onCarryOver()) },
    { id: "search-headings", label: "search-headings", hint: "/", action: () => { setMode("search"); setQuery(""); setSelectedIdx(0); } },
  ], [exec, onSwitchView, onCycleTheme, onCarryOver, enterCapture]);

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
      action: () => exec(`Jumped to ${h.title}`, () => onSwitchView("org")),
    }));
  }, [headings, mode, exec, onSwitchView]);

  const templateItems: MinibufferCommand[] = useMemo(() => [
    { id: "tpl-todo", label: "[t] todo", hint: "TODO heading with date", action: () => advanceToTitle("todo") },
    { id: "tpl-note", label: "[n] note", hint: "Plain heading", action: () => advanceToTitle("note") },
    { id: "tpl-link", label: "[l] link", hint: "URL reference", action: () => advanceToTitle("link") },
  ], [advanceToTitle]);

  const fileItems: MinibufferCommand[] = useMemo(() => {
    const q = query.toLowerCase();
    const template = selectedTemplateRef.current;
    return orgFiles
      .filter(f => !q || f.name.toLowerCase().includes(q))
      .map(f => ({
        id: `file-${f.id}`,
        label: f.name,
        hint: "",
        action: () => {
          setCaptureData(d => ({ ...d, fileName: f.name }));
          advanceFromFile(template || "note");
        },
      }));
  }, [orgFiles, query, advanceFromFile]);

  const getCaptureItems = (): MinibufferCommand[] => {
    if (captureStep === "template") {
      const q = query.toLowerCase();
      if (!q) return templateItems;
      return templateItems.filter(t => t.label.toLowerCase().includes(q));
    }
    if (captureStep === "file") {
      if (orgFiles.length === 0) return [];
      return fileItems;
    }
    return [];
  };

  const getCapturePrompt = (): string => {
    const template = selectedTemplateRef.current || captureData.template;
    switch (captureStep) {
      case "template": return "Capture template: ";
      case "title": return template === "todo" ? "TODO: " : template === "link" ? "Link: " : "Note: ";
      case "file": return "File: ";
      case "scheduled": return "Scheduled: ";
      case "tags": return "Tags: ";
    }
  };

  const getCaptureHint = (): string => {
    switch (captureStep) {
      case "template": return "Select a capture template";
      case "title": return "Enter title, then ↵";
      case "file": return orgFiles.length === 0 ? "No org files available" : "Pick target file";
      case "scheduled": return "YYYY-MM-DD or ↵ for today";
      case "tags": return "Comma separated, ↵ to skip";
    }
  };

  let items: MinibufferCommand[];
  let prompt: string;

  if (mode === "capture") {
    items = getCaptureItems();
    prompt = getCapturePrompt();
  } else if (mode === "search") {
    items = headingItems;
    prompt = "Search: ";
  } else {
    items = filteredCommands;
    prompt = "M-x ";
  }

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, mode, captureStep]);

  useEffect(() => {
    if (listRef.current) {
      const selected = listRef.current.querySelector("[data-selected='true']");
      if (selected) {
        selected.scrollIntoView({ block: "nearest" });
      }
    }
  }, [selectedIdx]);

  const handleCaptureEnter = () => {
    if (captureStep === "template") {
      const captureItems = getCaptureItems();
      if (captureItems[selectedIdx]) {
        captureItems[selectedIdx].action();
      }
      return;
    }
    if (captureStep === "title") {
      if (!query.trim()) return;
      setCaptureData(d => ({ ...d, title: query.trim() }));
      setCaptureStep("file");
      setQuery("");
      setSelectedIdx(0);
      return;
    }
    if (captureStep === "file") {
      if (orgFiles.length === 0) return;
      const fItems = fileItems;
      if (fItems[selectedIdx]) {
        fItems[selectedIdx].action();
      } else {
        setCaptureData(d => ({ ...d, fileName: orgFiles[0].name }));
        advanceFromFile(selectedTemplateRef.current || "note");
      }
      return;
    }
    if (captureStep === "scheduled") {
      const date = query.trim() || new Date().toISOString().split("T")[0];
      setCaptureData(d => {
        const updated = { ...d, scheduledDate: date };
        setCaptureStep("tags");
        setQuery("");
        setSelectedIdx(0);
        return updated;
      });
      return;
    }
    if (captureStep === "tags") {
      setCaptureData(d => {
        finalizeCapture(d, query);
        return d;
      });
      return;
    }
  };

  const handleCaptureEscape = () => {
    const template = selectedTemplateRef.current;
    if (captureStep === "tags") {
      if (template === "note" || template === "link") {
        setCaptureStep("file");
      } else {
        setCaptureStep("scheduled");
      }
      setQuery("");
    } else if (captureStep === "scheduled") {
      setCaptureStep("file");
      setQuery("");
    } else if (captureStep === "file") {
      setCaptureStep("title");
      setQuery(captureData.title || prefill?.title || "");
    } else if (captureStep === "title") {
      setCaptureStep("template");
      setQuery("");
      selectedTemplateRef.current = undefined;
    } else {
      setMode("command");
      setQuery("");
    }
    setSelectedIdx(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (mode === "capture") {
        handleCaptureEscape();
      } else if (mode === "search") {
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
      if (mode === "capture") {
        handleCaptureEnter();
      } else if (items[selectedIdx]) {
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

      {items.length === 0 && query.length > 0 && mode !== "capture" && (
        <div className="border-t border-border bg-card px-4 py-1 text-muted-foreground phosphor-glow-dim">
          {mode === "search" ? "No headings found" : "No matching commands"}
        </div>
      )}

      {mode === "capture" && (
        <div className="border-t border-border bg-card px-4 py-1 text-muted-foreground">
          {getCaptureHint()}
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
