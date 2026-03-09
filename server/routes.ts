import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOrgFileSchema, insertClipboardItemSchema, insertAgendaItemSchema } from "@shared/schema";
import { z } from "zod";
import { parseOrgFile, buildAgenda, toggleHeadingStatus, rescheduleHeading, editHeadingTitle, deleteHeading, moveHeadingWithinFile, extractHeadingBlock, changeHeadingLevel } from "./org-parser";
import { parseCaptureEntry, formatOrgEntry, formatNoteContent } from "./capture-parser";
import { detectContentType, fetchUrlMetadata } from "./content-detector";

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
    template: z.enum(["todo", "note", "link"]).optional().default("todo"),
    body: z.string().optional(),
  });

  app.post("/api/org-files/capture", async (req, res) => {
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

    const { fileName, title, scheduledDate, tags, template, body } = parsed.data;
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const cleanTags = tags?.filter(Boolean);
    const tagStr = cleanTags && cleanTags.length > 0 ? ` :${cleanTags.join(":")}:` : "";

    let entry: string;
    if (template === "todo") {
      const date = scheduledDate || new Date().toISOString().split("T")[0];
      entry = `\n** TODO ${title}${tagStr}\n   SCHEDULED: <${date}>`;
    } else {
      entry = `\n** ${title}${tagStr}`;
    }

    if (body) {
      const indentedBody = body.split("\n").map(line => `   ${line}`).join("\n");
      entry += `\n${indentedBody}`;
    }

    entry += "\n";

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

  app.patch("/api/clipboard/:id/pin", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const updated = await storage.togglePinClipboardItem(id);
    if (!updated) return res.status(404).json({ message: "Item not found" });
    res.json(updated);
  });

  app.get("/api/clipboard/history", async (_req, res) => {
    const items = await storage.getArchivedClipboardItems();
    res.json(items);
  });

  app.post("/api/clipboard/:id/unarchive", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    await storage.unarchiveClipboardItem(id);
    res.status(200).json({ message: "Unarchived" });
  });

  app.patch("/api/clipboard/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { content, detectedType, urlTitle, urlDescription, urlImage, urlDomain } = req.body;
    const data: Record<string, any> = {};
    if (typeof content === "string") data.content = content;
    if (typeof detectedType === "string") data.detectedType = detectedType;
    if (typeof urlTitle === "string") data.urlTitle = urlTitle;
    if (typeof urlDescription === "string") data.urlDescription = urlDescription;
    if (typeof urlImage === "string") data.urlImage = urlImage;
    if (typeof urlDomain === "string") data.urlDomain = urlDomain;
    if (Object.keys(data).length === 0) return res.status(400).json({ message: "No valid fields to update" });
    const updated = await storage.updateClipboardItem(id, data);
    if (!updated) return res.status(404).json({ message: "Clipboard item not found" });
    res.json(updated);
  });

  app.post("/api/clipboard/enrich", async (req, res) => {
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ message: "content required" });

    const detection = detectContentType(content);
    let metadata = null;
    if (detection.url) {
      metadata = await fetchUrlMetadata(detection.url);
    }
    res.json({ detection, metadata });
  });

  app.post("/api/clipboard/smart-capture", async (req, res) => {
    const { content, orgFileName, clipboardId, originalContent } = req.body;
    if (!content || !orgFileName) {
      return res.status(400).json({ message: "content and orgFileName required" });
    }

    const orgFile = await storage.getOrgFileByName(orgFileName);
    if (!orgFile) return res.status(404).json({ message: "Org file not found" });

    const parsed = parseCaptureEntry(content);

    let entry: string;
    if (parsed.type === "task") {
      entry = formatOrgEntry(parsed, originalContent || undefined);
    } else {
      entry = formatNoteContent(parsed.title, originalContent || undefined);
    }

    const inboxRegex = /^\*\s+INBOX/m;
    const inboxMatch = inboxRegex.exec(orgFile.content);
    let newContent: string;
    if (inboxMatch) {
      const afterInbox = orgFile.content.indexOf("\n", inboxMatch.index);
      const insertAt = afterInbox !== -1 ? afterInbox + 1 : orgFile.content.length;
      newContent = orgFile.content.slice(0, insertAt) + entry + orgFile.content.slice(insertAt);
    } else {
      newContent = orgFile.content + `\n* INBOX\n` + entry;
    }

    const updated = await storage.updateOrgFileContent(orgFile.id, newContent);

    if (clipboardId) {
      await storage.archiveClipboardItem(clipboardId);
    }

    res.status(201).json({ file: updated, parsed });
  });

  app.post("/api/clipboard/:id/append-to-org", async (req, res) => {
    const clipId = parseInt(req.params.id, 10);
    const { orgFileName } = req.body;
    if (!orgFileName) return res.status(400).json({ message: "orgFileName required" });

    const clipItem = await storage.getClipboardItem(clipId);
    if (!clipItem) return res.status(404).json({ message: "Clipboard item not found" });

    const orgFile = await storage.getOrgFileByName(orgFileName);
    if (!orgFile) return res.status(404).json({ message: "Org file not found" });

    const parsed = parseCaptureEntry(clipItem.content);

    let entry: string;
    if (parsed.type === "task") {
      entry = formatOrgEntry(parsed);
    } else {
      entry = formatNoteContent(clipItem.content);
    }

    const inboxRegex = /^\*\s+INBOX/m;
    const inboxMatch = inboxRegex.exec(orgFile.content);
    let newContent: string;
    if (inboxMatch) {
      const afterInbox = orgFile.content.indexOf("\n", inboxMatch.index);
      const insertAt = afterInbox !== -1 ? afterInbox + 1 : orgFile.content.length;
      newContent = orgFile.content.slice(0, insertAt) + entry + orgFile.content.slice(insertAt);
    } else {
      newContent = orgFile.content + `\n* INBOX\n` + entry;
    }

    const updated = await storage.updateOrgFileContent(orgFile.id, newContent);
    await storage.archiveClipboardItem(clipId);

    res.json({ file: updated, parsed });
  });

  // ── Org Queries (parsed from file content) ──────────────────

  app.get("/api/org-query/headings", async (req, res) => {
    const q = (req.query.q as string || "").toLowerCase().trim();
    const all = req.query.all === "true";
    const files = await storage.getOrgFiles();
    const allHeadings = files.flatMap(f => parseOrgFile(f.content, f.name));

    let results = allHeadings.map(h => ({
      title: h.title,
      sourceFile: h.sourceFile,
      lineNumber: h.lineNumber,
      level: h.level,
      status: h.status,
      tags: h.tags,
      scheduledDate: h.scheduledDate,
      body: all ? h.body : undefined,
    }));

    if (q) {
      results = results.filter(h => h.title.toLowerCase().includes(q));
      res.json(results.slice(0, 20));
    } else {
      res.json(results);
    }
  });

  app.get("/api/org-query/backlinks", async (_req, res) => {
    const files = await storage.getOrgFiles();
    const allHeadings = files.flatMap(f => parseOrgFile(f.content, f.name));

    const nodes = allHeadings.map(h => ({
      title: h.title,
      sourceFile: h.sourceFile,
      lineNumber: h.lineNumber,
      level: h.level,
      status: h.status,
      tags: h.tags,
      body: h.body,
      backlinks: [] as { title: string; sourceFile: string; lineNumber: number; level: number; context: string }[],
    }));

    for (const node of nodes) {
      for (const other of allHeadings) {
        if (other.sourceFile === node.sourceFile && other.lineNumber === node.lineNumber) continue;
        const fullText = other.body + " " + other.title;
        if (fullText.includes(`[[`) && (
          fullText.includes(`*${node.title}]]`) ||
          fullText.includes(`${node.title}]]`) ||
          fullText.toLowerCase().includes(node.title.toLowerCase())
        )) {
          const contextLine = other.body.split("\n").find(l => l.includes("[[") || l.toLowerCase().includes(node.title.toLowerCase())) || "";
          node.backlinks.push({
            title: other.title,
            sourceFile: other.sourceFile,
            lineNumber: other.lineNumber,
            level: other.level,
            context: contextLine.trim().slice(0, 120),
          });
        }
      }
    }

    const nodesWithLinks = nodes.filter(n => n.backlinks.length > 0 || n.body.includes("[["));
    res.json(nodesWithLinks);
  });

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

  app.post("/api/org-query/reschedule", async (req, res) => {
    const { fileName, lineNumber, newDate } = req.body;
    if (!fileName || !lineNumber || !newDate) {
      return res.status(400).json({ message: "fileName, lineNumber, and newDate required" });
    }
    if (!/^\d{4}-\d{2}-\d{2}(?: \w{3}(?: \d{2}:\d{2})?)?$/.test(newDate)) {
      return res.status(400).json({ message: "Invalid date format" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const { newContent } = rescheduleHeading(file.content, lineNumber, newDate);
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated });
  });

  app.post("/api/org-query/edit-title", async (req, res) => {
    const { fileName, lineNumber, newTitle } = req.body;
    if (!fileName || !lineNumber || !newTitle) {
      return res.status(400).json({ message: "fileName, lineNumber, and newTitle required" });
    }
    const sanitizedTitle = String(newTitle).replace(/[\n\r]/g, " ").trim();
    if (!sanitizedTitle) {
      return res.status(400).json({ message: "Title cannot be empty" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const { newContent } = editHeadingTitle(file.content, lineNumber, sanitizedTitle);
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated });
  });

  app.post("/api/org-query/delete-heading", async (req, res) => {
    const { fileName, lineNumber } = req.body;
    if (!fileName || !lineNumber) {
      return res.status(400).json({ message: "fileName and lineNumber required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const { newContent } = deleteHeading(file.content, lineNumber);
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated });
  });

  app.post("/api/org-query/move-heading", async (req, res) => {
    const { fileName, fromLine, toLine, newLevel } = req.body;
    if (!fileName || !fromLine || toLine === undefined) {
      return res.status(400).json({ message: "fileName, fromLine, and toLine required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const { newContent } = moveHeadingWithinFile(file.content, fromLine, toLine, newLevel);
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated });
  });

  app.post("/api/org-query/move-heading-cross", async (req, res) => {
    const { fromFileName, fromLine, toFileName, toLine, newLevel } = req.body;
    if (!fromFileName || !fromLine || !toFileName) {
      return res.status(400).json({ message: "fromFileName, fromLine, and toFileName required" });
    }

    const fromFile = await storage.getOrgFileByName(fromFileName);
    const toFile = await storage.getOrgFileByName(toFileName);
    if (!fromFile) return res.status(404).json({ message: "Source file not found" });
    if (!toFile) return res.status(404).json({ message: "Target file not found" });

    const extracted = extractHeadingBlock(fromFile.content, fromLine);
    if (!extracted) return res.status(400).json({ message: "No heading at that line" });

    let block = extracted.block;
    const fromLevel = block[0].match(/^(\*+)/)?.[1].length || 1;
    if (newLevel && newLevel !== fromLevel) {
      block = changeHeadingLevel(block, fromLevel, newLevel);
    }

    const fromLines = fromFile.content.split("\n");
    fromLines.splice(extracted.startIdx, extracted.endIdx - extracted.startIdx);
    const newFromContent = fromLines.join("\n");

    const toLines = toFile.content.split("\n");
    const insertIdx = Math.max(0, Math.min((toLine || toLines.length + 1) - 1, toLines.length));
    toLines.splice(insertIdx, 0, ...block);
    const newToContent = toLines.join("\n");

    try {
      await storage.updateOrgFileContent(fromFile.id, newFromContent);
      const updatedTo = await storage.updateOrgFileContent(toFile.id, newToContent);
      res.json({ file: updatedTo });
    } catch (err) {
      await storage.updateOrgFileContent(fromFile.id, fromFile.content);
      await storage.updateOrgFileContent(toFile.id, toFile.content);
      res.status(500).json({ message: "Move failed, changes rolled back" });
    }
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
