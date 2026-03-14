import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProgramSchema, insertSkillSchema, insertTaskSchema, insertNoteSchema, insertCaptureSchema, insertOpenclawProposalSchema, insertSiteProfileSchema, insertNavigationPathSchema } from "@shared/schema";
import { parseCaptureEntry, formatOrgEntry } from "./capture-parser";
import { detectContentType, fetchUrlMetadata } from "./content-detector";
import { seedDatabase } from "./seed-data";
import { getRuntimeState, toggleRuntime, manualTrigger } from "./agent-runtime";
import { getBridgeStatus, launchBrowser, closeBrowser, startLoginSession, getPageContent, openPage, getPageText } from "./browser-bridge";
import { openOutlook, openTeams, getOutlookEmails, readOutlookEmail, getTeamsChats, readTeamsChat } from "./app-adapters";
import { executeNavigationPath, bestEffortExtract, matchProfileToUrl, type UrlValidator } from "./universal-scraper";
import { subscribe, getEventHistory, type CockpitEvent } from "./event-bus";
import { createNavigationSession, updateNavigationState, getNavigationSession, getActiveSessions, closeNavigationSession, getNavigationHistory } from "./navigation-session";
import { getControlState, getControlMode, toggleControlMode, setControlMode, getActivityStream, getPendingTakeoverPoints, resolveTakeoverPoint, recordAction, checkPermission, createTakeoverPoint, enqueueCommand, dequeueCommand, completeCommand, drainQueue, getQueueDepth, setActionPermission, getActionPermissions, getPausedExecutions, removePausedExecution, clearPausedExecutions, onResume, type PausedExecution } from "./control-bus";
import { executeChain, executeChainRaw, getCommandHelp } from "./cli-engine";
import { insertRecipeSchema } from "@shared/schema";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  try {
    await seedDatabase();
  } catch (e) {
    console.error("[seed] Failed to seed database:", e);
  }

  app.get("/api/programs", async (_req, res) => {
    const progs = await storage.getPrograms();
    res.json(progs);
  });

  app.get("/api/programs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const prog = await storage.getProgram(id);
    if (!prog) return res.status(404).json({ message: "Program not found" });
    res.json(prog);
  });

  app.post("/api/programs", async (req, res) => {
    const parsed = insertProgramSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const prog = await storage.createProgram(parsed.data);
    res.status(201).json(prog);
  });

  app.patch("/api/programs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertProgramSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateProgram(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Program not found" });
    res.json(updated);
  });

  app.delete("/api/programs/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteProgram(id);
    res.status(204).send();
  });

  app.post("/api/programs/:id/toggle", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.toggleProgramEnabled(id);
    if (!updated) return res.status(404).json({ message: "Program not found" });
    res.json(updated);
  });

  app.post("/api/programs/:id/trigger", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const prog = await storage.getProgram(id);
    if (!prog) return res.status(404).json({ message: "Program not found" });
    try {
      const result = await manualTrigger(prog.name);
      res.json({ triggered: true, state: result });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/skills", async (_req, res) => {
    const allSkills = await storage.getSkills();
    res.json(allSkills);
  });

  app.get("/api/skills/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const skill = await storage.getSkill(id);
    if (!skill) return res.status(404).json({ message: "Skill not found" });
    res.json(skill);
  });

  app.post("/api/skills", async (req, res) => {
    const parsed = insertSkillSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const skill = await storage.createSkill(parsed.data);
    res.status(201).json(skill);
  });

  app.patch("/api/skills/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertSkillSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateSkill(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Skill not found" });
    res.json(updated);
  });

  app.delete("/api/skills/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteSkill(id);
    res.status(204).send();
  });

  app.get("/api/config", async (_req, res) => {
    const configs = await storage.getAgentConfigs();
    res.json(configs);
  });

  app.get("/api/config/:key", async (req, res) => {
    const config = await storage.getAgentConfig(req.params.key);
    if (!config) return res.status(404).json({ message: "Config not found" });
    res.json(config);
  });

  app.put("/api/config/:key", async (req, res) => {
    const { value, category } = req.body;
    if (typeof value !== "string") return res.status(400).json({ message: "value must be a string" });
    const config = await storage.setAgentConfig(req.params.key, value, category);
    res.json(config);
  });

  app.delete("/api/config/:key", async (req, res) => {
    await storage.deleteAgentConfig(req.params.key);
    res.status(204).send();
  });

  app.get("/api/tasks", async (req, res) => {
    const status = req.query.status as string | undefined;
    const allTasks = await storage.getTasks(status);
    res.json(allTasks);
  });

  app.get("/api/tasks/agenda", async (_req, res) => {
    const today = new Date().toISOString().split("T")[0];
    const [overdue, todayTasks, upcoming, latestResults] = await Promise.all([
      storage.getOverdueTasks(today),
      storage.getTasksByDate(today),
      storage.getUpcomingTasks(today),
      storage.getLatestResults(5),
    ]);

    res.json({
      overdue,
      today: todayTasks,
      upcoming,
      briefings: latestResults,
    });
  });

  app.get("/api/tasks/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const task = await storage.getTask(id);
    if (!task) return res.status(404).json({ message: "Task not found" });
    res.json(task);
  });

  app.post("/api/tasks", async (req, res) => {
    const parsed = insertTaskSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const task = await storage.createTask(parsed.data);
    res.status(201).json(task);
  });

  app.patch("/api/tasks/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertTaskSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateTask(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Task not found" });
    res.json(updated);
  });

  app.post("/api/tasks/:id/toggle", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const task = await storage.getTask(id);
    if (!task) return res.status(404).json({ message: "Task not found" });
    const newStatus = task.status === "TODO" ? "DONE" : "TODO";
    const updated = await storage.updateTask(id, { status: newStatus });
    res.json(updated);
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteTask(id);
    res.status(204).send();
  });

  app.get("/api/notes", async (_req, res) => {
    const allNotes = await storage.getNotes();
    res.json(allNotes);
  });

  app.get("/api/notes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const note = await storage.getNote(id);
    if (!note) return res.status(404).json({ message: "Note not found" });
    res.json(note);
  });

  app.post("/api/notes", async (req, res) => {
    const parsed = insertNoteSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const note = await storage.createNote(parsed.data);
    res.status(201).json(note);
  });

  app.patch("/api/notes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertNoteSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateNote(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Note not found" });
    res.json(updated);
  });

  app.delete("/api/notes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteNote(id);
    res.status(204).send();
  });

  app.get("/api/captures", async (req, res) => {
    const processed = req.query.processed === "true" ? true : req.query.processed === "false" ? false : undefined;
    const allCaptures = await storage.getCaptures(processed);
    res.json(allCaptures);
  });

  app.post("/api/captures", async (req, res) => {
    const parsed = insertCaptureSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const capture = await storage.createCapture(parsed.data);
    res.status(201).json(capture);
  });

  app.post("/api/captures/:id/process", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.markCaptureProcessed(id);
    res.json({ processed: true });
  });

  app.delete("/api/captures/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteCapture(id);
    res.status(204).send();
  });

  app.post("/api/captures/smart", async (req, res) => {
    const { content } = req.body;
    if (!content || typeof content !== "string") {
      return res.status(400).json({ message: "content required" });
    }

    const parsed = parseCaptureEntry(content);

    if (parsed.type === "task") {
      const task = await storage.createTask({
        title: parsed.title,
        status: "TODO",
        scheduledDate: parsed.scheduledDate || null,
        deadlineDate: parsed.deadlineDate || null,
        tags: parsed.tags,
        body: "",
      });
      return res.status(201).json({ type: "task", item: task, parsed });
    } else {
      const note = await storage.createNote({
        title: parsed.title,
        body: "",
        tags: [],
      });
      return res.status(201).json({ type: "note", item: note, parsed });
    }
  });

  app.post("/api/captures/enrich", async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ message: "content required" });
    const detection = detectContentType(content);
    let metadata = null;
    if (detection.url) {
      metadata = await fetchUrlMetadata(detection.url);
    }
    res.json({ detection, metadata });
  });

  app.get("/api/results", async (req, res) => {
    const programName = req.query.program as string | undefined;
    const limit = parseInt(req.query.limit as string || "50", 10);
    const results = await storage.getAgentResults(programName, limit);
    res.json(results);
  });

  app.get("/api/results/latest", async (req, res) => {
    const limit = parseInt(req.query.limit as string || "10", 10);
    const results = await storage.getLatestResults(limit);
    res.json(results);
  });

  app.get("/api/results/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await storage.getAgentResult(id);
    if (!result) return res.status(404).json({ message: "Result not found" });
    res.json(result);
  });

  app.get("/api/reader", async (_req, res) => {
    const pages = await storage.getReaderPages();
    res.json(pages);
  });

  app.get("/api/reader/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const page = await storage.getReaderPage(id);
    if (!page) return res.status(404).json({ message: "Page not found" });
    res.json(page);
  });

  app.post("/api/reader", async (req, res) => {
    const { url } = req.body;
    if (!url || typeof url !== "string") return res.status(400).json({ message: "url required" });

    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ message: "Only http/https URLs allowed" });
      }
      const blockedPatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|\[::1\]|metadata\.google|169\.254\.169\.254)/i;
      if (blockedPatterns.test(parsed.hostname)) {
        return res.status(400).json({ message: "Internal/private URLs are not allowed" });
      }

      const dnsModule = await import("dns");
      const { promisify } = await import("util");
      const resolve4 = promisify(dnsModule.resolve4);
      try {
        const addresses = await resolve4(parsed.hostname);
        for (const addr of addresses) {
          if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/.test(addr)) {
            return res.status(400).json({ message: "URL resolves to private network" });
          }
        }
      } catch {}

      const bridgeStatus = getBridgeStatus();
      let html = "";
      let title = "";
      let text = "";

      if (bridgeStatus.running) {
        const pageId = `reader-${Date.now()}`;
        await openPage(pageId, url);
        const content = await getPageContent(pageId);
        if (content) {
          title = content.title || url;
          text = content.text || "";
        }
      }

      if (!text && !html) {
        const response = await fetch(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
          redirect: "follow",
          signal: AbortSignal.timeout(15000),
        });
        html = await response.text();
      }

      if (!title) {
        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        title = titleMatch ? titleMatch[1].trim() : url;
      }

      if (!text) {
        text = html
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
          .replace(/<[^>]+>/g, "\n")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&#\d+;/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
      }

      const domain = parsed.hostname;

      const page = await storage.createReaderPage({
        url,
        title,
        extractedText: text.slice(0, 50000),
        domain,
      });
      res.status(201).json(page);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ message: "Failed to fetch URL: " + msg });
    }
  });

  app.delete("/api/reader/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteReaderPage(id);
    res.status(204).send();
  });

  app.get("/api/proposals", async (req, res) => {
    const status = req.query.status as string | undefined;
    const proposals = await storage.getProposals(status);
    res.json(proposals);
  });

  app.post("/api/proposals", async (req, res) => {
    const parsed = insertOpenclawProposalSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const proposal = await storage.createProposal(parsed.data);
    res.status(201).json(proposal);
  });

  app.post("/api/proposals/:id/accept", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.updateProposalStatus(id, "accepted", new Date());
    if (!updated) return res.status(404).json({ message: "Proposal not found" });
    res.json(updated);
  });

  app.post("/api/proposals/:id/reject", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.updateProposalStatus(id, "rejected", new Date());
    if (!updated) return res.status(404).json({ message: "Proposal not found" });
    res.json(updated);
  });

  app.get("/api/search", async (req, res) => {
    const q = req.query.q as string;
    if (!q || q.length < 1) return res.json([]);
    const results = await storage.searchAll(q);
    res.json(results);
  });

  app.get("/api/runtime", async (_req, res) => {
    const state = getRuntimeState();
    res.json(state);
  });

  app.post("/api/runtime/toggle", async (_req, res) => {
    const active = toggleRuntime();
    res.json({ active });
  });

  app.get("/api/tree", async (_req, res) => {
    const [allTasks, allPrograms, allSkills, allNotes, allCaptures, allPages] = await Promise.all([
      storage.getTasks(),
      storage.getPrograms(),
      storage.getSkills(),
      storage.getNotes(),
      storage.getCaptures(false),
      storage.getReaderPages(),
    ]);

    res.json({
      tasks: allTasks,
      programs: allPrograms,
      skills: allSkills,
      notes: allNotes,
      captures: allCaptures,
      reader: allPages,
    });
  });

  app.get("/api/bridge/status", async (_req, res) => {
    const status = getBridgeStatus();
    res.json(status);
  });

  app.post("/api/bridge/launch", async (_req, res) => {
    try {
      const ok = await launchBrowser(true);
      res.json({ success: ok });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ success: false, error: msg });
    }
  });

  app.post("/api/bridge/close", async (_req, res) => {
    await closeBrowser();
    res.json({ success: true });
  });

  app.post("/api/bridge/login", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: "url required" });
    try {
      const result = await startLoginSession(url);
      res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ success: false, error: msg });
    }
  });

  app.get("/api/mail/inbox", async (_req, res) => {
    try {
      const emails = await getOutlookEmails();
      res.json(emails);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/mail/:index", async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    try {
      const email = await readOutlookEmail(idx);
      if (!email) return res.status(404).json({ message: "Email not found" });
      res.json(email);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/chat/list", async (_req, res) => {
    try {
      const chats = await getTeamsChats();
      res.json(chats);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/chat/:index", async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    try {
      const messages = await readTeamsChat(idx);
      res.json(messages);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/site-profiles", async (_req, res) => {
    const profiles = await storage.getSiteProfiles();
    res.json(profiles);
  });

  app.get("/api/site-profiles/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const profile = await storage.getSiteProfile(id);
    if (!profile) return res.status(404).json({ message: "Site profile not found" });
    res.json(profile);
  });

  app.post("/api/site-profiles", async (req, res) => {
    const parsed = insertSiteProfileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const profile = await storage.createSiteProfile(parsed.data);
    res.status(201).json(profile);
  });

  app.patch("/api/site-profiles/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertSiteProfileSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateSiteProfile(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Site profile not found" });
    res.json(updated);
  });

  app.delete("/api/site-profiles/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteSiteProfile(id);
    res.status(204).send();
  });

  app.get("/api/navigation-paths", async (req, res) => {
    const siteProfileId = req.query.siteProfileId ? parseInt(req.query.siteProfileId as string, 10) : undefined;
    const paths = await storage.getNavigationPaths(siteProfileId);
    res.json(paths);
  });

  app.get("/api/navigation-paths/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const path = await storage.getNavigationPath(id);
    if (!path) return res.status(404).json({ message: "Navigation path not found" });
    res.json(path);
  });

  app.post("/api/navigation-paths", async (req, res) => {
    const parsed = insertNavigationPathSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const profile = await storage.getSiteProfile(parsed.data.siteProfileId);
    if (!profile) return res.status(400).json({ message: "Site profile not found" });
    const path = await storage.createNavigationPath(parsed.data);
    res.status(201).json(path);
  });

  app.patch("/api/navigation-paths/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertNavigationPathSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateNavigationPath(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Navigation path not found" });
    res.json(updated);
  });

  app.delete("/api/navigation-paths/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteNavigationPath(id);
    res.status(204).send();
  });

  async function validateUrlSafety(url: string): Promise<{ safe: boolean; error?: string }> {
    try {
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return { safe: false, error: "Only http/https URLs allowed" };
      }
      const blockedPatterns = /^(localhost|127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.|::1|\[::1\]|metadata\.google|169\.254\.169\.254)/i;
      if (blockedPatterns.test(parsed.hostname)) {
        return { safe: false, error: "Internal/private URLs are not allowed" };
      }

      const dnsModule = await import("dns");
      const { promisify } = await import("util");
      const resolve4 = promisify(dnsModule.resolve4);
      try {
        const addresses = await resolve4(parsed.hostname);
        for (const addr of addresses) {
          if (/^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.|169\.254\.)/.test(addr)) {
            return { safe: false, error: "URL resolves to private network" };
          }
        }
      } catch {}

      return { safe: true };
    } catch {
      return { safe: false, error: "Invalid URL" };
    }
  }

  app.post("/api/scraper/execute", async (req, res) => {
    const { navigationPathId, url } = req.body;

    try {
      if (url && !navigationPathId) {
        const check = await validateUrlSafety(url);
        if (!check.safe) return res.status(400).json({ message: check.error });

        recordAction("human", "best-effort-scrape", url, "autonomous", "success");
        const result = await bestEffortExtract(url);
        return res.json(result);
      }

      if (!navigationPathId) {
        return res.status(400).json({ message: "navigationPathId or url required" });
      }

      const navPath = await storage.getNavigationPath(navigationPathId);
      if (!navPath) return res.status(404).json({ message: "Navigation path not found" });

      const profile = await storage.getSiteProfile(navPath.siteProfileId);
      if (!profile) return res.status(404).json({ message: "Site profile not found" });

      const permCheck = await checkPermission(profile.id, navPath.id, `execute: ${profile.name}/${navPath.name}`);
      if (!permCheck.allowed && !permCheck.needsApproval) {
        return res.status(403).json({ message: `Action blocked by permission rules (level: ${permCheck.level})` });
      }

      if (permCheck.needsApproval) {
        const decision = await Promise.race([
          createTakeoverPoint(`execute: ${profile.name}/${navPath.name}`, url || profile.baseUrl, "approval"),
          new Promise<"reject">((resolve) => setTimeout(() => resolve("reject"), 300000)),
        ]);
        if (decision === "reject") {
          return res.status(403).json({ message: "Action rejected at takeover point" });
        }
        if (decision === "takeover") {
          return res.json({ success: false, message: "Human took over control", takenOver: true });
        }
      }

      const steps = (navPath.steps as Array<{ action: string; target?: string; value?: string; waitMs?: number; description?: string }>) || [];
      for (const step of steps) {
        if (step.action === "navigate" && step.target) {
          const check = await validateUrlSafety(step.target);
          if (!check.safe) {
            return res.status(400).json({ message: `Navigation step URL blocked: ${check.error}` });
          }
        }
      }

      if (url) {
        const urlCheck = await validateUrlSafety(url);
        if (!urlCheck.safe) {
          return res.status(400).json({ message: `Runtime URL blocked: ${urlCheck.error}` });
        }
      }

      recordAction(getControlMode(), `execute: ${profile.name}/${navPath.name}`, url || profile.baseUrl, permCheck.level, "started");
      const result = await executeNavigationPath(profile, navPath, validateUrlSafety, url || undefined);
      recordAction(getControlMode(), `completed: ${profile.name}/${navPath.name}`, url || profile.baseUrl, permCheck.level, result.success ? "success" : "error");
      return res.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ message: "Scraper execution failed: " + msg });
    }
  });

  app.post("/api/scraper/match", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ message: "url required" });

    const profiles = await storage.getSiteProfiles();
    const match = matchProfileToUrl(profiles, url);
    if (!match) return res.json({ matched: false, profile: null, paths: [] });

    const paths = await storage.getNavigationPaths(match.id);
    res.json({ matched: true, profile: match, paths });
  });

  app.get("/api/cockpit/events", (req, res) => {
    const token = req.query.token as string | undefined;
    const API_KEY = process.env.OPENCLAW_API_KEY;
    if (API_KEY) {
      const authHeader = req.headers.authorization;
      const headerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
      if (headerKey !== API_KEY && token !== API_KEY) {
        return res.status(401).json({ message: "Unauthorized" });
      }
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const history = getEventHistory(50);
    for (const event of history) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    const unsubscribe = subscribe((event: CockpitEvent) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {}
    });

    const keepAlive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 30000);

    req.on("close", () => {
      unsubscribe();
      clearInterval(keepAlive);
    });
  });

  app.get("/api/cockpit/history", (_req, res) => {
    const limit = parseInt((_req.query.limit as string) || "100", 10);
    res.json(getEventHistory(limit));
  });

  app.get("/api/cockpit/nav/sessions", (_req, res) => {
    res.json(getActiveSessions());
  });

  app.post("/api/cockpit/nav/sessions", (req, res) => {
    const { sessionId, profileName, url } = req.body;
    if (!sessionId || !profileName || !url) {
      return res.status(400).json({ message: "sessionId, profileName, and url are required" });
    }
    const session = createNavigationSession(sessionId, profileName, url);
    res.status(201).json(session);
  });

  app.get("/api/cockpit/nav/sessions/:id", (req, res) => {
    const session = getNavigationSession(req.params.id);
    if (!session) return res.status(404).json({ message: "Session not found" });
    res.json(session);
  });

  app.patch("/api/cockpit/nav/sessions/:id", (req, res) => {
    const updated = updateNavigationState(req.params.id, req.body);
    if (!updated) return res.status(404).json({ message: "Session not found" });
    res.json(updated);
  });

  app.delete("/api/cockpit/nav/sessions/:id", (req, res) => {
    closeNavigationSession(req.params.id);
    res.status(204).send();
  });

  app.get("/api/cockpit/nav/sessions/:id/history", (req, res) => {
    const history = getNavigationHistory(req.params.id);
    res.json(history);
  });

  app.get("/api/control", async (_req, res) => {
    const state = getControlState();
    res.json({
      mode: state.mode,
      agentPaused: state.agentPaused,
      pendingTakeoverPoints: getPendingTakeoverPoints(),
      activityStream: getActivityStream(50),
      pausedExecutions: state.pausedExecutions,
    });
  });

  app.get("/api/control/mode", async (_req, res) => {
    res.json({ mode: getControlMode() });
  });

  app.post("/api/control/toggle", async (_req, res) => {
    const mode = toggleControlMode();
    res.json({ mode });
  });

  app.post("/api/control/set-mode", async (req, res) => {
    const { mode } = req.body;
    if (mode !== "human" && mode !== "agent") {
      return res.status(400).json({ message: "mode must be 'human' or 'agent'" });
    }
    const result = setControlMode(mode);
    res.json({ mode: result });
  });

  app.get("/api/control/activity", async (req, res) => {
    const limit = parseInt(req.query.limit as string || "50", 10);
    const stream = getActivityStream(limit);
    res.json(stream);
  });

  app.get("/api/control/takeover-points", async (_req, res) => {
    const points = getPendingTakeoverPoints();
    res.json(points);
  });

  app.post("/api/control/takeover-points/:id/resolve", async (req, res) => {
    const { id } = req.params;
    const { decision } = req.body;
    if (!["confirm", "reject", "takeover"].includes(decision)) {
      return res.status(400).json({ message: "decision must be 'confirm', 'reject', or 'takeover'" });
    }
    const ok = resolveTakeoverPoint(id, decision);
    if (!ok) return res.status(404).json({ message: "Takeover point not found or already resolved" });
    res.json({ resolved: true });
  });

  app.post("/api/control/record-action", async (req, res) => {
    const { actor, action, target, permissionLevel, result, details } = req.body;
    if (!actor || !action) return res.status(400).json({ message: "actor and action required" });
    recordAction(actor, action, target, permissionLevel, result || "success", details);
    res.json({ recorded: true });
  });

  app.get("/api/audit-log", async (req, res) => {
    const limit = parseInt(req.query.limit as string || "100", 10);
    const actor = req.query.actor as string | undefined;
    if (actor) {
      const logs = await storage.getAuditLogsByActor(actor, limit);
      return res.json(logs);
    }
    const logs = await storage.getAuditLogs(limit);
    res.json(logs);
  });

  app.post("/api/control/check-permission", async (req, res) => {
    const { profileId, navPathId, action, actionName } = req.body;
    if (!action) return res.status(400).json({ message: "action required" });
    const result = await checkPermission(profileId || null, navPathId || null, action, actionName);
    res.json(result);
  });

  app.get("/api/control/action-permissions", async (_req, res) => {
    res.json(await getActionPermissions());
  });

  app.post("/api/control/action-permissions", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== process.env.OPENCLAW_API_KEY) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { navPathId, actionName, level } = req.body;
    if (!navPathId || !actionName || !level) {
      return res.status(400).json({ message: "navPathId, actionName, and level required" });
    }
    if (!["autonomous", "approval", "blocked"].includes(level)) {
      return res.status(400).json({ message: "level must be autonomous, approval, or blocked" });
    }
    await setActionPermission(navPathId, actionName, level);
    res.json({ ok: true });
  });

  app.post("/api/control/enqueue", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== process.env.OPENCLAW_API_KEY) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { source, action, target } = req.body;
    if (!source || !action) return res.status(400).json({ message: "source and action required" });
    const cmd = enqueueCommand(source, action, target);
    if (!cmd) return res.status(409).json({ message: "Command rejected: agent is paused or human has control" });
    res.json(cmd);
  });

  app.post("/api/control/dequeue", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== process.env.OPENCLAW_API_KEY) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { source } = req.body;
    if (!source) return res.status(400).json({ message: "source required" });
    const cmd = dequeueCommand(source);
    if (!cmd) return res.status(204).end();
    res.json(cmd);
  });

  app.post("/api/control/complete-command/:id", async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ") || authHeader.slice(7) !== process.env.OPENCLAW_API_KEY) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    const { result } = req.body;
    completeCommand(req.params.id, result || "success");
    res.json({ ok: true });
  });

  app.get("/api/control/queue-depth", async (req, res) => {
    const source = req.query.source as string | undefined;
    res.json({ depth: getQueueDepth(source === "agent" || source === "human" ? source : undefined) });
  });

  app.get("/api/control/paused-executions", async (_req, res) => {
    res.json(getPausedExecutions());
  });

  app.delete("/api/control/paused-executions/:id", async (req, res) => {
    const removed = removePausedExecution(req.params.id);
    if (!removed) return res.status(404).json({ message: "Not found" });
    res.json(removed);
  });

  app.delete("/api/control/paused-executions", async (_req, res) => {
    clearPausedExecutions();
    res.json({ ok: true });
  });

  app.post("/api/cli/run", async (req, res) => {
    const { command } = req.body;
    if (!command || typeof command !== "string") {
      return res.status(400).json({ message: "command string required" });
    }
    try {
      const result = await executeChain(command);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  app.get("/api/cli/commands", async (_req, res) => {
    res.json({ commands: getCommandHelp() });
  });

  app.get("/api/cli/help", async (_req, res) => {
    res.json({ help: getCommandHelp() });
  });

  app.get("/api/recipes", async (_req, res) => {
    const all = await storage.getRecipes();
    res.json(all);
  });

  app.get("/api/recipes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await storage.getRecipe(id);
    if (!r) return res.status(404).json({ message: "Recipe not found" });
    res.json(r);
  });

  app.post("/api/recipes", async (req, res) => {
    const parsed = insertRecipeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const r = await storage.createRecipe(parsed.data);
    res.status(201).json(r);
  });

  app.patch("/api/recipes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertRecipeSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateRecipe(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Recipe not found" });
    res.json(updated);
  });

  app.delete("/api/recipes/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteRecipe(id);
    res.status(204).send();
  });

  app.post("/api/recipes/:id/toggle", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.toggleRecipeEnabled(id);
    if (!updated) return res.status(404).json({ message: "Recipe not found" });
    res.json(updated);
  });

  app.post("/api/recipes/:id/trigger", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const r = await storage.getRecipe(id);
    if (!r) return res.status(404).json({ message: "Recipe not found" });
    try {
      const raw = await executeChainRaw(r.command);
      const now = new Date();
      await storage.updateRecipeLastRun(r.id, now, null, raw.stdout.slice(0, 10000));
      res.json({ triggered: true, output: raw.stdout, exitCode: raw.exitCode, durationMs: raw.durationMs });
    } catch (e: any) {
      res.status(500).json({ message: e.message });
    }
  });

  onResume(async (paused: PausedExecution) => {
    if (paused.type === "navigation" && paused.profileId && paused.navPathId) {
      try {
        const profile = await storage.getSiteProfile(paused.profileId);
        const navPath = await storage.getNavigationPath(paused.navPathId);
        if (!profile || !navPath) {
          console.warn(`[control-bus] Cannot resume navigation: profile or path not found`);
          return;
        }
        removePausedExecution(paused.id);
        recordAction(getControlMode(), `nav-resuming: ${navPath.name} from step ${paused.stepIndex}`, profile.name, undefined, "resumed");
        const runtimeUrl = paused.context?.runtimeUrl as string | undefined;
        const savedPageId = paused.context?.pageId as string | undefined;
        executeNavigationPath(profile, navPath, undefined, runtimeUrl, paused.stepIndex, savedPageId).catch(err => {
          console.error(`[control-bus] Resume navigation failed:`, err);
        });
      } catch (err) {
        console.error(`[control-bus] Error resuming navigation:`, err);
      }
    }
  });

  return httpServer;
}
