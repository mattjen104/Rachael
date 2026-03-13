import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertProgramSchema, insertSkillSchema, insertTaskSchema, insertNoteSchema, insertCaptureSchema, insertOpenclawProposalSchema } from "@shared/schema";
import { parseCaptureEntry, formatOrgEntry } from "./capture-parser";
import { detectContentType, fetchUrlMetadata } from "./content-detector";
import { seedDatabase } from "./seed-data";
import { getRuntimeState, toggleRuntime, manualTrigger } from "./agent-runtime";
import { getBridgeStatus, launchBrowser, closeBrowser, startLoginSession, getPageContent, openPage, getPageText } from "./browser-bridge";
import { openOutlook, openTeams, getOutlookEmails, readOutlookEmail, getTeamsChats, readTeamsChat } from "./app-adapters";

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

  return httpServer;
}
