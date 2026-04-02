import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { useSearch, useSmartCapture, useToggleRuntime, useCreateReaderPage, usePrograms, useProposals, useTasks, useSiteProfiles, useNavigationPaths } from "@/hooks/use-org-data";
import { queryClient, apiRequest, apiUrl, getApiBase, setApiBase } from "@/lib/queryClient";
import type { ViewMode } from "@/components/layout/Sidebar";
import { useTvMode } from "@/hooks/use-tv-mode";
import { CAPTURE_TEMPLATES, type CaptureTemplate } from "@shared/capture-templates";

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
  initialTemplate?: string;
  initialCaptureContext?: { url: string; title: string; selection: string } | null;
  onClose: () => void;
  onSwitchView: (view: ViewMode) => void;
  onNavigate: (view: string, id?: number) => void;
  onCycleTheme: () => void;
  onCommandExecuted: (label: string) => void;
}

function getInitialCaptureState(initialMode: string, initialTemplate?: string): { mode: "command" | "search" | "capture" | "capture-template" | "add-url" | "scrape-url" | "scraper-result" | "shell"; query: string; template: CaptureTemplate | null } {
  if (initialMode !== "capture") return { mode: initialMode as "command" | "search" | "add-url" | "shell", query: "", template: null };
  if (initialTemplate) {
    const tmpl = CAPTURE_TEMPLATES.find(t => t.key === initialTemplate);
    if (tmpl) {
      const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      let prefix = tmpl.prefix;
      if (tmpl.key === "j") prefix = `[${today}] `;
      if (tmpl.key === "m") prefix = `[${today}] Meeting: `;
      return { mode: "capture", query: prefix, template: tmpl };
    }
  }
  return { mode: "capture-template", query: "", template: null };
}

export default function Minibuffer({
  initialMode = "command",
  initialShellCmd = null,
  initialTemplate,
  initialCaptureContext = null,
  onClose,
  onSwitchView,
  onNavigate,
  onCycleTheme,
  onCommandExecuted,
}: MinibufferProps) {
  const captureInit = getInitialCaptureState(initialMode, initialTemplate);
  const formatContext = (ctx: { url: string; title: string; selection: string } | null, templateKey?: string): string => {
    if (!ctx) return "";
    const parts: string[] = [];
    if (templateKey === "b") {
      if (ctx.url) parts.push(ctx.url);
      if (ctx.title) parts.push(ctx.title);
      return parts.join(" ");
    }
    if (ctx.selection) parts.push(ctx.selection);
    if (ctx.title && ctx.title !== ctx.selection) parts.push(ctx.title);
    if (ctx.url) parts.push(ctx.url);
    return parts.join("\n");
  };
  const contextSuffix = (initialMode === "capture" && initialCaptureContext) ? formatContext(initialCaptureContext, captureInit.template?.key) : "";
  const [query, setQuery] = useState(captureInit.query + contextSuffix);
  const captureContextRef = useRef(initialCaptureContext);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState(captureInit.mode);
  const [scraperResult, setScraperResult] = useState<ScraperResultData | null>(null);
  const [pendingNavPathId, setPendingNavPathId] = useState<number | null>(null);
  const [pendingNavPathLabel, setPendingNavPathLabel] = useState("");
  const [shellOutput, setShellOutput] = useState<string>("");
  const [shellRunning, setShellRunning] = useState(false);
  const [shellHistory, setShellHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selectedTemplate, setSelectedTemplate] = useState<CaptureTemplate | null>(captureInit.template);
  const [captureImageUrl, setCaptureImageUrl] = useState<string | null>(null);
  const [captureImageUploading, setCaptureImageUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
    if (mode === "capture") {
      textareaRef.current?.focus();
    } else {
      inputRef.current?.focus();
    }
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
    const trimmed = cmd.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      setApiBase(trimmed);
      setShellOutput("API base set to: " + trimmed + "\nReload the page to connect.");
      setQuery("");
      return;
    }
    if (trimmed === "reset-api-base" || trimmed === "clear-api-base") {
      setApiBase("");
      setShellOutput("API base cleared (using local server).\nReload the page to reconnect.");
      setQuery("");
      return;
    }
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
      const openMatch = data.output.match(/__OPEN_URL:(.+?)__/);
      if (openMatch) {
        window.open(openMatch[1], "_blank");
        setShellOutput(data.output.replace(/__OPEN_URL:.+?__/, "[Opened in browser]"));
      } else {
        setShellOutput(data.output);
      }
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
      { id: "capture", label: "capture", hint: "c", action: () => { setMode("capture-template"); setQuery(""); setSelectedIdx(0); setSelectedTemplate(null); setCaptureImageUrl(null); } },
      { id: "quick-capture", label: "quick-capture", hint: "q", action: () => { setMode("capture-template"); setQuery(""); setSelectedIdx(0); setSelectedTemplate(null); setCaptureImageUrl(null); } },
      { id: "search", label: "search-all", hint: "/", action: () => { setMode("search"); setQuery(""); setSelectedIdx(0); } },
      { id: "add-url", label: "read-url", hint: "u", action: () => { setMode("add-url"); setQuery(""); setSelectedIdx(0); } },
      { id: "scrape-url", label: "scrape-url", hint: "Scrape any URL", action: () => { setMode("scrape-url"); setQuery(""); setSelectedIdx(0); } },
      { id: "cycle-theme", label: "cycle-theme", hint: "#", action: () => exec("Theme cycled", () => onCycleTheme()) },
      { id: "set-api-base", label: "set-api-base", hint: "Set backend URL", action: () => { setMode("shell"); setQuery(""); setShellOutput("Current: " + (getApiBase() || "(local)")); } },
      { id: "toggle-runtime", label: "toggle-runtime", hint: "R", action: () => exec("Runtime toggled", () => toggleRuntime.mutate()) },
      { id: "budget-status", label: "budget-status", hint: "$", action: () => { setMode("shell"); setQuery("budget"); setShellOutput(""); executeShellCommand("budget"); } },
      { id: "budget-models", label: "budget-models", hint: "Model roster", action: () => { setMode("shell"); setQuery("budget models"); setShellOutput(""); executeShellCommand("budget models"); } },
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
      { id: "citrix-portal-list", label: "citrix-portal-list", hint: "List Citrix portals", action: () => { setMode("shell"); setQuery("citrix portal list"); setShellOutput(""); executeShellCommand("citrix portal list"); } },
      { id: "citrix-portal-add", label: "citrix-portal-add", hint: "Add Citrix portal", action: () => { setMode("shell"); setQuery("citrix portal add "); setShellOutput(""); } },
      { id: "citrix-portal-scan", label: "citrix-portal-scan", hint: "Scan portal for apps", action: () => { setMode("shell"); setQuery("citrix portal scan "); setShellOutput(""); } },
      { id: "citrix-portal-remove", label: "citrix-portal-remove", hint: "Remove portal", action: () => { setMode("shell"); setQuery("citrix portal remove "); setShellOutput(""); } },
      { id: "epic-view", label: "epic-view", hint: "Live accessibility tree view (Vimium)", action: () => { setMode("shell"); setQuery("epic view SUP"); setShellOutput(""); executeShellCommand("epic view SUP"); } },
      { id: "epic-do", label: "epic-do", hint: "Interact by hint key (Vimium)", action: () => { setMode("shell"); setQuery("epic do SUP "); setShellOutput(""); } },
      { id: "epic-menu", label: "epic-menu", hint: "Browse stored navigation tree", action: () => { setMode("shell"); setQuery("epic menu SUP"); setShellOutput(""); executeShellCommand("epic menu SUP"); } },
      { id: "epic-screen", label: "epic-screen", hint: "Navigate + live field view + cache", action: () => { setMode("shell"); setQuery("epic screen "); setShellOutput(""); } },
      { id: "epic-fields", label: "epic-fields", hint: "Show cached field layouts", action: () => { setMode("shell"); setQuery("epic fields"); setShellOutput(""); executeShellCommand("epic fields"); } },
      { id: "epic-search", label: "epic-search", hint: "Search Epic activities", action: () => { setMode("shell"); setQuery("epic search SUP "); setShellOutput(""); } },
      { id: "epic-status", label: "epic-status", hint: "Desktop agent status", action: () => { setMode("shell"); setQuery("epic status"); setShellOutput(""); executeShellCommand("epic status"); } },
      { id: "epic-screenshot", label: "epic-screenshot", hint: "Capture Hyperspace screen", action: () => { setMode("shell"); setQuery("epic screenshot "); setShellOutput(""); } },
      { id: "epic-navigate", label: "epic-navigate", hint: "Navigate Hyperspace to activity", action: () => { setMode("shell"); setQuery("epic navigate "); setShellOutput(""); } },
      { id: "epic-click", label: "epic-click", hint: "Click element in Hyperspace", action: () => { setMode("shell"); setQuery("epic click "); setShellOutput(""); } },
      { id: "epic-activities", label: "epic-activities", hint: "Show cataloged activities", action: () => { setMode("shell"); setQuery("epic activities "); setShellOutput(""); } },
      { id: "epic-tree", label: "epic-tree", hint: "Show full navigation tree", action: () => { setMode("shell"); setQuery("epic tree "); setShellOutput(""); } },
      { id: "epic-tree-refresh", label: "epic-tree-refresh", hint: "Re-scan tree via desktop agent", action: () => { setMode("shell"); setQuery("epic tree --refresh "); setShellOutput(""); } },
      { id: "epic-go", label: "epic-go", hint: "Navigate using stored path", action: () => { setMode("shell"); setQuery("epic go "); setShellOutput(""); } },
      { id: "epic-mf", label: "epic-masterfile", hint: "Text masterfile lookup", action: () => { setMode("shell"); setQuery("epic mf "); setShellOutput(""); } },
      { id: "epic-setup", label: "epic-setup", hint: "Desktop agent setup guide", action: () => { setMode("shell"); setQuery("epic setup"); setShellOutput(""); executeShellCommand("epic setup"); } },
      { id: "epic-record-start", label: "epic-record-start", hint: "Start recording workflow", action: () => { setMode("shell"); setQuery("epic record start "); setShellOutput(""); } },
      { id: "epic-record-stop", label: "epic-record-stop", hint: "Stop recording workflow", action: () => { setMode("shell"); setQuery("epic record stop"); setShellOutput(""); executeShellCommand("epic record stop"); } },
      { id: "epic-record-save", label: "epic-record-save", hint: "Save recorded workflow", action: () => { setMode("shell"); setQuery("epic record save "); setShellOutput(""); } },
      { id: "epic-workflows", label: "epic-workflows", hint: "List saved workflows", action: () => { setMode("shell"); setQuery("epic workflows"); setShellOutput(""); executeShellCommand("epic workflows"); } },
      { id: "epic-replay", label: "epic-replay", hint: "Replay a saved workflow", action: () => { setMode("shell"); setQuery("epic replay "); setShellOutput(""); } },
      { id: "epic-menu-crawl", label: "epic-menu-crawl", hint: "Auto-crawl Hyperspace menus (vision)", action: () => { setMode("shell"); setQuery("epic menu-crawl "); setShellOutput(""); } },
      { id: "epic-menu-crawl-text", label: "epic-menu-crawl-text", hint: "Auto-crawl Text menus (keystroke)", action: () => { setMode("shell"); setQuery("epic menu-crawl text "); setShellOutput(""); } },
      { id: "epic-search-crawl", label: "epic-search-crawl", hint: "Discover activities via A-Z search autocomplete", action: () => { setMode("shell"); setQuery("epic search-crawl "); setShellOutput(""); } },
      { id: "epic-workflow-delete", label: "epic-workflow-delete", hint: "Delete a saved workflow", action: () => { setMode("shell"); setQuery("epic workflow delete "); setShellOutput(""); } },
      { id: "pulse-scan", label: "pulse-scan", hint: "Scrape Pulse intranet links", action: () => { setMode("shell"); setQuery("pulse scan"); setShellOutput(""); executeShellCommand("pulse scan"); } },
      { id: "pulse-search", label: "pulse-search", hint: "Search intranet links", action: () => { setMode("shell"); setQuery("pulse search "); setShellOutput(""); } },
      { id: "pulse-list", label: "pulse-list", hint: "List intranet links", action: () => { setMode("shell"); setQuery("pulse list"); setShellOutput(""); executeShellCommand("pulse list"); } },
      { id: "pulse-categories", label: "pulse-categories", hint: "Show link categories", action: () => { setMode("shell"); setQuery("pulse categories"); setShellOutput(""); executeShellCommand("pulse categories"); } },
      { id: "pulse-open", label: "pulse-open", hint: "Open intranet link", action: () => { setMode("shell"); setQuery("pulse open "); setShellOutput(""); } },
      { id: "pulse-clear", label: "pulse-clear", hint: "Clear stored links", action: () => { setMode("shell"); setQuery("pulse clear"); setShellOutput(""); executeShellCommand("pulse clear"); } },
      { id: "galaxy-search", label: "galaxy-search", hint: "Search Galaxy knowledge base", action: () => { setMode("shell"); setQuery("galaxy search "); setShellOutput(""); } },
      { id: "galaxy-read", label: "galaxy-read", hint: "Fetch & save Galaxy guide", action: () => { setMode("shell"); setQuery("galaxy read "); setShellOutput(""); } },
      { id: "galaxy-recent", label: "galaxy-recent", hint: "Show saved Galaxy guides", action: () => { setMode("shell"); setQuery("galaxy recent"); setShellOutput(""); executeShellCommand("galaxy recent"); } },
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
      if (selectedTemplate?.key === "s" && !captureImageUrl) {
        return;
      }
      const captureData: Record<string, string> = { content: query.trim() };
      if (captureImageUrl) captureData.imageUrl = captureImageUrl;
      if (selectedTemplate) captureData.template = selectedTemplate.key;
      apiRequest("POST", "/api/captures/smart", captureData).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
      });
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

  const handleClipboardPaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (mode !== "capture") return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        setCaptureImageUploading(true);
        const formData = new FormData();
        formData.append("image", file);
        try {
          const headers: Record<string, string> = {};
          const storedKey = localStorage.getItem("orgcloud_api_key");
          if (storedKey) headers["Authorization"] = `Bearer ${storedKey}`;
          const res = await fetch(apiUrl("/api/uploads/image"), { method: "POST", body: formData, headers, credentials: "include" });
          const data = await res.json();
          setCaptureImageUrl(data.url);
        } catch (err) {
          console.error("Image upload failed:", err);
        } finally {
          setCaptureImageUploading(false);
        }
        return;
      }
    }
  }, [mode]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (mode === "capture-template") {
      const key = e.key.toLowerCase();
      const tmpl = CAPTURE_TEMPLATES.find(t => t.key === key);
      if (tmpl) {
        e.preventDefault();
        setSelectedTemplate(tmpl);
        setMode("capture");
        const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
        let prefix = tmpl.prefix;
        if (tmpl.key === "j") prefix = `[${today}] `;
        if (tmpl.key === "m") prefix = `[${today}] Meeting: `;
        setQuery(prefix + formatContext(captureContextRef.current, tmpl.key));
        setCaptureImageUrl(null);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      return;
    }

    const maxIdx = mode === "command" ? filteredCommands.length - 1 :
      mode === "search" ? searchResults.length - 1 : 0;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        onClose();
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
        if (mode === "capture" && !e.shiftKey) {
          e.preventDefault();
          doSubmit();
          return;
        }
        if (mode === "capture" && e.shiftKey) {
          return;
        }
        e.preventDefault();
        doSubmit();
        break;
    }
  }, [mode, filteredCommands, searchResults, selectedIdx, onClose, shellHistory, historyIdx, doSubmit]);

  const modeLabel = mode === "command" ? "M-x" :
    mode === "search" ? "Search" :
    mode === "capture-template" ? "Capture — pick template" :
    mode === "capture" ? `Capture [${selectedTemplate?.label || "note"}]` :
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
          {mode === "capture" ? (
            <textarea
              ref={textareaRef}
              data-testid="minibuffer-input"
              className={`flex-1 bg-transparent outline-none text-primary resize-none ${isTvMode ? "text-[22px]" : ""}`}
              rows={3}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handleClipboardPaste}
              autoComplete="off"
              placeholder="t buy milk tomorrow... #tag !A (Shift+Enter for newline)"
            />
          ) : (
            <input
              ref={inputRef}
              data-testid="minibuffer-input"
              className={`flex-1 bg-transparent outline-none text-primary ${isTvMode ? "text-[22px]" : ""} ${mode === "capture-template" ? "hidden" : ""}`}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              placeholder={mode === "shell" ? "Type command (help for list)..." : mode === "capture-template" ? "Press a key to select template..." : mode === "add-url" || mode === "scrape-url" ? "https://..." : "Type to filter..."}
            />
          )}
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
          {mode === "capture-template" && (
            <div className="px-1 py-1" tabIndex={0} ref={(el) => el?.focus()} onKeyDown={handleKeyDown}>
              {CAPTURE_TEMPLATES.map(tmpl => (
                <div
                  key={tmpl.key}
                  data-testid={`template-${tmpl.key}`}
                  className="px-2 py-1 cursor-pointer flex justify-between items-center hover:bg-primary/20"
                  onClick={() => {
                    setSelectedTemplate(tmpl);
                    setMode("capture");
                    const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                    let prefix = tmpl.prefix;
                    if (tmpl.key === "j") prefix = `[${today}] `;
                    if (tmpl.key === "m") prefix = `[${today}] Meeting: `;
                    setQuery(prefix + formatContext(captureContextRef.current, tmpl.key));
                    setCaptureImageUrl(null);
                  }}
                >
                  <span><span className="text-primary font-bold">[{tmpl.key}]</span> {tmpl.label}</span>
                  <span className="text-muted-foreground text-[10px]">{tmpl.description}</span>
                </div>
              ))}
            </div>
          )}
          {mode === "capture" && (
            <div className="px-2 py-1 text-muted-foreground space-y-1">
              {captureImageUploading && <div className="text-primary animate-pulse">[uploading image...]</div>}
              {captureImageUrl && <div className="text-primary">[image attached] <img src={captureImageUrl} alt="preview" className="inline-block max-h-8 rounded" /></div>}
              {selectedTemplate?.key === "s" && !captureImageUrl && !captureImageUploading && (
                <div className="text-yellow-500">Paste an image (Ctrl+V) to attach a screenshot. Required before capture.</div>
              )}
              {selectedTemplate?.key === "b" && (
                <div>Enter URL to bookmark (e.g. https://example.com). Tags auto-applied: #bookmark</div>
              )}
              {selectedTemplate?.key !== "s" && selectedTemplate?.key !== "b" && (
                <div>Enter to capture. Shift+Enter for multiline. Ctrl+V to paste image. #tag !A/!B/!C for priority.</div>
              )}
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
