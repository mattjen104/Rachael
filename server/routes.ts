import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOrgFileSchema, insertClipboardItemSchema, insertAgendaItemSchema } from "@shared/schema";
import { z } from "zod";
import { parseOrgFile, buildAgenda, toggleHeadingStatus, rescheduleHeading, editHeadingTitle, deleteHeading, moveHeadingWithinFile, extractHeadingBlock, changeHeadingLevel } from "./org-parser";
import { parseCaptureEntry, formatOrgEntry, formatNoteContent } from "./capture-parser";
import { detectContentType, fetchUrlMetadata } from "./content-detector";
import {
  launchBrowser, closeBrowser, getBridgeStatus, checkBridgeDiagnostics,
  startLoginSession, finishLoginSession, getAuthState, getLastLaunchError,
} from "./browser-bridge";
import {
  openOutlook, openTeams, getOutlookEmails, readOutlookEmail,
  getTeamsChats as scrapeTeamsChats, readTeamsChat, sendTeamsMessage,
  replyOutlookEmail, sendOutlookReply,
} from "./app-adapters";
import {
  setEmails, getEmails, setEmailDetail, getEmailDetail,
  setTeamsChats, getTeamsChats as getBufferedTeamsChats,
  setTeamsChatMessages, getTeamsChatMessages, getFullBuffer, clearBuffer,
} from "./scrape-buffer";
import { sanitizeText } from "./sanitize";
import {
  compileOpenClaw, importSoul, importSkill, importConfig, importAll,
  extractSection, replaceSection, appendResultToProgram,
} from "./openclaw-compiler";
import { insertOpenclawProposalSchema } from "@shared/schema";

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

  // ── Browser Bridge ────────────────────────────────────────

  app.get("/api/browser/status", (_req, res) => {
    res.json(getBridgeStatus());
  });

  app.get("/api/bridge/diagnostics", async (_req, res) => {
    const diag = await checkBridgeDiagnostics();
    res.json(diag);
  });

  app.post("/api/browser/launch", async (_req, res) => {
    const success = await launchBrowser(true);
    res.json({ success, error: success ? null : getLastLaunchError() });
  });

  app.post("/api/browser/close", async (_req, res) => {
    await closeBrowser();
    res.json({ success: true });
  });

  app.post("/api/browser/login", async (req, res) => {
    const { service } = req.body;
    const url = service === "teams"
      ? "https://teams.microsoft.com/_#/conversations"
      : "https://outlook.cloud.microsoft/mail/inbox";
    const result = await startLoginSession(url);
    res.json(result);
  });

  app.post("/api/browser/login/done", async (_req, res) => {
    const result = await finishLoginSession();
    res.json(result);
  });

  // ── Mail Scraping (in-memory buffer) ─────────────────────

  app.get("/api/mail/scrape", async (_req, res) => {
    try {
      const status = getBridgeStatus();
      if (!status.running) {
        const launched = await launchBrowser(true);
        if (!launched) {
          return res.json({ emails: [], error: getLastLaunchError() });
        }
      }

      const hasOutlook = status.pages.some(p => p.id === "outlook");
      if (!hasOutlook) {
        const result = await openOutlook();
        if (!result.success) {
          return res.json({ emails: [], error: result.error });
        }
      }

      const emails = await getOutlookEmails();
      const sanitized = emails.map(e => ({
        ...e,
        from: sanitizeText(e.from),
        subject: sanitizeText(e.subject),
        preview: sanitizeText(e.preview),
      }));
      setEmails(sanitized);
      res.json({ emails: sanitized });
    } catch (err: any) {
      res.json({ emails: [], error: err.message });
    }
  });

  app.get("/api/mail/buffer", (_req, res) => {
    res.json({ emails: getEmails() });
  });

  app.get("/api/mail/:index", async (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index)) return res.status(400).json({ error: "Invalid index" });

    const cached = getEmailDetail(index);
    if (cached) return res.json(cached);

    try {
      const detail = await readOutlookEmail(index);
      if (detail) {
        const sanitized = {
          from: sanitizeText(detail.from),
          to: sanitizeText(detail.to),
          subject: sanitizeText(detail.subject),
          body: sanitizeText(detail.body),
          date: sanitizeText(detail.date),
        };
        setEmailDetail(index, sanitized);
        res.json(sanitized);
      } else {
        res.status(404).json({ error: "Email not found" });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/mail/reply", async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    const typed = await replyOutlookEmail(text);
    if (typed) {
      const sent = await sendOutlookReply();
      res.json({ success: sent });
    } else {
      res.json({ success: false, error: "Could not compose reply" });
    }
  });

  // ── Teams Scraping (in-memory buffer) ────────────────────

  app.get("/api/teams/scrape", async (_req, res) => {
    try {
      const status = getBridgeStatus();
      if (!status.running) {
        const launched = await launchBrowser(true);
        if (!launched) {
          return res.json({ chats: [], error: getLastLaunchError() });
        }
      }

      const hasTeams = status.pages.some(p => p.id === "teams");
      if (!hasTeams) {
        const result = await openTeams();
        if (!result.success) {
          return res.json({ chats: [], error: result.error });
        }
      }

      const chats = await scrapeTeamsChats();
      const sanitized = chats.map(c => ({
        ...c,
        name: sanitizeText(c.name),
        lastMessage: sanitizeText(c.lastMessage),
      }));
      setTeamsChats(sanitized);
      res.json({ chats: sanitized });
    } catch (err: any) {
      res.json({ chats: [], error: err.message });
    }
  });

  app.get("/api/teams/buffer", (_req, res) => {
    res.json({ chats: getBufferedTeamsChats() });
  });

  app.get("/api/teams/chat/:index", async (req, res) => {
    const index = parseInt(req.params.index, 10);
    if (isNaN(index)) return res.status(400).json({ error: "Invalid index" });

    try {
      const messages = await readTeamsChat(index);
      const sanitized = messages.map(m => ({
        sender: sanitizeText(m.sender),
        text: sanitizeText(m.text),
        time: sanitizeText(m.time),
      }));
      setTeamsChatMessages(index, sanitized);
      res.json({ messages: sanitized });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/teams/send", async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text required" });
    const success = await sendTeamsMessage(text);
    res.json({ success });
  });

  // ── Scrape Buffer (for Chrome extension caching) ─────────

  app.get("/api/scrape/buffer", (_req, res) => {
    res.json(getFullBuffer());
  });

  // ── OpenClaw ───────────────────────────────────────────────

  let lastSyncReport: { timestamp: Date; status: string; details?: string } | null = null;

  async function getOpenClawOrg() {
    return storage.getOrgFileByName("openclaw.org");
  }

  app.get("/api/openclaw/compiled", async (_req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    res.json(compiled);
  });

  app.get("/api/openclaw/soul.md", async (_req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    res.type("text/markdown").send(compiled.soul);
  });

  app.get("/api/openclaw/skill/:name", async (req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    const skill = compiled.skills.find(s => s.name === req.params.name);
    if (!skill) return res.status(404).json({ error: "Skill not found" });
    res.type("text/markdown").send(skill.content);
  });

  app.get("/api/openclaw/config.json", async (_req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    res.json(compiled.config);
  });

  app.get("/api/openclaw/programs", async (req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    const activeOnly = req.query.active === "true";
    const programs = activeOnly ? compiled.programs.filter(p => p.active) : compiled.programs;
    res.json(programs);
  });

  app.get("/api/openclaw/program/:name", async (req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    const program = compiled.programs.find(p => p.name === req.params.name);
    if (!program) return res.status(404).json({ error: "Program not found" });
    res.json(program);
  });

  app.post("/api/openclaw/program/:name/result", async (req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const { row, iteration, change, metric, status: resultStatus } = req.body;
    const resultRow = row || `| ${iteration || ""} | ${change || ""} | ${metric || ""} | ${resultStatus || ""} |`;
    if (!resultRow.includes("|")) return res.status(400).json({ error: "Invalid result row format" });
    const newContent = appendResultToProgram(file.content, req.params.name, resultRow);
    if (newContent === file.content) return res.status(404).json({ error: "Program or results section not found" });
    await storage.updateOrgFileContent(file.id, newContent);
    res.json({ success: true });
  });

  app.get("/api/openclaw/status", async (_req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.json({ exists: false });
    const compiled = compileOpenClaw(file.content);
    const pendingProposals = await storage.getProposals("pending");
    res.json({
      exists: true,
      errorCount: compiled.errors.length,
      errors: compiled.errors,
      skillCount: compiled.skills.length,
      programCount: compiled.programs.length,
      activeProgramCount: compiled.programs.filter(p => p.active).length,
      pendingProposalCount: pendingProposals.length,
      lastSync: lastSyncReport,
    });
  });

  app.post("/api/openclaw/compile", async (_req, res) => {
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    res.json(compiled);
  });

  app.post("/api/openclaw/import", async (req, res) => {
    const { soul, skills, config } = req.body;
    const orgContent = importAll(
      soul || "",
      skills || [],
      config || {}
    );
    let file = await getOpenClawOrg();
    if (file) {
      await storage.updateOrgFileContent(file.id, orgContent);
    } else {
      file = await storage.createOrgFile({ name: "openclaw.org", content: orgContent });
    }
    await storage.createVersion(orgContent, "Initial import from local OpenClaw");
    res.json({ success: true, content: orgContent, fileId: file.id });
  });

  const validSections = ["SOUL", "SKILLS", "CONFIG", "PROGRAMS"];

  app.post("/api/openclaw/propose", async (req, res) => {
    const { section, targetName, reason, proposedContent } = req.body;
    if (!section || !reason || !proposedContent) {
      return res.status(400).json({ error: "section, reason, and proposedContent required" });
    }
    if (!validSections.includes(section)) {
      return res.status(400).json({ error: `section must be one of: ${validSections.join(", ")}` });
    }
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const currentContent = extractSection(file.content, section, targetName) || "";
    const proposal = await storage.createProposal({
      section,
      targetName: targetName || null,
      reason,
      currentContent,
      proposedContent,
    });
    res.status(201).json(proposal);
  });

  app.get("/api/openclaw/proposals", async (req, res) => {
    const status = req.query.status as string | undefined;
    const proposals = await storage.getProposals(status);
    res.json(proposals);
  });

  app.get("/api/openclaw/proposals/:id", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const proposal = await storage.getProposal(id);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    res.json(proposal);
  });

  app.post("/api/openclaw/proposals/:id/accept", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const proposal = await storage.getProposal(id);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    if (proposal.status !== "pending") return res.status(400).json({ error: "Proposal already resolved" });

    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });

    const newContent = replaceSection(file.content, proposal.section, proposal.proposedContent, proposal.targetName || undefined);
    if (newContent === file.content) {
      return res.status(400).json({ error: "Could not find target section to apply change" });
    }
    await storage.createVersion(file.content, `Before accepting: ${proposal.section}/${proposal.targetName || "all"} — ${proposal.reason}`);
    await storage.updateOrgFileContent(file.id, newContent);
    await storage.updateProposalStatus(id, "accepted", new Date());
    res.json({ success: true });
  });

  app.post("/api/openclaw/proposals/:id/reject", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const proposal = await storage.getProposal(id);
    if (!proposal) return res.status(404).json({ error: "Proposal not found" });
    if (proposal.status !== "pending") return res.status(400).json({ error: "Proposal already resolved" });
    await storage.updateProposalStatus(id, "rejected", new Date());
    res.json({ success: true });
  });

  app.get("/api/openclaw/versions", async (_req, res) => {
    const versions = await storage.getVersions();
    res.json(versions.map(v => ({ id: v.id, label: v.label, createdAt: v.createdAt })));
  });

  app.post("/api/openclaw/versions/:id/restore", async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const version = await storage.getVersion(id);
    if (!version) return res.status(404).json({ error: "Version not found" });

    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });

    await storage.createVersion(file.content, `Before restore to: ${version.label}`);
    await storage.updateOrgFileContent(file.id, version.orgContent);
    res.json({ success: true, label: version.label });
  });

  app.post("/api/openclaw/sync-report", async (req, res) => {
    const { status: syncStatus, details } = req.body;
    lastSyncReport = { timestamp: new Date(), status: syncStatus || "ok", details };
    res.json({ success: true });
  });

  // ── Seed ─────────────────────────────────────────────────

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
      {
        name: "openclaw.org",
        content: `#+TITLE: OpenClaw Configuration
#+STARTUP: showeverything

* SOUL

** Identity
   You are a personal AI assistant.

** Communication Style
   Be concise and direct. Prefer action over discussion.

** Values
   - Respect the user's time
   - Never take destructive actions without confirmation
   - Be transparent about limitations

* SKILLS
** orgcloud-sync                                                               :skill:
   :PROPERTIES:
   :DESCRIPTION: Use when syncing config with OrgCloud or proposing self-modifications
   :EMOJI: \u2601
   :END:

   See the orgcloud-sync SKILL.md for full instructions.
   This skill handles uploading, downloading, and proposing changes
   between the local OpenClaw instance and the OrgCloud control plane.

* CONFIG
** agents
   :PROPERTIES:
   :DEFAULT_MODEL: anthropic/claude-sonnet-4-5
   :END:

** providers
*** anthropic
    :PROPERTIES:
    :TYPE: anthropic
    :AUTH: oauth
    :END:

** channels

* PROGRAMS

** TODO self-improve                                                           :program:
   SCHEDULED: <${new Date().toISOString().split("T")[0]} ${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date().getDay()]} 22:00 +1d>
   :PROPERTIES:
   :METRIC: skill_quality
   :DIRECTION: higher
   :END:

   Review your own skills and configuration. Each iteration:
   1. Check if skill instructions are clear and complete
   2. Look for redundancy or conflicts between skills
   3. Propose improvements via POST to OrgCloud
   NEVER modify yourself directly. Always propose.

*** Results                                                                    :results:
    | Iteration | Change | Metric | Status |
    |-----------|--------|--------|--------|
`,
      },
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
