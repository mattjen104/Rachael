import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useSearch, useSmartCapture, useToggleRuntime, useCreateReaderPage, usePrograms, useProposals, useTasks } from "@/hooks/use-org-data";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { ViewMode } from "@/components/layout/Sidebar";

interface MinibufferCommand {
  id: string;
  label: string;
  hint?: string;
  action: () => void;
}

interface MinibufferProps {
  initialMode?: "command" | "search" | "capture" | "add-url";
  onClose: () => void;
  onSwitchView: (view: ViewMode) => void;
  onNavigate: (view: string, id?: number) => void;
  onCycleTheme: () => void;
  onCommandExecuted: (label: string) => void;
}

export default function Minibuffer({
  initialMode = "command",
  onClose,
  onSwitchView,
  onNavigate,
  onCycleTheme,
  onCommandExecuted,
}: MinibufferProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<"command" | "search" | "capture" | "add-url">(initialMode);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const searchQuery = mode === "search" ? query : "";
  const { data: searchResults = [] } = useSearch(searchQuery);
  const smartCapture = useSmartCapture();
  const toggleRuntime = useToggleRuntime();
  const createReaderPage = useCreateReaderPage();
  const { data: allPrograms = [] } = usePrograms();
  const { data: pendingProposals = [] } = useProposals("pending");
  const { data: allTasks = [] } = useTasks();

  useEffect(() => {
    inputRef.current?.focus();
  }, [mode]);

  const exec = useCallback((label: string, fn: () => void) => {
    fn();
    onCommandExecuted(label);
    onClose();
  }, [onCommandExecuted, onClose]);

  const triggerProgram = useCallback(async (id: number, name: string) => {
    await apiRequest("POST", `/api/programs/${id}/trigger`);
    queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
    onCommandExecuted(`Triggered: ${name}`);
    onClose();
  }, [onCommandExecuted, onClose]);

  const toggleProgram = useCallback(async (id: number, name: string) => {
    await apiRequest("POST", `/api/programs/${id}/toggle`);
    queryClient.invalidateQueries({ queryKey: ["/api/programs"] });
    onCommandExecuted(`Toggled: ${name}`);
    onClose();
  }, [onCommandExecuted, onClose]);

  const toggleTaskDone = useCallback(async (id: number, title: string) => {
    await apiRequest("POST", `/api/tasks/${id}/toggle`);
    queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
    onCommandExecuted(`Toggled: ${title}`);
    onClose();
  }, [onCommandExecuted, onClose]);

  const rescheduleTask = useCallback(async (id: number, title: string, date: string) => {
    await apiRequest("PATCH", `/api/tasks/${id}`, { scheduledDate: date });
    queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
    queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
    onCommandExecuted(`Rescheduled: ${title} → ${date}`);
    onClose();
  }, [onCommandExecuted, onClose]);

  const resolveProposal = useCallback(async (id: number, action: "accept" | "reject") => {
    await apiRequest("POST", `/api/proposals/${id}/${action}`);
    queryClient.invalidateQueries({ queryKey: ["/api/proposals"] });
    onCommandExecuted(`Proposal ${action}ed`);
    onClose();
  }, [onCommandExecuted, onClose]);

  const commands: MinibufferCommand[] = useMemo(() => {
    const cmds: MinibufferCommand[] = [
      { id: "switch-agenda", label: "switch-to-agenda", hint: "1", action: () => exec("Agenda", () => onSwitchView("agenda")) },
      { id: "switch-tree", label: "switch-to-tree", hint: "2", action: () => exec("Tree", () => onSwitchView("tree")) },
      { id: "switch-programs", label: "switch-to-programs", hint: "3", action: () => exec("Programs", () => onSwitchView("programs")) },
      { id: "switch-results", label: "switch-to-results", hint: "4", action: () => exec("Results", () => onSwitchView("results")) },
      { id: "switch-reader", label: "switch-to-reader", hint: "5", action: () => exec("Reader", () => onSwitchView("reader")) },
      { id: "capture", label: "capture", hint: "c", action: () => { setMode("capture"); setQuery(""); setSelectedIdx(0); } },
      { id: "quick-capture", label: "quick-capture", hint: "q", action: () => { setMode("capture"); setQuery(""); setSelectedIdx(0); } },
      { id: "search", label: "search-all", hint: "/", action: () => { setMode("search"); setQuery(""); setSelectedIdx(0); } },
      { id: "add-url", label: "read-url", hint: "u", action: () => { setMode("add-url"); setQuery(""); setSelectedIdx(0); } },
      { id: "cycle-theme", label: "cycle-theme", hint: "#", action: () => exec("Theme cycled", () => onCycleTheme()) },
      { id: "toggle-runtime", label: "toggle-runtime", hint: "R", action: () => exec("Runtime toggled", () => toggleRuntime.mutate()) },
      { id: "refresh", label: "refresh-all", hint: "r", action: () => exec("Refreshed", () => queryClient.invalidateQueries()) },
      { id: "launch-bridge", label: "launch-browser-bridge", action: () => exec("Launching bridge...", () => { apiRequest("POST", "/api/bridge/launch"); }) },
      { id: "close-bridge", label: "close-browser-bridge", action: () => exec("Closing bridge", () => { apiRequest("POST", "/api/bridge/close"); }) },
      { id: "fetch-mail", label: "fetch-outlook-inbox", action: () => exec("Fetching inbox...", () => { queryClient.invalidateQueries({ queryKey: ["/api/mail/inbox"] }); }) },
      { id: "fetch-chats", label: "fetch-teams-chats", action: () => exec("Fetching chats...", () => { queryClient.invalidateQueries({ queryKey: ["/api/chat/list"] }); }) },
    ];

    for (const prog of allPrograms) {
      cmds.push({
        id: `trigger-${prog.name}`,
        label: `run-program: ${prog.name}`,
        action: () => triggerProgram(prog.id, prog.name),
      });
      cmds.push({
        id: `toggle-${prog.name}`,
        label: `toggle-program: ${prog.name} [${prog.enabled ? "ON" : "OFF"}]`,
        action: () => toggleProgram(prog.id, prog.name),
      });
      cmds.push({
        id: `results-${prog.name}`,
        label: `view-results: ${prog.name}`,
        action: () => { onSwitchView("results"); onCommandExecuted(`Results: ${prog.name}`); onClose(); },
      });
    }

    for (const prop of pendingProposals) {
      cmds.push({
        id: `approve-proposal-${prop.id}`,
        label: `approve-proposal: ${prop.section} — ${prop.reason.slice(0, 40)}`,
        action: () => resolveProposal(prop.id, "accept"),
      });
      cmds.push({
        id: `reject-proposal-${prop.id}`,
        label: `reject-proposal: ${prop.section} — ${prop.reason.slice(0, 40)}`,
        action: () => resolveProposal(prop.id, "reject"),
      });
    }

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    const nextWeekStr = nextWeek.toISOString().split("T")[0];

    for (const task of allTasks.filter(t => t.status !== "DONE")) {
      cmds.push({
        id: `done-task-${task.id}`,
        label: `mark-done: ${task.title}`,
        action: () => toggleTaskDone(task.id, task.title),
      });
      cmds.push({
        id: `reschedule-tomorrow-${task.id}`,
        label: `reschedule-tomorrow: ${task.title}`,
        action: () => rescheduleTask(task.id, task.title, tomorrowStr),
      });
      cmds.push({
        id: `reschedule-week-${task.id}`,
        label: `reschedule-next-week: ${task.title}`,
        action: () => rescheduleTask(task.id, task.title, nextWeekStr),
      });
    }

    return cmds;
  }, [exec, onSwitchView, onCycleTheme, toggleRuntime, allPrograms, pendingProposals, allTasks, triggerProgram, toggleProgram, resolveProposal, toggleTaskDone, rescheduleTask]);

  const filteredCommands = useMemo(() => {
    if (mode !== "command") return [];
    if (!query) return commands;
    const q = query.toLowerCase();

    function fuzzyScore(text: string, pattern: string): number {
      let pi = 0;
      let score = 0;
      let consecutive = 0;
      for (let ti = 0; ti < text.length && pi < pattern.length; ti++) {
        if (text[ti] === pattern[pi]) {
          pi++;
          consecutive++;
          score += consecutive;
          if (ti === 0 || text[ti - 1] === "-" || text[ti - 1] === " " || text[ti - 1] === ":") score += 5;
        } else {
          consecutive = 0;
        }
      }
      return pi === pattern.length ? score : -1;
    }

    return commands
      .map(c => {
        const labelScore = fuzzyScore(c.label.toLowerCase(), q);
        const hintScore = (c.hint || "").toLowerCase().includes(q) ? 10 : -1;
        const best = Math.max(labelScore, hintScore);
        return { cmd: c, score: best };
      })
      .filter(x => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.cmd);
  }, [commands, query, mode]);

  const displayItems = mode === "command" ? filteredCommands :
    mode === "search" ? searchResults : [];

  useEffect(() => {
    setSelectedIdx(0);
  }, [query, mode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const maxIdx = mode === "command" ? filteredCommands.length - 1 :
      mode === "search" ? searchResults.length - 1 : 0;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (mode !== "command") { setMode("command"); setQuery(""); }
        else onClose();
        break;
      case "ArrowDown":
      case "Tab":
        if (!e.shiftKey) {
          e.preventDefault();
          setSelectedIdx(i => Math.min(i + 1, maxIdx));
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (mode === "command" && filteredCommands[selectedIdx]) {
          filteredCommands[selectedIdx].action();
        } else if (mode === "search" && searchResults[selectedIdx]) {
          const r = searchResults[selectedIdx];
          const viewMap: Record<string, string> = { task: "tree", program: "programs", skill: "tree", note: "tree", capture: "tree", result: "results", reader_page: "reader" };
          const targetView = viewMap[r.type] || "tree";
          onNavigate(targetView, r.id);
          onCommandExecuted(`Found: ${r.title}`);
          onClose();
        } else if (mode === "capture" && query.trim()) {
          smartCapture.mutate(query.trim());
          onCommandExecuted(`Captured: ${query.trim().slice(0, 30)}`);
          onClose();
        } else if (mode === "add-url" && query.trim()) {
          createReaderPage.mutate(query.trim());
          onCommandExecuted(`Saving: ${query.trim().slice(0, 30)}`);
          onClose();
        }
        break;
    }
  }, [mode, filteredCommands, searchResults, selectedIdx, query, onClose, onCommandExecuted, smartCapture, createReaderPage]);

  const modeLabel = mode === "command" ? "M-x" :
    mode === "search" ? "Search" :
    mode === "capture" ? "Capture (t task / note)" :
    "URL";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[20%]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="minibuffer"
    >
      <div className="w-full max-w-[380px] bg-background border border-border rounded shadow-lg font-mono text-xs">
        <div className="flex items-center border-b border-border px-2 py-1">
          <span className="text-muted-foreground mr-2 shrink-0">{modeLabel}:</span>
          <input
            ref={inputRef}
            data-testid="minibuffer-input"
            className="flex-1 bg-transparent outline-none text-primary"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={mode === "capture" ? "t buy milk tomorrow..." : mode === "add-url" ? "https://..." : "Type to filter..."}
          />
        </div>
        <div ref={listRef} className="max-h-64 overflow-y-auto">
          {mode === "command" && filteredCommands.map((cmd, idx) => (
            <div
              key={cmd.id}
              data-testid={`cmd-${cmd.id}`}
              className={`px-2 py-1 cursor-pointer flex justify-between items-center ${
                idx === selectedIdx ? "bg-primary/20 text-primary" : "text-foreground"
              }`}
              onClick={() => cmd.action()}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span>{cmd.label}</span>
              {cmd.hint && <span className="text-muted-foreground text-[10px]">{cmd.hint}</span>}
            </div>
          ))}
          {mode === "search" && searchResults.map((r, idx) => (
            <div
              key={`${r.type}-${r.id}`}
              className={`px-2 py-1 cursor-pointer flex items-center gap-1 ${
                idx === selectedIdx ? "bg-primary/20 text-primary" : "text-foreground"
              }`}
              onClick={() => {
                const viewMap: Record<string, string> = { task: "tree", program: "programs", skill: "tree", note: "tree", capture: "tree", result: "results", reader_page: "reader" };
                onNavigate(viewMap[r.type] || "tree", r.id);
                onCommandExecuted(`Found: ${r.title}`);
                onClose();
              }}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span className="text-muted-foreground w-10 shrink-0 text-[10px]">{r.type}</span>
              <span className="truncate">{r.title}</span>
            </div>
          ))}
          {mode === "search" && query && searchResults.length === 0 && (
            <div className="px-2 py-2 text-muted-foreground">No results for "{query}"</div>
          )}
          {mode === "capture" && query && (
            <div className="px-2 py-2 text-muted-foreground">
              Press Enter to capture. Prefix with "t " for a task.
            </div>
          )}
          {mode === "add-url" && query && (
            <div className="px-2 py-2 text-muted-foreground">
              Press Enter to save URL to Reader.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
