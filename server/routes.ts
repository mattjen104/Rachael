import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProgramSchema, insertSkillSchema, insertTaskSchema, insertNoteSchema, insertCaptureSchema, insertOpenclawProposalSchema, insertSiteProfileSchema, insertNavigationPathSchema, insertRadarEngagementSchema, insertMealPlanSchema, insertShoppingListSchema, insertPantryItemSchema, insertKiddoFoodLogSchema, insertNightlyRecommendationSchema } from "@shared/schema";
import { parseCaptureEntry, formatOrgEntry } from "./capture-parser";
import { detectContentType, fetchUrlMetadata } from "./content-detector";
import { seedDatabase } from "./seed-data";
import { getRuntimeState, toggleRuntime, manualTrigger, getRuntimeBudgetStatus } from "./agent-runtime";
import { getModelRoster, getModelQuality, loadRosterFromConfig } from "./model-router";
import { getBridgeStatus, launchBrowser, closeBrowser, startLoginSession, getPageContent, openPage, getPageText } from "./browser-bridge";
import { openOutlook, openTeams, getOutlookEmails, readOutlookEmail, getTeamsChats, readTeamsChat } from "./app-adapters";
import { executeNavigationPath, bestEffortExtract, matchProfileToUrl, type UrlValidator } from "./universal-scraper";
import { subscribe, getEventHistory, type CockpitEvent } from "./event-bus";
import { createNavigationSession, updateNavigationState, getNavigationSession, getActiveSessions, closeNavigationSession, getNavigationHistory } from "./navigation-session";
import { getControlState, getControlMode, toggleControlMode, setControlMode, getActivityStream, getPendingTakeoverPoints, resolveTakeoverPoint, recordAction, checkPermission, createTakeoverPoint, enqueueCommand, dequeueCommand, completeCommand, drainQueue, getQueueDepth, setActionPermission, getActionPermissions, getPausedExecutions, removePausedExecution, clearPausedExecutions, onResume, type PausedExecution } from "./control-bus";
import { executeChain, executeChainRaw, getCommandHelp } from "./cli-engine";
import { insertRecipeSchema } from "@shared/schema";
import { claimJobsTracked, resolveResult, getQueueStatus, submitJob, waitForResult, validateBridgeToken, getBridgeToken, recordHeartbeat, isExtensionConnected, smartFetch } from "./bridge-queue";
import { startRecordingSession, addAudioChunk, stopRecordingSession, getActiveRecordingSessions, transcribeUploadedAudio } from "./transcription-service";
import multer from "multer";

interface AppNotification {
  id: string;
  timestamp: number;
  label: string;
  output: string;
  source: string;
  command: string;
  read: boolean;
}

const notifications: AppNotification[] = [];
const MAX_NOTIFICATIONS = 100;
let notifCounter = 0;

function addNotification(label: string, output: string, source: string, command: string): AppNotification {
  const n: AppNotification = {
    id: `notif-${Date.now()}-${++notifCounter}`,
    timestamp: Date.now(),
    label,
    output,
    source,
    command,
    read: false,
  };
  notifications.push(n);
  if (notifications.length > MAX_NOTIFICATIONS) {
    notifications.splice(0, notifications.length - MAX_NOTIFICATIONS);
  }
  return n;
}

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
    if (req.params.key === "model_roster_overrides") {
      loadRosterFromConfig(storage).catch(() => {});
    }
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
    const proposal = await storage.getProposal(id);
    if (!proposal) return res.status(404).json({ message: "Proposal not found" });
    const updated = await storage.updateProposalStatus(id, "accepted", new Date());
    if (!updated) return res.status(404).json({ message: "Proposal not found" });

    if (proposal.targetName === "research-radar" && proposal.proposalType === "change") {
      try {
        const parsed = JSON.parse(proposal.proposedContent);
        if (parsed && parsed.radarConfigAction) {
          const prog = await storage.getProgramByName("research-radar");
          if (prog) {
            const config = { ...(prog.config || {}) };
            const action = parsed.radarConfigAction;
            if (action === "add-source" && parsed.sub) {
              const subs = JSON.parse(config.NICHE_SUBS || "[]");
              if (!subs.includes(parsed.sub)) subs.push(parsed.sub);
              config.NICHE_SUBS = JSON.stringify(subs);
            } else if (action === "drop-source" && parsed.sub) {
              const subs = JSON.parse(config.NICHE_SUBS || "[]");
              config.NICHE_SUBS = JSON.stringify(subs.filter((s: string) => s !== parsed.sub));
            } else if (action === "add-interest" && parsed.interest) {
              const interests = JSON.parse(config.INTEREST_AREAS || "[]");
              if (!interests.includes(parsed.interest)) interests.push(parsed.interest);
              config.INTEREST_AREAS = JSON.stringify(interests);
            } else if (action === "adjust-threshold" && parsed.threshold) {
              config.SCORE_THRESHOLD = String(parsed.threshold);
            }
            const changes = JSON.parse(config.CONFIG_CHANGES || "[]");
            changes.push({ action: action, detail: parsed, appliedAt: new Date().toISOString(), proposalId: id });
            config.CONFIG_CHANGES = JSON.stringify(changes.slice(-20));
            await storage.updateProgramConfig(prog.id, config);
          }
        }
      } catch {}
    }

    res.json(updated);
  });

  app.post("/api/proposals/:id/reject", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.updateProposalStatus(id, "rejected", new Date());
    if (!updated) return res.status(404).json({ message: "Proposal not found" });
    res.json(updated);
  });

  app.get("/api/radar/seen", async (req, res) => {
    const days = parseInt(req.query.days as string, 10) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const hashes = await storage.getRadarSeenHashes(since);
    res.json({ hashes });
  });

  app.post("/api/radar/seen", async (req, res) => {
    const items = req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ message: "items must be an array" });
    const toInsert = items.map((i: any) => ({
      contentHash: String(i.contentHash || ""),
      source: String(i.source || "unknown"),
      url: i.url || null,
      title: i.title || null,
    })).filter((i: any) => i.contentHash);
    await storage.createRadarSeenItems(toInsert);
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await storage.cleanOldRadarSeenItems(cutoff);
    res.json({ stored: toInsert.length });
  });

  app.get("/api/radar/engagement", async (req, res) => {
    const days = parseInt(req.query.days as string, 10) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const entries = await storage.getRadarEngagement(since);
    res.json(entries);
  });

  app.post("/api/radar/engagement", async (req, res) => {
    const parsed = insertRadarEngagementSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const entry = await storage.createRadarEngagement(parsed.data);
    res.status(201).json(entry);
  });

  app.patch("/api/programs/:id/config", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const config = req.body.config;
    if (!config || typeof config !== "object") return res.status(400).json({ message: "config must be an object" });
    const updated = await storage.updateProgramConfig(id, config);
    if (!updated) return res.status(404).json({ message: "Program not found" });
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
    const budgetStatus = await getRuntimeBudgetStatus();
    res.json({ ...state, budget: budgetStatus });
  });

  app.post("/api/runtime/toggle", async (_req, res) => {
    const active = toggleRuntime();
    res.json({ active });
  });

  app.get("/api/budget", async (_req, res) => {
    const status = await getRuntimeBudgetStatus();
    res.json(status);
  });

  app.get("/api/models", async (_req, res) => {
    const roster = getModelRoster();
    const quality = getModelQuality();
    const models = roster.map(m => ({
      ...m,
      quality: quality.get(m.id) || { successes: 0, failures: 0, score: 100 },
    }));
    res.json(models);
  });

  const epicCommandQueue: any[] = [];
  const epicResults = new Map<string, any>();
  let epicAgentStatus: any = { connected: false, lastSeen: 0, windows: [] };

  let epicRecordingState: {
    active: boolean;
    draining: boolean;
    startedAt: number | null;
    env: string;
    steps: Array<{ step: number; description: string; screen: string; timeDelta: number }>;
  } = { active: false, draining: false, startedAt: null, env: "SUP", steps: [] };

  app.get("/api/epic/agent/commands", (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const commands = epicCommandQueue.splice(0);
    res.json({ commands });
  });

  app.post("/api/epic/agent/heartbeat", (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    epicAgentStatus = {
      connected: true,
      lastSeen: Date.now(),
      windows: req.body.windows || [],
    };
    res.json({ ok: true });
  });

  app.post("/api/epic/agent/results", (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { commandId, status, screenshot, data, error } = req.body;
    epicResults.set(commandId, {
      commandId,
      status,
      screenshot: screenshot || null,
      data: data || null,
      error: error || null,
      receivedAt: Date.now(),
    });
    if (epicResults.size > 50) {
      const oldest = Array.from(epicResults.keys()).slice(0, epicResults.size - 50);
      for (const k of oldest) epicResults.delete(k);
    }
    res.json({ ok: true });
  });

  app.post("/api/epic/agent/send", (req, res) => {
    const isLocal = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      const auth = req.headers.authorization;
      if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    const { type, env, target, path, client, masterfile, item, steps, depth } = req.body;
    if (!type) return res.status(400).json({ error: "Missing type" });
    const id = `epic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const cmd: Record<string, any> = { id, type, env: env || "SUP" };
    if (target) cmd.target = target;
    if (path) cmd.path = path;
    if (client) cmd.client = client;
    if (masterfile) cmd.masterfile = masterfile;
    if (item) cmd.item = item;
    if (steps) cmd.steps = steps;
    if (depth !== undefined) cmd.depth = depth;
    epicCommandQueue.push(cmd);
    res.json({ ok: true, commandId: id });
  });

  app.get("/api/epic/agent/result/:id", (req, res) => {
    const result = epicResults.get(req.params.id);
    if (!result) return res.json({ status: "pending" });
    res.json(result);
  });

  app.get("/api/epic/agent/status", (_req, res) => {
    const stale = Date.now() - (epicAgentStatus.lastSeen || 0) > 60000;
    res.json({
      connected: epicAgentStatus.connected && !stale,
      lastSeen: epicAgentStatus.lastSeen,
      windows: epicAgentStatus.windows || [],
    });
  });

  app.get("/api/epic/agent/screenshots", (_req, res) => {
    const screenshots: any[] = [];
    for (const [id, r] of epicResults) {
      if (r.screenshot) {
        screenshots.push({
          commandId: id,
          data: r.data,
          receivedAt: r.receivedAt,
          hasScreenshot: true,
        });
      }
    }
    screenshots.sort((a, b) => b.receivedAt - a.receivedAt);
    res.json({ screenshots: screenshots.slice(0, 10) });
  });

  app.get("/api/epic/agent/screenshot/:id", (req, res) => {
    const result = epicResults.get(req.params.id);
    if (!result?.screenshot) return res.status(404).json({ error: "Not found" });
    const buf = Buffer.from(result.screenshot, "base64");
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-cache");
    res.send(buf);
  });

  app.get("/api/epic/scan-script", async (_req, res) => {
    const fs = await import("fs");
    const path = await import("path");
    const scriptPath = path.join(process.cwd(), "tools", "epic_scan.py");
    try {
      const content = fs.readFileSync(scriptPath, "utf-8");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="epic_scan.py"');
      res.send(content);
    } catch {
      res.status(404).json({ error: "Script not found" });
    }
  });

  app.get("/api/epic/agent-script", async (_req, res) => {
    const fs = await import("fs");
    const path = await import("path");
    const scriptPath = path.join(process.cwd(), "tools", "epic_agent.py");
    try {
      const content = fs.readFileSync(scriptPath, "utf-8");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="epic_agent.py"');
      res.send(content);
    } catch {
      res.status(404).json({ error: "Script not found" });
    }
  });

  app.get("/api/epic/record/status", (_req, res) => {
    res.json({
      active: epicRecordingState.active,
      startedAt: epicRecordingState.startedAt,
      env: epicRecordingState.env,
      stepCount: epicRecordingState.steps.length,
    });
  });

  app.post("/api/epic/record/start", (req, res) => {
    const isLocal = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      const auth = req.headers.authorization;
      if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    if (epicRecordingState.active) {
      return res.status(409).json({ error: "Recording already active" });
    }
    const env = (req.body.env || "SUP").toUpperCase();
    epicRecordingState = { active: true, draining: false, startedAt: Date.now(), env, steps: [] };
    const id = `epic-${Date.now()}-rec-start`;
    epicCommandQueue.push({ id, type: "record_start", env });
    res.json({ ok: true, env });
  });

  app.post("/api/epic/record/stop", (req, res) => {
    const isLocal = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      const auth = req.headers.authorization;
      if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    if (!epicRecordingState.active && !epicRecordingState.draining) {
      return res.status(409).json({ error: "No recording active" });
    }
    epicRecordingState.active = false;
    epicRecordingState.draining = true;
    const id = `epic-${Date.now()}-rec-stop`;
    epicCommandQueue.push({ id, type: "record_stop" });
    setTimeout(() => { epicRecordingState.draining = false; }, 10000);
    const steps = [...epicRecordingState.steps];
    res.json({ ok: true, steps });
  });

  app.post("/api/epic/record/steps", (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { steps } = req.body;
    if (!Array.isArray(steps)) {
      return res.status(400).json({ error: "Missing steps array" });
    }
    if (!epicRecordingState.active && !epicRecordingState.draining) {
      return res.status(409).json({ error: "No recording active" });
    }
    for (const s of steps) {
      epicRecordingState.steps.push({
        step: epicRecordingState.steps.length + 1,
        description: s.description || "",
        screen: s.screen || "",
        timeDelta: s.timeDelta || 0,
      });
    }
    res.json({ ok: true, totalSteps: epicRecordingState.steps.length });
  });

  app.post("/api/epic/record/save", async (req, res) => {
    const isLocal = req.ip === "127.0.0.1" || req.ip === "::1" || req.ip === "::ffff:127.0.0.1";
    if (!isLocal) {
      const auth = req.headers.authorization;
      if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
        return res.status(401).json({ error: "Unauthorized" });
      }
    }
    const { name } = req.body;
    const steps = Array.isArray(req.body.steps) && req.body.steps.length > 0
      ? req.body.steps
      : epicRecordingState.steps;
    if (!name || steps.length === 0) {
      return res.status(400).json({ error: "Missing name or no recorded steps" });
    }
    const safeName = name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_").toLowerCase();
    if (!safeName) return res.status(400).json({ error: "Invalid workflow name" });
    const key = `epic_workflow_${safeName}`;
    const workflow = {
      name,
      env: epicRecordingState.env || "SUP",
      createdAt: new Date().toISOString(),
      steps,
    };
    await storage.setAgentConfig(key, JSON.stringify(workflow), "epic");
    res.json({ ok: true, key: safeName });
  });

  app.post("/api/epic/activities", async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const { environment, activities } = req.body;
    if (!environment || !Array.isArray(activities)) {
      return res.status(400).json({ error: "Missing environment or activities" });
    }
    const env = environment.toUpperCase();
    const key = `epic_activities_${env.toLowerCase()}`;
    const existing = await storage.getAgentConfig(key);
    let current: any[] = [];
    if (existing?.value) {
      try { current = JSON.parse(existing.value); } catch {}
    }
    const seen = new Set(current.map((a: any) => `${a.name}|${a.category || ""}|${a.parent || ""}`));
    for (const a of activities) {
      const k = `${a.name}|${a.category || ""}|${a.parent || ""}`;
      if (!seen.has(k)) {
        seen.add(k);
        current.push(a);
      }
    }
    await storage.setAgentConfig(key, JSON.stringify(current), "epic");
    res.json({ ok: true, environment: env, count: current.length });
  });

  app.post("/api/epic/tree", async (req, res) => {
    const auth = req.headers.authorization;
    if (!auth || !validateBridgeToken(auth.replace("Bearer ", ""))) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const tree = req.body;
    if (!tree || !tree.client || !tree.environment) {
      return res.status(400).json({ error: "Missing client or environment in tree data" });
    }
    const client = tree.client.toLowerCase();
    const env = tree.environment.toUpperCase();
    const key = `epic_tree_${env.toLowerCase()}_${client}`;

    const existing = await storage.getAgentConfig(key);
    if (existing?.value) {
      try {
        const existingTree = JSON.parse(existing.value);
        if (existingTree.locked && !tree.locked) {
          return res.json({ ok: false, reason: "Tree is locked. Use force=true or re-crawl to overwrite.", locked: true });
        }
      } catch {}
    }

    function countNodes(node: any): number {
      let c = 0;
      for (const child of (node.children || [])) {
        c += 1;
        c += countNodes(child);
      }
      return c;
    }

    const nodeCount = countNodes(tree);
    await storage.setAgentConfig(key, JSON.stringify(tree), "epic");
    res.json({ ok: true, environment: env, client, nodeCount, locked: !!tree.locked });
  });

  app.get("/api/epic/tree/:env", async (req, res) => {
    const env = req.params.env.toUpperCase();
    const trees: Record<string, any> = {};
    for (const client of ["hyperspace", "text"]) {
      const key = `epic_tree_${env.toLowerCase()}_${client}`;
      const cfg = await storage.getAgentConfig(key);
      if (cfg?.value) {
        try { trees[client] = JSON.parse(cfg.value); } catch {}
      }
    }
    res.json({ environment: env, trees });
  });

  app.get("/api/epic/autocomplete", async (req, res) => {
    const q = ((req.query.q as string) || "").toLowerCase().trim();
    if (!q || q.length < 2) return res.json({ results: [] });

    function searchTree(node: any, results: any[], env: string, client: string) {
      for (const child of (node.children || [])) {
        const name = (child.name || "").toLowerCase();
        const path = child.path || child.name || "";
        if (name.includes(q) || path.toLowerCase().includes(q)) {
          results.push({ name: child.name, path, env, client, controlType: child.controlType || "" });
        }
        searchTree(child, results, env, client);
      }
    }

    const results: any[] = [];
    for (const env of ["SUP", "POC", "TST"]) {
      for (const client of ["hyperspace", "text"]) {
        const key = `epic_tree_${env.toLowerCase()}_${client}`;
        const cfg = await storage.getAgentConfig(key);
        if (cfg?.value) {
          try { searchTree(JSON.parse(cfg.value), results, env, client); } catch {}
        }
      }
    }

    res.json({ results: results.slice(0, 20), total: results.length });
  });

  app.get("/api/epic/activities/:env", async (req, res) => {
    const env = req.params.env.toUpperCase();
    const key = `epic_activities_${env.toLowerCase()}`;
    const cfg = await storage.getAgentConfig(key);
    let activities: any[] = [];
    if (cfg?.value) {
      try { activities = JSON.parse(cfg.value); } catch {}
    }
    res.json({ environment: env, activities, count: activities.length });
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

    let allTranscripts: any[] = [];
    try { allTranscripts = await storage.getTranscripts(); } catch {}

    const epicActivities: Record<string, any[]> = {};
    for (const env of ["sup", "poc", "tst"]) {
      try {
        const cfg = await storage.getAgentConfig(`epic_activities_${env}`);
        if (cfg?.value) {
          const parsed = JSON.parse(cfg.value);
          if (Array.isArray(parsed) && parsed.length > 0) epicActivities[env.toUpperCase()] = parsed;
        }
      } catch {}
    }

    let pulseLinks: any[] = [];
    try {
      const pulseCfg = await storage.getAgentConfig("pulse_links");
      if (pulseCfg?.value) {
        const parsed = JSON.parse(pulseCfg.value);
        if (Array.isArray(parsed)) pulseLinks = parsed;
      }
    } catch {}

    const epicTrees: Record<string, Record<string, any>> = {};
    for (const env of ["sup", "poc", "tst"]) {
      for (const client of ["hyperspace", "text"]) {
        try {
          const cfg = await storage.getAgentConfig(`epic_tree_${env}_${client}`);
          if (cfg?.value) {
            const parsed = JSON.parse(cfg.value);
            if (parsed && parsed.children) {
              if (!epicTrees[env.toUpperCase()]) epicTrees[env.toUpperCase()] = {};
              epicTrees[env.toUpperCase()][client] = parsed;
            }
          }
        } catch {}
      }
    }

    const galaxyCategories: Record<number, string> = {};
    const galaxyPageIds = allPages.filter(p => p.domain === "galaxy.epic.com").map(p => p.id);
    for (const id of galaxyPageIds) {
      try {
        const cfg = await storage.getAgentConfig(`galaxy_category_${id}`);
        if (cfg?.value) galaxyCategories[id] = cfg.value;
      } catch {}
    }

    const epicWorkflows: Array<{ name: string; key: string; env: string; stepCount: number; createdAt: string }> = [];
    try {
      const allConfigs = await storage.getAgentConfigs();
      for (const cfg of allConfigs) {
        if (cfg.key.startsWith("epic_workflow_") && cfg.value) {
          try {
            const wf = JSON.parse(cfg.value);
            epicWorkflows.push({
              name: wf.name || cfg.key.replace("epic_workflow_", ""),
              key: cfg.key.replace("epic_workflow_", ""),
              env: wf.env || "SUP",
              stepCount: (wf.steps || []).length,
              createdAt: wf.createdAt || "",
            });
          } catch {}
        }
      }
    } catch {}

    let citrixPortals: any[] = [];
    const citrixPortalApps: Record<string, any[]> = {};
    try {
      const portalCfg = await storage.getAgentConfig("citrix_portals");
      if (portalCfg?.value) {
        citrixPortals = JSON.parse(portalCfg.value);
      } else {
        citrixPortals = [{ name: "UCSD CWP", url: "https://cwp.ucsd.edu", lastScanned: null, appCount: 0 }];
      }
      for (const portal of citrixPortals) {
        const key = `citrix_portal_apps_${portal.name.toLowerCase().replace(/\s+/g, "_")}`;
        const appsCfg = await storage.getAgentConfig(key);
        if (appsCfg?.value) {
          const parsed = JSON.parse(appsCfg.value);
          if (Array.isArray(parsed) && parsed.length > 0) {
            citrixPortalApps[portal.name] = parsed;
          }
        }
      }
    } catch {}

    res.json({
      tasks: allTasks,
      programs: allPrograms,
      skills: allSkills,
      notes: allNotes,
      captures: allCaptures,
      reader: allPages,
      transcripts: allTranscripts,
      epicActivities,
      epicTrees,
      epicWorkflows,
      pulseLinks,
      galaxyCategories,
      citrixPortals,
      citrixPortalApps,
    });
  });

  app.get("/api/bridge/status", async (_req, res) => {
    const playwrightStatus = getBridgeStatus();
    const queueStatus = getQueueStatus();
    res.json({
      ...playwrightStatus,
      extension: {
        connected: queueStatus.extensionConnected,
        lastSeen: queueStatus.extensionLastSeen,
        version: queueStatus.extensionVersion,
        jobsCompleted: queueStatus.extensionJobsCompleted,
        lastError: queueStatus.extensionLastError,
      },
      queue: {
        pending: queueStatus.pending,
        completed: queueStatus.completed,
        jobs: queueStatus.jobs,
      },
    });
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
      const { getMailCache, setMailCache, parseOutlookInbox } = await import("./cli-engine");
      const refresh = _req.query.refresh === "1";
      const cached = getMailCache();
      if (cached && cached.emails.length > 0 && !refresh) {
        return res.json(cached.emails.map((e, i) => ({ index: i, ...e })));
      }

      const { smartFetch, isExtensionConnected } = await import("./bridge-queue");
      if (isExtensionConnected()) {
        const result = await smartFetch("https://outlook.office.com/mail/inbox", "dom", "api-mail-inbox", {
          maxText: 60000,
          selectors: {
            rows: '[role="option"][aria-label], [role="listbox"] [role="option"], div[data-convid], tr[aria-label]',
          },
        }, 60000);
        if (!result.error) {
          const text = result.text || "";
          const html = typeof result.body === "string" ? result.body : "";
          const extracted = (result as any).extracted || {};
          const emails = parseOutlookInbox(html || text, text, extracted);
          if (emails.length > 0) {
            setMailCache({ emails, fetchedAt: Date.now() });
            return res.json(emails.map((e, i) => ({ index: i, ...e })));
          }
        }
      }

      if (cached && cached.emails.length > 0) {
        return res.json(cached.emails.map((e, i) => ({ index: i, ...e })));
      }
      res.json([]);
    } catch (e: unknown) {
      const { getMailCache } = await import("./cli-engine");
      const cached = getMailCache();
      if (cached && cached.emails.length > 0) {
        return res.json(cached.emails.map((e, i) => ({ index: i, ...e })));
      }
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/mail/calendar", async (_req, res) => {
    try {
      const { getCalendarCache } = await import("./cli-engine");
      const cached = getCalendarCache();
      if (cached) return res.json(cached.events);
      res.json([]);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/mail/:index", async (req, res) => {
    const idx = parseInt(req.params.index, 10);
    try {
      const { getMailCache } = await import("./cli-engine");
      const cached = getMailCache();
      if (cached && idx >= 0 && idx < cached.emails.length) {
        const e = cached.emails[idx];
        return res.json({ from: e.from, to: "", subject: e.subject, body: e.preview, date: e.date });
      }
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
      const { getTeamsCache } = await import("./cli-engine");
      const cached = getTeamsCache();
      if (cached && cached.chats.length > 0) {
        return res.json(cached.chats.map((c, i) => ({ index: i, ...c })));
      }
      const chats = await getTeamsChats();
      res.json(chats);
    } catch (e: unknown) {
      const { getTeamsCache } = await import("./cli-engine");
      const cached = getTeamsCache();
      if (cached && cached.chats.length > 0) {
        return res.json(cached.chats.map((c, i) => ({ index: i, ...c })));
      }
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

  app.get("/api/snow/records", async (_req, res) => {
    try {
      const { getSnowCache, setSnowCache } = await import("./cli-engine");
      const cached = getSnowCache();
      if (cached && cached.records.length > 0) {
        return res.json({ records: cached.records, fetchedAt: cached.fetchedAt });
      }
      const persistedResults = await storage.getAgentResults("snow-scraper", 1);
      if (persistedResults.length > 0 && persistedResults[0].rawOutput) {
        try {
          const records = JSON.parse(persistedResults[0].rawOutput);
          if (Array.isArray(records) && records.length > 0) {
            setSnowCache({ records, fetchedAt: persistedResults[0].createdAt?.getTime?.() || Date.now() });
            return res.json({ records, fetchedAt: persistedResults[0].createdAt?.getTime?.() || Date.now() });
          }
        } catch {}
      }
      res.json({ records: [], fetchedAt: null });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.post("/api/snow/refresh", async (_req, res) => {
    try {
      const { executeChainRaw } = await import("./cli-engine");
      const result = await executeChainRaw("snow refresh");
      res.json({ success: result.exitCode === 0, output: result.stdout || result.stderr });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/snow/queue", async (_req, res) => {
    try {
      const { getSnowCache, setSnowCache } = await import("./cli-engine");
      let cached = getSnowCache();
      if (!cached || cached.records.length === 0) {
        const persistedResults = await storage.getAgentResults("snow-scraper", 1);
        if (persistedResults.length > 0 && persistedResults[0].rawOutput) {
          try {
            const records = JSON.parse(persistedResults[0].rawOutput);
            if (Array.isArray(records) && records.length > 0) {
              cached = { records, fetchedAt: persistedResults[0].createdAt?.getTime?.() || Date.now() };
              setSnowCache(cached);
            }
          } catch {}
        }
      }
      if (!cached) return res.json({ myQueue: [], teamWorkload: [], agingRisk: [] });

      const myQueue = cached.records
        .filter(r => r.source === "personal" && r.state !== "Closed" && r.state !== "Resolved" && r.state !== "Canceled")
        .sort((a, b) => {
          const pA = parseInt(a.priority) || 5;
          const pB = parseInt(b.priority) || 5;
          return pA - pB;
        });

      const allRecords = cached.records;
      const groups = new Map<string, number>();
      const personLoad = new Map<string, number>();
      for (const r of allRecords) {
        const g = r.assignmentGroup || "Unassigned";
        groups.set(g, (groups.get(g) || 0) + 1);
        if (r.assignedTo) {
          personLoad.set(r.assignedTo, (personLoad.get(r.assignedTo) || 0) + 1);
        }
      }
      const teamWorkload = [
        ...Array.from(groups.entries()).map(([group, count]) => ({ group, count, type: "group" as const })),
        ...Array.from(personLoad.entries()).map(([group, count]) => ({ group: `  ${group}`, count, type: "person" as const })),
      ].sort((a, b) => {
        if (a.type !== b.type) return a.type === "group" ? -1 : 1;
        return b.count - a.count;
      });

      const agingRisk = allRecords.filter(r => r.slaBreached);

      res.json({ myQueue, teamWorkload, agingRisk, fetchedAt: cached.fetchedAt });
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

  const bridgeAuth = (req: any, res: any, next: any) => {
    const token = req.headers["x-bridge-token"] || req.query.token;
    if (!validateBridgeToken(token)) {
      return res.status(403).json({ error: "Invalid bridge token" });
    }
    next();
  };

  app.get("/api/bridge/ext/token", (req, res) => {
    const authHeader = req.headers.authorization;
    const apiKey = process.env.OPENCLAW_API_KEY;
    if (apiKey && (!authHeader || authHeader.slice(7) !== apiKey)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    res.json({ token: getBridgeToken() });
  });

  app.get("/api/bridge/ext/jobs", bridgeAuth, (req, res) => {
    const version = req.headers["x-bridge-version"] as string | undefined;
    const jobsCompleted = req.headers["x-bridge-jobs"] ? parseInt(req.headers["x-bridge-jobs"] as string, 10) : undefined;
    const lastError = req.headers["x-bridge-error"] as string | undefined;
    recordHeartbeat({ version, jobsCompleted, error: lastError || null });
    const jobs = claimJobsTracked();
    res.json(jobs);
  });

  app.post("/api/bridge/ext/results", bridgeAuth, (req, res) => {
    const { jobId, ...result } = req.body;
    if (!jobId) return res.status(400).json({ error: "jobId required" });
    const resultKeys = Object.keys(result);
    const hasClick = "clickDebug" in result;
    console.log(`[bridge-result] jobId=${jobId} keys=[${resultKeys.join(",")}] hasClickDebug=${hasClick} title=${(result as any).title || "(none)"}`);
    if (hasClick) {
      const cd = (result as any).clickDebug || {};
      const summary = { method: cd.method, steps: cd.steps, dlResult: cd.dlResult, error: cd.error, matchedApp: cd.matchedApp };
      console.log(`[bridge-result] clickDebug=${JSON.stringify(summary)}`);
    }
    resolveResult(jobId, { ...result, jobId, completedAt: Date.now(), source: "extension" });
    res.json({ ok: true });
  });

  app.get("/api/bridge/ext/health", (_req, res) => {
    res.json({ ok: true, service: "orgcloud-bridge" });
  });

  app.get("/api/bridge/ext/queue", bridgeAuth, (_req, res) => {
    res.json(getQueueStatus());
  });

  app.post("/api/bridge/ext/submit", bridgeAuth, async (req, res) => {
    const { type, url, submittedBy, options, wait } = req.body;
    if (!type || !url) return res.status(400).json({ error: "type and url required" });
    try {
      const jobId = submitJob(type, url, submittedBy || "api", options);
      if (wait) {
        const timeoutMs = typeof wait === "number" ? wait : 30000;
        const result = await waitForResult(jobId, timeoutMs);
        return res.json(result);
      }
      res.json({ jobId });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

  app.get("/api/transcripts", async (_req, res) => {
    const all = await storage.getTranscripts();
    res.json(all);
  });

  app.get("/api/transcripts/active", (_req, res) => {
    res.json(getActiveRecordingSessions());
  });

  app.get("/api/transcripts/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const t = await storage.getTranscript(id);
    if (!t) return res.status(404).json({ message: "Transcript not found" });
    res.json(t);
  });

  app.delete("/api/transcripts/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteTranscript(id);
    res.status(204).send();
  });

  const apiKeyAuth: import("express").RequestHandler = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const apiKey = process.env.OPENCLAW_API_KEY;
    if (apiKey && (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== apiKey)) {
      res.status(401).json({ message: "Unauthorized" });
      return;
    }
    next();
  };

  app.post("/api/transcripts/record/start", apiKeyAuth, async (req, res) => {
    const { sourceUrl, tabTitle, recordingType } = req.body;
    try {
      const result = await startRecordingSession(sourceUrl || "", tabTitle || "", recordingType || "tab");
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/transcripts/record/:sessionId/chunk", apiKeyAuth, upload.single("audio"), async (req, res) => {
    const sessionId = req.params.sessionId as string;
    try {
      const buffer = req.file?.buffer;
      if (!buffer) return res.status(400).json({ message: "No audio data" });
      await addAudioChunk(sessionId, buffer);
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(400).json({ message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/transcripts/record/:sessionId/stop", apiKeyAuth, async (req, res) => {
    const sessionId = req.params.sessionId as string;
    try {
      const result = await stopRecordingSession(sessionId);
      res.json(result);
    } catch (e: unknown) {
      res.status(400).json({ message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/bridge/ext/audio", bridgeAuth, upload.single("audio"), async (req, res) => {
    const { sessionId, action, sourceUrl, tabTitle } = req.body;
    try {
      if (action === "start") {
        const result = await startRecordingSession(sourceUrl || "", tabTitle || "", "tab");
        return res.json(result);
      }
      if (action === "chunk" && sessionId) {
        const buffer = req.file?.buffer;
        if (!buffer) return res.status(400).json({ message: "No audio data" });
        await addAudioChunk(sessionId, buffer);
        return res.json({ ok: true });
      }
      if (action === "stop" && sessionId) {
        const result = await stopRecordingSession(sessionId);
        return res.json(result);
      }
      res.status(400).json({ message: "Invalid action" });
    } catch (e: unknown) {
      res.status(400).json({ message: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post("/api/transcripts/upload", apiKeyAuth, upload.single("audio"), async (req, res) => {
    try {
      const buffer = req.file?.buffer;
      if (!buffer) return res.status(400).json({ message: "No audio file" });
      const sourceUrl = req.body.sourceUrl || "";
      const title = req.body.title || "";
      const recordingType = req.body.recordingType || "manual";
      const result = await transcribeUploadedAudio(buffer, sourceUrl, title, recordingType);
      res.json(result);
    } catch (e: unknown) {
      res.status(500).json({ message: e instanceof Error ? e.message : String(e) });
    }
  });

  const path = await import("path");
  const fs = await import("fs");
  const briefingsDir = path.join(process.cwd(), ".briefings");
  if (!fs.existsSync(briefingsDir)) fs.mkdirSync(briefingsDir, { recursive: true });

  app.get("/briefings/:filename", (req, res) => {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9._-]/g, "");
    const filePath = path.resolve(briefingsDir, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send("Not found");
    if (filename.endsWith(".mp3")) {
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    } else if (filename.endsWith(".html")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    }
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => { if (!res.headersSent) res.status(500).send("Read error"); });
    stream.pipe(res);
  });

  app.get("/briefings", (_req, res) => {
    const files = fs.readdirSync(briefingsDir)
      .filter((f: string) => f.endsWith(".html"))
      .sort()
      .reverse();
    const links = files.map((f: string) => `<li><a href="/briefings/${f}">${f.replace(".html", "")}</a></li>`).join("\n");
    res.send(`<!DOCTYPE html><html><head><title>Briefings</title><style>body{background:#0a0a0a;color:#00ff41;font-family:'IBM Plex Mono',monospace;padding:2em}a{color:#00ff41}a:hover{color:#fff}</style></head><body><h1>Briefing Archive</h1><ul>${links}</ul></body></html>`);
  });

  app.post("/api/voice-cmd", apiKeyAuth, async (req, res) => {
    try {
      const raw = req.body.text || req.body.value1 || req.body.command || "";
      const source = req.body.source || req.body.value2 || "google-home";
      if (!raw.trim()) {
        res.status(400).json({ message: "No command provided" });
        return;
      }

      const VOICE_MAP: Array<{ keywords: string[]; cmd: string; label: string }> = [
        { keywords: ["inbox", "email", "mail", "outlook"], cmd: "outlook", label: "Checking inbox" },
        { keywords: ["agenda", "schedule", "today", "briefing", "morning"], cmd: "agenda", label: "Getting agenda" },
        { keywords: ["snow", "servicenow", "tickets", "incidents"], cmd: "snow refresh", label: "Refreshing ServiceNow" },
        { keywords: ["standup", "stand up", "summary", "yesterday"], cmd: "standup", label: "Running standup" },
        { keywords: ["runtime", "programs", "agents"], cmd: "programs", label: "Listing programs" },
        { keywords: ["tasks", "todo", "to do"], cmd: "tasks", label: "Listing tasks" },
        { keywords: ["search"], cmd: "", label: "Searching" },
        { keywords: ["citrix", "apps", "cwp"], cmd: "citrix", label: "Listing Citrix apps" },
        { keywords: ["teams", "chat", "chats"], cmd: "teams", label: "Fetching Teams chats" },
        { keywords: ["notify", "alert", "ping"], cmd: "", label: "Sending notification" },
      ];

      const lower = raw.toLowerCase().trim();
      let cliCmd = "";
      let label = "Running command";

      if (lower.startsWith("memo ") || lower.startsWith("save memo ") || lower.startsWith("remember ")) {
        const memoText = lower.replace(/^(save memo|memo|remember)\s+/i, "").trim();
        cliCmd = `capture "${memoText.replace(/"/g, '\\"')}"`;
        label = "Saving memo";
      } else if (lower.startsWith("search ") || lower.startsWith("find ")) {
        const query = lower.replace(/^(search|find)\s+/i, "").trim();
        cliCmd = `search ${query}`;
        label = "Searching";
      } else if (lower.startsWith("notify ") || lower.startsWith("alert ") || lower.startsWith("ping ")) {
        const msg = lower.replace(/^(notify|alert|ping)\s+/i, "").trim();
        cliCmd = `notify ${msg}`;
        label = "Sending notification";
      } else {
        for (const mapping of VOICE_MAP) {
          if (mapping.keywords.some(kw => lower.includes(kw))) {
            cliCmd = mapping.cmd;
            label = mapping.label;
            break;
          }
        }
      }

      if (!cliCmd) {
        cliCmd = `capture "${raw.replace(/"/g, '\\"')}"`;
        label = "Saved as memo (unrecognized command)";
      }

      recordAction("agent", `voice-cmd: ${label}`, cliCmd, "autonomous", "executing", `source=${source}, raw="${raw}"`);
      const result = await executeChain(cliCmd);

      const truncOut = (result.output || "").slice(0, 200);
      recordAction("agent", `voice-cmd: ${label}`, cliCmd, "autonomous", result.exitCode === 0 ? "success" : "error", truncOut);

      addNotification(label, truncOut, source, cliCmd);

      const shouldNotify = req.body.notify !== false;
      if (shouldNotify) {
        try {
          await executeChain(`notify "${label}: done"`);
        } catch {}
      }

      res.json({ ok: true, command: cliCmd, label, output: result.output, exitCode: result.exitCode, source });
    } catch (e: unknown) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  app.post("/api/memo", apiKeyAuth, async (req, res) => {
    try {
      const text = req.body.text || req.body.memo || req.body.value1 || "";
      const source = req.body.source || req.body.value2 || "voice";
      const tags = req.body.tags || ["memo", "voice"];
      if (!text.trim()) {
        res.status(400).json({ message: "No text provided" });
        return;
      }
      const timestamp = new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" });
      const title = `[Memo] ${text.slice(0, 60)}`;
      const body = `${text}${String.fromCharCode(10)}${String.fromCharCode(10)}---${String.fromCharCode(10)}_Captured via ${source} at ${timestamp}_`;
      const note = await storage.createNote({ title, body, tags: Array.isArray(tags) ? tags : [tags] });
      addNotification("Memo saved", text.slice(0, 200), source, "memo");
      res.json({ ok: true, id: note.id, title: note.title });
    } catch (e: unknown) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  app.get("/api/memo", apiKeyAuth, async (_req, res) => {
    const notes = await storage.getNotes();
    const memos = notes.filter(n => n.tags?.includes("memo")).slice(0, 20);
    res.json(memos);
  });

  app.get("/api/notifications", (_req, res) => {
    const since = parseInt(String(_req.query.since || "0"), 10);
    const items = since ? notifications.filter(n => n.timestamp > since) : notifications.slice(-20);
    res.json({ notifications: items, total: notifications.length });
  });

  app.post("/api/notifications/:id/read", (_req, res) => {
    const n = notifications.find(x => x.id === _req.params.id);
    if (n) n.read = true;
    res.json({ ok: true });
  });

  app.post("/api/notifications/read-all", (_req, res) => {
    notifications.forEach(n => n.read = true);
    res.json({ ok: true });
  });

  app.get("/api/meal-plans", async (_req, res) => {
    const plans = await storage.getMealPlans();
    res.json(plans);
  });

  app.get("/api/meal-plans/active", async (_req, res) => {
    const plan = await storage.getActiveMealPlan();
    if (!plan) return res.status(404).json({ message: "No active meal plan" });
    res.json(plan);
  });

  app.get("/api/meal-plans/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const plan = await storage.getMealPlan(id);
    if (!plan) return res.status(404).json({ message: "Meal plan not found" });
    res.json(plan);
  });

  app.post("/api/meal-plans", async (req, res) => {
    const parsed = insertMealPlanSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const plan = await storage.createMealPlan(parsed.data);
    res.status(201).json(plan);
  });

  app.patch("/api/meal-plans/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertMealPlanSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateMealPlan(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Meal plan not found" });
    res.json(updated);
  });

  app.delete("/api/meal-plans/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteMealPlan(id);
    res.status(204).send();
  });

  app.get("/api/shopping-lists", async (_req, res) => {
    const lists = await storage.getShoppingLists();
    res.json(lists);
  });

  app.get("/api/shopping-lists/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const list = await storage.getShoppingList(id);
    if (!list) return res.status(404).json({ message: "Shopping list not found" });
    res.json(list);
  });

  app.post("/api/shopping-lists", async (req, res) => {
    const parsed = insertShoppingListSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const list = await storage.createShoppingList(parsed.data);
    res.status(201).json(list);
  });

  app.patch("/api/shopping-lists/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertShoppingListSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updateShoppingList(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Shopping list not found" });
    res.json(updated);
  });

  app.get("/api/pantry", async (req, res) => {
    const status = req.query.status as string | undefined;
    const items = await storage.getPantryItems(status);
    res.json(items);
  });

  app.get("/api/pantry/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const item = await storage.getPantryItem(id);
    if (!item) return res.status(404).json({ message: "Pantry item not found" });
    res.json(item);
  });

  app.post("/api/pantry", async (req, res) => {
    const parsed = insertPantryItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const item = await storage.createPantryItem(parsed.data);
    res.status(201).json(item);
  });

  app.patch("/api/pantry/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const parsed = insertPantryItemSchema.partial().safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const updated = await storage.updatePantryItem(id, parsed.data);
    if (!updated) return res.status(404).json({ message: "Pantry item not found" });
    res.json(updated);
  });

  app.delete("/api/pantry/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deletePantryItem(id);
    res.status(204).send();
  });

  app.get("/api/kiddo-food-log", async (_req, res) => {
    const logs = await storage.getKiddoFoodLogs();
    res.json(logs);
  });

  app.post("/api/kiddo-food-log", async (req, res) => {
    const parsed = insertKiddoFoodLogSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const log = await storage.createKiddoFoodLog(parsed.data);
    res.status(201).json(log);
  });

  app.get("/api/nightly-recommendations", async (req, res) => {
    const limit = parseInt(req.query.limit as string || "20", 10);
    const recs = await storage.getNightlyRecommendations(limit);
    res.json(recs);
  });

  app.get("/api/nightly-recommendations/tonight", async (_req, res) => {
    const today = new Date().toISOString().split("T")[0];
    const rec = await storage.getNightlyRecommendationByDate(today);
    if (!rec) return res.status(404).json({ message: "No recommendation for tonight" });
    res.json(rec);
  });

  app.post("/api/nightly-recommendations", async (req, res) => {
    const parsed = insertNightlyRecommendationSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const rec = await storage.createNightlyRecommendation(parsed.data);
    res.status(201).json(rec);
  });

  app.post("/api/nightly-recommendations/:id/accept", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.updateNightlyRecommendationStatus(id, "accepted");
    if (!updated) return res.status(404).json({ message: "Recommendation not found" });
    res.json(updated);
  });

  app.post("/api/nightly-recommendations/:id/skip", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.updateNightlyRecommendationStatus(id, "skipped");
    if (!updated) return res.status(404).json({ message: "Recommendation not found" });
    res.json(updated);
  });

  return httpServer;
}
