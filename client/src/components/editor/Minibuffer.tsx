import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useSearch, useSmartCapture, useToggleRuntime, useCreateReaderPage, usePrograms, useProposals, useTasks, useSiteProfiles, useNavigationPaths } from "@/hooks/use-org-data";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { ViewMode } from "@/components/layout/Sidebar";
import { useTvMode } from "@/hooks/use-tv-mode";

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
  initialMode?: "command" | "search" | "capture" | "add-url" | "shell";
  initialShellCmd?: string | null;
  onClose: () => void;
  onSwitchView: (view: ViewMode) => void;
  onNavigate: (view: string, id?: number) => void;
  onCycleTheme: () => void;
  onCommandExecuted: (label: string) => void;
}

export default function Minibuffer({
  initialMode = "command",
  initialShellCmd = null,
  onClose,
  onSwitchView,
  onNavigate,
  onCycleTheme,
  onCommandExecuted,
}: MinibufferProps) {
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<"command" | "search" | "capture" | "add-url" | "scrape-url" | "scraper-result" | "shell">(initialMode);
  const [scraperResult, setScraperResult] = useState<ScraperResultData | null>(null);
  const [pendingNavPathId, setPendingNavPathId] = useState<number | null>(null);
  const [pendingNavPathLabel, setPendingNavPathLabel] = useState("");
  const [shellOutput, setShellOutput] = useState<string>("");
  const [shellRunning, setShellRunning] = useState(false);
  const [shellHistory, setShellHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const { isTvMode, setTvMode } = useTvMode();

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

  useEffect(() => {
    if (initialShellCmd && initialMode === "shell") {
      setQuery(initialShellCmd);
      setShellOutput("");
      executeShellCommand(initialShellCmd);
    }
  }, [initialShellCmd, initialMode]);

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

  const executeShellCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim()) return;
    setShellRunning(true);
    setShellOutput("");
    setShellHistory(prev => {
      const next = prev.filter(h => h !== cmd);
      next.unshift(cmd);
      return next.slice(0, 50);
    });
    setHistoryIdx(-1);
    try {
      const res = await apiRequest("POST", "/api/cli/run", { command: cmd });
      const data: { output: string; exitCode: number; durationMs: number } = await res.json();
      setShellOutput(data.output);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Command failed";
      setShellOutput(`[error] ${msg}`);
    } finally {
      setShellRunning(false);
      setQuery("");
    }
  }, []);

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
      { id: "switch-transcripts", label: "switch-to-transcripts", hint: "6", action: () => exec("Transcripts", () => onSwitchView("transcripts")) },
      { id: "switch-cockpit", label: "switch-to-cockpit", hint: "7", action: () => exec("Cockpit", () => onSwitchView("cockpit")) },
      { id: "toggle-control", label: "toggle-control-mode", hint: "Tab", action: () => exec("Control toggled", async () => { await apiRequest("POST", "/api/control/toggle"); queryClient.invalidateQueries({ queryKey: ["/api/control"] }); }) },
      { id: "view-permissions", label: "edit-permissions", action: () => { onNavigate("cockpit"); window.dispatchEvent(new CustomEvent("cockpit-tab", { detail: "permissions" })); onCommandExecuted("Permissions"); onClose(); } },
      { id: "view-audit-log", label: "view-audit-log", action: () => { onNavigate("cockpit"); window.dispatchEvent(new CustomEvent("cockpit-tab", { detail: "audit" })); onCommandExecuted("Audit Log"); onClose(); } },
      { id: "capture", label: "capture", hint: "c", action: () => { setMode("capture"); setQuery(""); setSelectedIdx(0); } },
      { id: "quick-capture", label: "quick-capture", hint: "q", action: () => { setMode("capture"); setQuery(""); setSelectedIdx(0); } },
      { id: "search", label: "search-all", hint: "/", action: () => { setMode("search"); setQuery(""); setSelectedIdx(0); } },
      { id: "add-url", label: "read-url", hint: "u", action: () => { setMode("add-url"); setQuery(""); setSelectedIdx(0); } },
      { id: "scrape-url", label: "scrape-url", hint: "Scrape any URL", action: () => { setMode("scrape-url"); setQuery(""); setSelectedIdx(0); } },
      { id: "cycle-theme", label: "cycle-theme", hint: "#", action: () => exec("Theme cycled", () => onCycleTheme()) },
      { id: "toggle-runtime", label: "toggle-runtime", hint: "R", action: () => exec("Runtime toggled", () => toggleRuntime.mutate()) },
      { id: "toggle-tv-mode", label: "toggle-tv-mode", hint: "TV", action: () => {
        setTvMode(!isTvMode);
        onCommandExecuted("TV mode toggled");
        onClose();
      } },
      { id: "refresh", label: "refresh-all", hint: "r", action: () => exec("Refreshed", () => queryClient.invalidateQueries()) },
      { id: "bridge-status", label: "bridge-status", hint: "Check extension", action: () => { setMode("shell"); setQuery("bridge-status"); setShellOutput(""); executeShellCommand("bridge-status"); } },
      { id: "fetch-mail", label: "fetch-outlook-inbox", hint: "Via bridge", action: () => { setMode("shell"); setQuery("outlook"); setShellOutput(""); executeShellCommand("outlook"); } },
      { id: "fetch-chats", label: "fetch-teams-chats", hint: "Via bridge", action: () => { setMode("shell"); setQuery("teams"); setShellOutput(""); executeShellCommand("teams"); } },
      { id: "fetch-calendar", label: "fetch-outlook-calendar", hint: "Via bridge", action: () => { setMode("shell"); setQuery("outlook calendar"); setShellOutput(""); executeShellCommand("outlook calendar"); } },
      { id: "citrix-workspace", label: "citrix-workspace", hint: "Launch all Citrix apps", action: () => { setMode("shell"); setQuery("citrix workspace"); setShellOutput(""); executeShellCommand("citrix workspace"); } },
      { id: "citrix-launch", label: "citrix-launch", hint: "Launch single Citrix app", action: () => { setMode("shell"); setQuery("citrix launch "); setShellOutput(""); } },
      { id: "citrix-workspace-list", label: "citrix-workspace-list", hint: "Show configured apps", action: () => { setMode("shell"); setQuery("citrix workspace list"); setShellOutput(""); executeShellCommand("citrix workspace list"); } },
      { id: "citrix-keepalive", label: "citrix-keepalive-status", hint: "Check keepalive", action: () => { setMode("shell"); setQuery("citrix keepalive"); setShellOutput(""); executeShellCommand("citrix keepalive"); } },
      { id: "epic-status", label: "epic-status", hint: "Desktop agent status", action: () => { setMode("shell"); setQuery("epic status"); setShellOutput(""); executeShellCommand("epic status"); } },
      { id: "epic-screenshot", label: "epic-screenshot", hint: "Capture Hyperspace screen", action: () => { setMode("shell"); setQuery("epic screenshot "); setShellOutput(""); } },
      { id: "epic-navigate", label: "epic-navigate", hint: "Navigate Hyperspace to activity", action: () => { setMode("shell"); setQuery("epic navigate "); setShellOutput(""); } },
      { id: "epic-click", label: "epic-click", hint: "Click element in Hyperspace", action: () => { setMode("shell"); setQuery("epic click "); setShellOutput(""); } },
      { id: "epic-activities", label: "epic-activities", hint: "Show cataloged activities", action: () => { setMode("shell"); setQuery("epic activities "); setShellOutput(""); } },
      { id: "epic-setup", label: "epic-setup", hint: "Desktop agent setup guide", action: () => { setMode("shell"); setQuery("epic setup"); setShellOutput(""); executeShellCommand("epic setup"); } },
      { id: "pulse-scan", label: "pulse-scan", hint: "Scrape Pulse intranet links", action: () => { setMode("shell"); setQuery("pulse scan"); setShellOutput(""); executeShellCommand("pulse scan"); } },
      { id: "pulse-search", label: "pulse-search", hint: "Search intranet links", action: () => { setMode("shell"); setQuery("pulse search "); setShellOutput(""); } },
      { id: "pulse-list", label: "pulse-list", hint: "List intranet links", action: () => { setMode("shell"); setQuery("pulse list"); setShellOutput(""); executeShellCommand("pulse list"); } },
      { id: "pulse-categories", label: "pulse-categories", hint: "Show link categories", action: () => { setMode("shell"); setQuery("pulse categories"); setShellOutput(""); executeShellCommand("pulse categories"); } },
      { id: "pulse-open", label: "pulse-open", hint: "Open intranet link", action: () => { setMode("shell"); setQuery("pulse open "); setShellOutput(""); } },
      { id: "pulse-clear", label: "pulse-clear", hint: "Clear stored links", action: () => { setMode("shell"); setQuery("pulse clear"); setShellOutput(""); executeShellCommand("pulse clear"); } },
      { id: "transcripts", label: "transcripts", hint: "View transcripts", action: () => exec("Transcripts", () => onSwitchView("transcripts")) },
      { id: "meetings", label: "meetings", hint: "View meeting transcripts", action: () => exec("Transcripts", () => onSwitchView("transcripts")) },
      { id: "record-start", label: "record-start", hint: "Start mic recording", action: () => {
        onSwitchView("transcripts");
        setTimeout(() => window.dispatchEvent(new CustomEvent("transcripts:record", { detail: "start" })), 100);
        onCommandExecuted("Recording started");
        onClose();
      }},
      { id: "record-stop", label: "record-stop", hint: "Stop mic recording", action: () => {
        onSwitchView("transcripts");
        setTimeout(() => window.dispatchEvent(new CustomEvent("transcripts:record", { detail: "stop" })), 100);
        onCommandExecuted("Recording stopped");
        onClose();
      }},
      { id: "cockpit-focus", label: "cockpit-focus-program", action: () => exec("Cockpit", () => onSwitchView("cockpit")) },
      { id: "cockpit-history", label: "cockpit-view-history", action: () => exec("Cockpit History", () => onSwitchView("cockpit")) },
      { id: "shell", label: "shell", hint: ":", action: () => { setMode("shell"); setQuery(""); setSelectedIdx(0); setShellOutput(""); } },
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
  }, [exec, onSwitchView, onCycleTheme, toggleRuntime, allPrograms, pendingProposals, allTasks, allSiteProfiles, allNavPaths, scraperResult, triggerProgram, toggleProgram, resolveProposal, toggleTaskDone, rescheduleTask, executeNavPath, executeScraperUrl, executeShellCommand, pendingNavPathId, isTvMode, setTvMode]);

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

  const doSubmit = useCallback(() => {
    if (mode === "shell" && query.trim() && !shellRunning) {
      executeShellCommand(query.trim());
      return;
    }
    if (mode === "command" && filteredCommands[selectedIdx]) {
      filteredCommands[selectedIdx].action();
    } else if (mode === "search" && searchResults[selectedIdx]) {
      const r = searchResults[selectedIdx];
      const viewMap: Record<string, string> = { task: "tree", program: "programs", skill: "tree", note: "tree", capture: "tree", result: "results", reader_page: "reader", transcript: "transcripts" };
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
  }, [mode, filteredCommands, searchResults, selectedIdx, query, onClose, onCommandExecuted, smartCapture, createReaderPage, executeScraperUrl, executeShellCommand, shellRunning, executeNavPath, pendingNavPathId, pendingNavPathLabel]);

  const handleFormSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    doSubmit();
  }, [doSubmit]);

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
        e.preventDefault();
        if (mode === "shell" && e.key === "ArrowDown") {
          if (historyIdx > 0) {
            const nextIdx = historyIdx - 1;
            setHistoryIdx(nextIdx);
            setQuery(shellHistory[nextIdx]);
          } else if (historyIdx === 0) {
            setHistoryIdx(-1);
            setQuery("");
          }
        } else if (!e.shiftKey) {
          setSelectedIdx(i => Math.min(i + 1, maxIdx));
        }
        break;
      case "ArrowUp":
        e.preventDefault();
        if (mode === "shell") {
          if (shellHistory.length > 0) {
            const nextIdx = Math.min(historyIdx + 1, shellHistory.length - 1);
            setHistoryIdx(nextIdx);
            setQuery(shellHistory[nextIdx]);
          }
        } else {
          setSelectedIdx(i => Math.max(i - 1, 0));
        }
        break;
      case "Enter":
        e.preventDefault();
        doSubmit();
        break;
    }
  }, [mode, filteredCommands, searchResults, selectedIdx, onClose, shellHistory, historyIdx, doSubmit]);

  const modeLabel = mode === "command" ? "M-x" :
    mode === "search" ? "Search" :
    mode === "capture" ? "Capture (t task / note)" :
    mode === "scraper-result" ? "Scraper Result" :
    mode === "shell" ? ":" :
    mode === "scrape-url" ? (pendingNavPathId ? `URL for ${pendingNavPathLabel}` : "Scrape URL") :
    "URL";

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center ${isTvMode ? "pt-[10%]" : "pt-[20%]"}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="minibuffer"
    >
      <div className={`w-full bg-background border border-border rounded shadow-lg font-mono ${
        isTvMode ? "max-w-[800px] text-[22px]" : "max-w-[380px] text-xs"
      }`}>
        <form onSubmit={handleFormSubmit} className={`flex items-center border-b border-border ${
          isTvMode ? "px-4 py-3" : "px-2 py-1"
        }`}>
          <span className={`text-muted-foreground shrink-0 ${isTvMode ? "mr-3" : "mr-2"}`}>{modeLabel}:</span>
          <input
            ref={inputRef}
            data-testid="minibuffer-input"
            className={`flex-1 bg-transparent outline-none text-primary ${isTvMode ? "text-[22px]" : ""}`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            placeholder={mode === "shell" ? "Type command (help for list)..." : mode === "capture" ? "t buy milk tomorrow..." : mode === "add-url" || mode === "scrape-url" ? "https://..." : "Type to filter..."}
          />
        </form>
        <div ref={listRef} className={`overflow-y-auto ${isTvMode ? "max-h-[500px]" : "max-h-64"}`}>
          {mode === "command" && filteredCommands.map((cmd, idx) => (
            <div
              key={cmd.id}
              data-testid={`cmd-${cmd.id}`}
              className={`cursor-pointer flex justify-between items-center tv-item-highlight ${
                isTvMode ? "px-4 py-3" : "px-2 py-1"
              } ${
                idx === selectedIdx ? "bg-primary/20 text-primary" : "text-foreground"
              }`}
              data-selected={idx === selectedIdx}
              onClick={() => cmd.action()}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span>{cmd.label}</span>
              {cmd.hint && <span className={`text-muted-foreground ${isTvMode ? "text-[18px]" : "text-[10px]"}`}>{cmd.hint}</span>}
            </div>
          ))}
          {mode === "search" && searchResults.map((r, idx) => (
            <div
              key={`${r.type}-${r.id}`}
              className={`cursor-pointer flex items-center tv-item-highlight ${
                isTvMode ? "px-4 py-3 gap-3" : "px-2 py-1 gap-1"
              } ${
                idx === selectedIdx ? "bg-primary/20 text-primary" : "text-foreground"
              }`}
              data-selected={idx === selectedIdx}
              onClick={() => {
                const viewMap: Record<string, string> = { task: "tree", program: "programs", skill: "tree", note: "tree", capture: "tree", result: "results", reader_page: "reader", transcript: "transcripts" };
                onNavigate(viewMap[r.type] || "tree", r.id);
                onCommandExecuted(`Found: ${r.title}`);
                onClose();
              }}
              onMouseEnter={() => setSelectedIdx(idx)}
            >
              <span className={`text-muted-foreground shrink-0 ${isTvMode ? "w-24 text-[18px]" : "w-10 text-[10px]"}`}>{r.type}</span>
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
          {mode === "shell" && (
            <div className="px-2 py-1 text-foreground" data-testid="shell-output">
              {shellRunning && (
                <div className="py-1 text-muted-foreground animate-pulse">Running...</div>
              )}
              {shellOutput && (
                <div className="max-h-48 overflow-y-auto whitespace-pre-wrap text-[10px] leading-relaxed">{shellOutput}</div>
              )}
              {!shellRunning && !shellOutput && (
                <div className="py-1 text-muted-foreground">
                  Type a CLI command and press Enter. Try: help, bridge-status, outlook, teams
                </div>
              )}
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
