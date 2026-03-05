import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOrgFileSchema, insertClipboardItemSchema, insertAgendaItemSchema } from "@shared/schema";
import { z } from "zod";
import { parseOrgFile, buildAgenda, toggleHeadingStatus } from "./org-parser";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {

  // ── Org Files ──────────────────────────────────────────────

  app.get("/api/org-files", async (_req, res) => {
    const files = await storage.getOrgFiles();
    res.json(files);
  });

  app.get("/api/org-files/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const file = await storage.getOrgFile(id);
    if (!file) return res.status(404).json({ message: "File not found" });
    res.json(file);
  });

  app.get("/api/org-files/by-name/:name", async (req, res) => {
    const file = await storage.getOrgFileByName(req.params.name);
    if (!file) return res.status(404).json({ message: "File not found" });
    res.json(file);
  });

  app.post("/api/org-files", async (req, res) => {
    const parsed = insertOrgFileSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const file = await storage.createOrgFile(parsed.data);
    res.status(201).json(file);
  });

  app.patch("/api/org-files/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ message: "content must be a string" });
    const file = await storage.updateOrgFileContent(id, content);
    if (!file) return res.status(404).json({ message: "File not found" });
    res.json(file);
  });

  // ── Org Capture (quick task creation) ──────────────────────

  const captureSchema = z.object({
    fileName: z.string().min(1),
    title: z.string().min(1).transform(v => v.replace(/[\n\r]/g, " ").trim()),
    scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    tags: z.array(z.string().transform(v => v.replace(/[\s:]/g, ""))).optional(),
  });

  app.post("/api/org-files/capture", async (req, res) => {
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

    const { fileName, title, scheduledDate, tags } = parsed.data;
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const date = scheduledDate || new Date().toISOString().split("T")[0];
    const cleanTags = tags?.filter(Boolean);
    const tagStr = cleanTags && cleanTags.length > 0 ? ` :${cleanTags.join(":")}:` : "";
    const entry = `\n** TODO ${title}${tagStr}\n   SCHEDULED: <${date}>\n`;

    const inboxRegex = /^\*\s+INBOX/m;
    const inboxMatch = inboxRegex.exec(file.content);
    let newContent: string;
    if (inboxMatch) {
      const afterInbox = file.content.indexOf("\n", inboxMatch.index);
      const insertAt = afterInbox !== -1 ? afterInbox + 1 : file.content.length;
      newContent = file.content.slice(0, insertAt) + entry + file.content.slice(insertAt);
    } else {
      newContent = file.content + `\n* INBOX\n` + entry;
    }

    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.status(201).json(updated);
  });

  // ── Clipboard ──────────────────────────────────────────────

  app.get("/api/clipboard", async (_req, res) => {
    const items = await storage.getClipboardItems();
    res.json(items);
  });

  app.post("/api/clipboard", async (req, res) => {
    const parsed = insertClipboardItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const item = await storage.createClipboardItem(parsed.data);
    res.status(201).json(item);
  });

  app.delete("/api/clipboard/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.deleteClipboardItem(id);
    res.status(204).send();
  });

  app.post("/api/clipboard/:id/archive", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.archiveClipboardItem(id);
    res.status(200).json({ message: "Archived" });
  });

  app.post("/api/clipboard/:id/append-to-org", async (req, res) => {
    const clipId = parseInt(req.params.id, 10);
    const { orgFileName } = req.body;
    if (!orgFileName) return res.status(400).json({ message: "orgFileName required" });

    const items = await storage.getClipboardItems();
    const clipItem = items.find(i => i.id === clipId);
    if (!clipItem) return res.status(404).json({ message: "Clipboard item not found" });

    let orgFile = await storage.getOrgFileByName(orgFileName);
    if (!orgFile) return res.status(404).json({ message: "Org file not found" });

    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const appendEntry = `\n** TODO Process clipboard capture                                        :capture:clipboard:\n   SCHEDULED: <${dateStr}>\n   :PROPERTIES:\n   :SOURCE: System Clipboard\n   :CAPTURED_AT: [${dateStr}]\n   :END:\n   \n   ${clipItem.content}\n`;

    const updatedContent = orgFile.content + appendEntry;
    const updated = await storage.updateOrgFileContent(orgFile.id, updatedContent);
    await storage.archiveClipboardItem(clipId);

    res.json(updated);
  });

  // ── Org Queries (parsed from file content) ──────────────────

  app.get("/api/org-query/agenda", async (_req, res) => {
    const files = await storage.getOrgFiles();
    const allHeadings = files.flatMap(f => parseOrgFile(f.content, f.name));
    const today = new Date().toISOString().split("T")[0];
    const agenda = buildAgenda(allHeadings, today);
    res.json(agenda);
  });

  app.get("/api/org-query/todos", async (_req, res) => {
    const files = await storage.getOrgFiles();
    const allHeadings = files.flatMap(f => parseOrgFile(f.content, f.name));
    const todos = allHeadings.filter(h => h.status === "TODO");
    res.json(todos);
  });

  app.get("/api/org-query/done", async (_req, res) => {
    const files = await storage.getOrgFiles();
    const allHeadings = files.flatMap(f => parseOrgFile(f.content, f.name));
    const done = allHeadings.filter(h => h.status === "DONE");
    res.json(done);
  });

  app.post("/api/org-query/toggle", async (req, res) => {
    const { fileName, lineNumber } = req.body;
    if (!fileName || !lineNumber) {
      return res.status(400).json({ message: "fileName and lineNumber required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const { newContent, newStatus } = toggleHeadingStatus(file.content, lineNumber);
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated, newStatus });
  });

  // ── Agenda (legacy table-based) ────────────────────────────

  app.get("/api/agenda", async (_req, res) => {
    const items = await storage.getAgendaItems();
    res.json(items);
  });

  app.get("/api/agenda/:date", async (req, res) => {
    const items = await storage.getAgendaItemsByDate(req.params.date);
    res.json(items);
  });

  app.post("/api/agenda", async (req, res) => {
    const parsed = insertAgendaItemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });
    const item = await storage.createAgendaItem(parsed.data);
    res.status(201).json(item);
  });

  app.patch("/api/agenda/:id/status", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status } = req.body;
    if (!status || !["TODO", "DONE"].includes(status)) {
      return res.status(400).json({ message: "status must be TODO or DONE" });
    }
    const item = await storage.updateAgendaItemStatus(id, status);
    if (!item) return res.status(404).json({ message: "Agenda item not found" });
    res.json(item);
  });

  app.post("/api/agenda/carry-over", async (req, res) => {
    const today = new Date().toISOString().split("T")[0];
    const carried = await storage.carryOverIncompleteTasks(today);
    res.json(carried);
  });

  // ── Seed endpoint (creates default org files if none exist) ──

  app.post("/api/seed", async (_req, res) => {
    const existing = await storage.getOrgFiles();
    if (existing.length > 0) {
      return res.json({ message: "Already seeded", files: existing });
    }

    const defaults = [
      {
        name: "dad.org",
        content: `#+TITLE: Dad Knowledge Space
#+AUTHOR: Auto-Captured via iCloud
#+DATE: [${new Date().toISOString().split("T")[0]}]
#+STARTUP: showeverything

* INBOX Recent Captures
** TODO Process photo capture from Camera Roll                               :capture:photo:
   SCHEDULED: <${new Date().toISOString().split("T")[0]}>
   :PROPERTIES:
   :SOURCE: iCloud/Camera Roll
   :CAPTURED_AT: [${new Date().toISOString().split("T")[0]}]
   :END:
   
   New diagram of the architecture sketched on whiteboard.
   [[file:~/iCloud/Photos/IMG_20260304_0912.jpg]]

** DONE Review voice memo about project ideas                                :capture:voice:
   CLOSED: [${new Date().toISOString().split("T")[0]}]
   :PROPERTIES:
   :SOURCE: iCloud/Voice Memos
   :END:

* KNOWLEDGE BASE
** The Web App Architecture
   We are building a frontend React application that mimics Emacs/Doom mode 
   but runs in the browser. 
   
   Key features required:
   - [X] Vim keybindings (simulated visual states)
   - [X] Org-mode syntax highlighting
   - [ ] Auto-sync mechanism

** Notes on React State Management
   Remember to keep the UI snappy. The editor should ideally be completely 
   uncontrolled for the actual typing, with only metadata synced back up.
`,
      },
      { name: "inbox.org", content: "#+TITLE: Inbox\n#+STARTUP: showeverything\n\n* INBOX\n" },
      { name: "projects.org", content: "#+TITLE: Projects\n#+STARTUP: showeverything\n\n* Active Projects\n" },
      { name: "journal.org", content: "#+TITLE: Journal\n#+STARTUP: showeverything\n\n* Journal Entries\n" },
      { name: "someday.org", content: "#+TITLE: Someday / Maybe\n#+STARTUP: showeverything\n\n* Ideas\n" },
    ];

    const files = [];
    for (const f of defaults) {
      const created = await storage.createOrgFile(f);
      files.push(created);
    }

    const today = new Date().toISOString().split("T")[0];
    await storage.createAgendaItem({ text: "Process photos from iCloud", status: "TODO", scheduledDate: today });
    await storage.createAgendaItem({ text: "Review voice memo", status: "DONE", scheduledDate: today });
    await storage.createAgendaItem({ text: "Fix CSS layout bug", status: "TODO", scheduledDate: "2026-03-03" });
    await storage.createAgendaItem({ text: "Build TUI firmware", status: "TODO", scheduledDate: "2026-03-05" });

    await storage.createClipboardItem({ content: "https://github.com/hlissner/doom-emacs", type: "link" });
    await storage.createClipboardItem({ content: "const [mode, setMode] = useState<'NORMAL' | 'INSERT'>('NORMAL');", type: "code" });
    await storage.createClipboardItem({ content: "Remember to pick up groceries after work", type: "text" });

    res.status(201).json({ message: "Seeded", files });
  });

  return httpServer;
}
