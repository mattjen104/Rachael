import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useSearch, useSmartCapture, useToggleRuntime, useCreateReaderPage, usePrograms, useProposals, useTasks, useSiteProfiles, useNavigationPaths } from "@/hooks/use-org-data";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { ViewMode } from "@/components/layout/Sidebar";

interface ScraperResultData {
  success: boolean;
  profileName: string;
  pathName: string;
  content: { title?: string; url?: string; text?: string; elements?: unknown[] } | null;
  extractedData: Record<string, string>;
  stepResults: Array<{ step: number; action: string; description?: string; success: boolean; error?: string }>;
  error?: string;
  durationMs: number;
}

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
  const [mode, setMode] = useState<"command" | "search" | "capture" | "add-url" | "scrape-url" | "scraper-result">(initialMode);
  const [scraperResult, setScraperResult] = useState<ScraperResultData | null>(null);
  const [pendingNavPathId, setPendingNavPathId] = useState<number | null>(null);
  const [pendingNavPathLabel, setPendingNavPathLabel] = useState("");
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
  const { data: allSiteProfiles = [] } = useSiteProfiles();
  const { data: allNavPaths = [] } = useNavigationPaths();

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

  const executeNavPath = useCallback(async (pathId: number, pathName: string, runtimeUrl?: string) => {
    onCommandExecuted(`Running: ${pathName}...`);
    try {
      const body: Record<string, unknown> = { navigationPathId: pathId };
      if (runtimeUrl) body.url = runtimeUrl;
      const res = await apiRequest("POST", "/api/scraper/execute", body);
      const data: ScraperResultData = await res.json();
      setScraperResult(data);
      setMode("scraper-result");
      setQuery("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Execution failed";
      setScraperResult({ success: false, profileName: "", pathName: pathName, content: null, extractedData: {}, stepResults: [], error: msg, durationMs: 0 });
      setMode("scraper-result");
      setQuery("");
    }
  }, [onCommandExecuted]);

  const executeScraperUrl = useCallback(async (url: string) => {
    onCommandExecuted(`Scraping: ${url.slice(0, 40)}...`);
    try {
      const res = await apiRequest("POST", "/api/scraper/execute", { url });
      const data: ScraperResultData = await res.json();
      setScraperResult(data);
      setMode("scraper-result");
      setQuery("");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Execution failed";
      setScraperResult({ success: false, profileName: "any-website", pathName: "best-effort", content: null, extractedData: {}, stepResults: [], error: msg, durationMs: 0 });
      setMode("scraper-result");
      setQuery("");
    }
  }, [onCommandExecuted]);

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
      { id: "scrape-url", label: "scrape-url", hint: "Scrape any URL", action: () => { setMode("scrape-url"); setQuery(""); setSelectedIdx(0); } },
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

    cmds.push({
      id: "list-profiles",
      label: "list-site-profiles",
      action: () => exec(`${allSiteProfiles.length} site profiles`, () => {}),
    });

    if (scraperResult) {
      cmds.push({
        id: "view-scraper-results",
        label: "view-scraper-results",
        action: () => { setMode("scraper-result"); setQuery(""); setSelectedIdx(0); },
      });
    }

    for (const profile of allSiteProfiles) {
      const profilePaths = allNavPaths.filter(p => p.siteProfileId === profile.id);
      cmds.push({
        id: `view-profile-${profile.id}`,
        label: `view-profile: ${profile.name}`,
        action: () => exec(`Profile: ${profile.name}`, () => {}),
      });
      for (const navPath of profilePaths) {
        const requiresUrl = profile.name === "any-website" || (!profile.baseUrl && !(navPath.steps as Array<{ action: string }>)?.some(s => s.action === "navigate"));
        const pathLabel = `${profile.name}/${navPath.name}`;
        const pathId = navPath.id;
        cmds.push({
          id: `run-path-${pathId}`,
          label: `run-scraper: ${pathLabel}`,
          action: requiresUrl
            ? () => { setPendingNavPathId(pathId); setPendingNavPathLabel(pathLabel); setMode("scrape-url"); setQuery(""); setSelectedIdx(0); }
            : () => executeNavPath(pathId, pathLabel),
        });
      }
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
  }, [exec, onSwitchView, onCycleTheme, toggleRuntime, allPrograms, pendingProposals, allTasks, allSiteProfiles, allNavPaths, scraperResult, triggerProgram, toggleProgram, resolveProposal, toggleTaskDone, rescheduleTask, executeNavPath, executeScraperUrl, pendingNavPathId]);

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
        } else if (mode === "scrape-url" && query.trim()) {
          if (pendingNavPathId) {
            executeNavPath(pendingNavPathId, pendingNavPathLabel, query.trim());
            setPendingNavPathId(null);
            setPendingNavPathLabel("");
          } else {
            executeScraperUrl(query.trim());
          }
        }
        break;
    }
  }, [mode, filteredCommands, searchResults, selectedIdx, query, onClose, onCommandExecuted, smartCapture, createReaderPage, executeScraperUrl, executeNavPath, pendingNavPathId, pendingNavPathLabel]);

  const modeLabel = mode === "command" ? "M-x" :
    mode === "search" ? "Search" :
    mode === "capture" ? "Capture (t task / note)" :
    mode === "scraper-result" ? "Scraper Result" :
    mode === "scrape-url" ? (pendingNavPathId ? `URL for ${pendingNavPathLabel}` : "Scrape URL") :
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
            placeholder={mode === "capture" ? "t buy milk tomorrow..." : mode === "add-url" || mode === "scrape-url" ? "https://..." : "Type to filter..."}
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
          {mode === "scrape-url" && query && (
            <div className="px-2 py-2 text-muted-foreground">
              Press Enter to scrape this URL.
            </div>
          )}
          {mode === "scraper-result" && scraperResult && (
            <div className="px-2 py-1 text-foreground" data-testid="scraper-result-view">
              <div className="flex items-center gap-2 py-1 border-b border-border">
                <span className={scraperResult.success ? "text-green-400" : "text-red-400"}>
                  {scraperResult.success ? "[OK]" : "[FAIL]"}
                </span>
                <span className="truncate">{scraperResult.profileName}/{scraperResult.pathName}</span>
                <span className="text-muted-foreground text-[10px] ml-auto">{scraperResult.durationMs}ms</span>
              </div>
              {scraperResult.error && (
                <div className="py-1 text-red-400 text-[10px]">{scraperResult.error}</div>
              )}
              {scraperResult.content?.title && (
                <div className="py-1"><span className="text-muted-foreground">title:</span> {scraperResult.content.title}</div>
              )}
              {scraperResult.content?.url && (
                <div className="py-1 truncate"><span className="text-muted-foreground">url:</span> {scraperResult.content.url}</div>
              )}
              {Object.keys(scraperResult.extractedData || {}).length > 0 && (
                <div className="py-1 border-t border-border mt-1">
                  <span className="text-muted-foreground">Extracted:</span>
                  {Object.entries(scraperResult.extractedData).map(([key, val]) => (
                    <div key={key} className="pl-2 truncate">
                      <span className="text-muted-foreground">{key}:</span> {String(val).slice(0, 100)}
                    </div>
                  ))}
                </div>
              )}
              {scraperResult.stepResults?.length > 0 && (
                <div className="py-1 border-t border-border mt-1">
                  <span className="text-muted-foreground">Steps:</span>
                  {scraperResult.stepResults.map((s) => (
                    <div key={s.step} className="pl-2">
                      <span className={s.success ? "text-green-400" : "text-red-400"}>
                        {s.success ? "✓" : "✗"}
                      </span>{" "}
                      {s.action}{s.description ? ` — ${s.description}` : ""}
                    </div>
                  ))}
                </div>
              )}
              {scraperResult.content?.text && (
                <div className="py-1 border-t border-border mt-1 max-h-32 overflow-y-auto">
                  <span className="text-muted-foreground">Content preview:</span>
                  <div className="text-[10px] whitespace-pre-wrap">{scraperResult.content.text.slice(0, 500)}</div>
                </div>
              )}
              <div className="py-1 text-muted-foreground text-[10px]">Press Escape to go back</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
