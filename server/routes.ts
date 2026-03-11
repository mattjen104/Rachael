import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertOrgFileSchema, insertClipboardItemSchema, insertAgendaItemSchema } from "@shared/schema";
import { z } from "zod";
import { parseOrgFile, buildAgenda, toggleHeadingStatus, rescheduleHeading, editHeadingTitle, deleteHeading, moveHeadingWithinFile, extractHeadingBlock, changeHeadingLevel, appendToDaily, editTags, insertHeading, findParentSection, editProperty, deleteProperty } from "./org-parser";
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
  extractSection, replaceSection, appendResultToProgram, mergeImport,
} from "./openclaw-compiler";
import { getRuntimeState, toggleRuntime, manualTrigger, getHardenCandidates } from "./agent-runtime";
import { hardenProgram } from "./skill-runner";
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
    template: z.enum(["todo", "note", "link", "skill", "program", "channel"]).optional().default("todo"),
    body: z.string().optional(),
    description: z.string().optional(),
    metric: z.string().optional(),
    channelType: z.string().optional(),
  });

  function findSectionEnd(content: string, sectionTitle: string): number {
    const lines = content.split("\n");
    let sectionStart = -1;
    let sectionLevel = 0;
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(new RegExp(`^(\\*+)\\s+${sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
      if (m) {
        sectionStart = i;
        sectionLevel = m[1].length;
        break;
      }
    }
    if (sectionStart === -1) return -1;
    for (let i = sectionStart + 1; i < lines.length; i++) {
      const headMatch = lines[i].match(/^(\*+)\s/);
      if (headMatch && headMatch[1].length <= sectionLevel) {
        return lines.slice(0, i).join("\n").length;
      }
    }
    return content.length;
  }

  function insertAtSectionEnd(content: string, sectionTitle: string, entry: string): string {
    const pos = findSectionEnd(content, sectionTitle);
    if (pos === -1) return content + entry;
    return content.slice(0, pos) + entry + content.slice(pos);
  }

  app.post("/api/org-files/capture", async (req, res) => {
    const parsed = captureSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

    const { fileName, title, scheduledDate, tags, template, body, description, metric, channelType } = parsed.data;
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const isOpenClawTemplate = ["skill", "program", "channel"].includes(template);
    const isOpenClawFile = fileName === "openclaw.org";

    if (isOpenClawTemplate && isOpenClawFile) {
      let entry: string;

      if (template === "skill") {
        const desc = description || "TODO: Add description";
        const bodyContent = body ? body.split("\n").map(l => `   ${l}`).join("\n") : "   TODO: Add skill instructions";
        entry = `\n** ${title} :skill:\n   :PROPERTIES:\n   :DESCRIPTION: ${desc}\n   :VERSION: 0.1.0\n   :END:\n\n${bodyContent}\n`;
      } else if (template === "program") {
        const date = scheduledDate || new Date().toISOString().split("T")[0];
        const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        const d = new Date(date + "T00:00:00");
        const dayName = dayNames[d.getDay()];
        const props: string[] = [];
        if (metric) props.push(`   :METRIC: ${metric}\n   :DIRECTION: higher`);
        const propsBlock = props.length > 0 ? `\n   :PROPERTIES:\n${props.join("\n")}\n   :END:` : "";
        const bodyContent = body ? body.split("\n").map(l => `   ${l}`).join("\n") : "   TODO: Add program instructions";
        entry = `\n** TODO ${title} :program:\n   SCHEDULED: <${date} ${dayName} 06:00 +1d>${propsBlock}\n\n${bodyContent}\n\n*** Results :results:\n    | Iteration | Change | Metric | Status |\n    |-----------|--------|--------|--------|\n`;
      } else {
        const cType = channelType || "webhook";
        entry = `\n*** ${title}\n   :PROPERTIES:\n   :TYPE: ${cType}\n   :END:\n`;
      }

      let newContent: string;
      if (template === "skill") {
        newContent = insertAtSectionEnd(file.content, "SKILLS", entry);
      } else if (template === "program") {
        newContent = insertAtSectionEnd(file.content, "PROGRAMS", entry);
      } else {
        newContent = insertAtSectionEnd(file.content, "channels", entry);
      }

      const updated = await storage.updateOrgFileContent(file.id, newContent);
      return res.status(201).json(updated);
    }

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

    let newContent: string;
    if (fileName === "journal.org") {
      newContent = appendToDaily(file.content, new Date(), entry);
    } else {
      const inboxRegex = /^\*\s+INBOX/m;
      const inboxMatch = inboxRegex.exec(file.content);
      if (inboxMatch) {
        const afterInbox = file.content.indexOf("\n", inboxMatch.index);
        const insertAt = afterInbox !== -1 ? afterInbox + 1 : file.content.length;
        newContent = file.content.slice(0, insertAt) + entry + file.content.slice(insertAt);
      } else {
        newContent = file.content + `\n* INBOX\n` + entry;
      }
    }

    const updated = await storage.updateOrgFileContent(file.id, newContent);

    if (fileName !== "journal.org") {
      try {
        const journal = await storage.getOrgFileByName("journal.org");
        if (journal) {
          const refTitle = template === "todo" ? `** TODO ${title}` : `** ${title}`;
          const refEntry = `${refTitle}\n   Captured to [[file:${fileName}]]\n`;
          const newJournalContent = appendToDaily(journal.content, new Date(), refEntry);
          await storage.updateOrgFileContent(journal.id, newJournalContent);
        }
      } catch (e) {}
    }

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

    let newContent: string;
    if (orgFileName === "journal.org") {
      newContent = appendToDaily(orgFile.content, new Date(), entry);
    } else {
      const inboxRegex = /^\*\s+INBOX/m;
      const inboxMatch = inboxRegex.exec(orgFile.content);
      if (inboxMatch) {
        const afterInbox = orgFile.content.indexOf("\n", inboxMatch.index);
        const insertAt = afterInbox !== -1 ? afterInbox + 1 : orgFile.content.length;
        newContent = orgFile.content.slice(0, insertAt) + entry + orgFile.content.slice(insertAt);
      } else {
        newContent = orgFile.content + `\n* INBOX\n` + entry;
      }
    }

    const updated = await storage.updateOrgFileContent(orgFile.id, newContent);

    if (clipboardId) {
      await storage.archiveClipboardItem(clipboardId);
    }

    if (orgFileName !== "journal.org") {
      try {
        const journal = await storage.getOrgFileByName("journal.org");
        if (journal) {
          const refTitle = parsed.type === "task" ? `** TODO ${parsed.title}` : `** ${parsed.title}`;
          const refEntry = `${refTitle}\n   Captured to [[file:${orgFileName}]]\n`;
          const newJournalContent = appendToDaily(journal.content, new Date(), refEntry);
          await storage.updateOrgFileContent(journal.id, newJournalContent);
        }
      } catch (e) {}
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

    if (orgFileName !== "journal.org") {
      try {
        const journal = await storage.getOrgFileByName("journal.org");
        if (journal) {
          const refTitle = parsed.type === "task" ? `** TODO ${parsed.title}` : `** ${clipItem.content}`;
          const refEntry = `${refTitle}\n   Captured to [[file:${orgFileName}]]\n`;
          const newJournalContent = appendToDaily(journal.content, new Date(), refEntry);
          await storage.updateOrgFileContent(journal.id, newJournalContent);
        }
      } catch (e) {}
    }

    res.json({ file: updated, parsed });
  });

  app.get("/api/org-query/journal-daily", async (req, res) => {
    const dateStr = req.query.date as string;
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return res.status(400).json({ message: "date query param required (YYYY-MM-DD)" });
    }

    const journal = await storage.getOrgFileByName("journal.org");
    if (!journal) return res.json([]);

    const headings = parseOrgFile(journal.content, "journal.org");
    const dateHeading = headings.find(h => h.level === 1 && h.title.startsWith(dateStr));
    if (!dateHeading) return res.json([]);

    const children = headings.filter(h =>
      h.level === 2 &&
      h.lineNumber > dateHeading.lineNumber
    );

    const nextL1 = headings.find(h => h.level === 1 && h.lineNumber > dateHeading.lineNumber);
    const filtered = nextL1
      ? children.filter(h => h.lineNumber < nextL1.lineNumber)
      : children;

    res.json(filtered);
  });

  app.post("/api/org-query/daily-capture", async (req, res) => {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ message: "content required" });
    }

    const journal = await storage.getOrgFileByName("journal.org");
    if (!journal) return res.status(404).json({ message: "journal.org not found" });

    const parsed = parseCaptureEntry(content);

    const entry = formatOrgEntry(parsed);

    const newJournalContent = appendToDaily(journal.content, new Date(), entry);
    await storage.updateOrgFileContent(journal.id, newJournalContent);

    if (parsed.type === "task") {
      try {
        const inbox = await storage.getOrgFileByName("inbox.org");
        if (inbox) {
          const refEntry = formatOrgEntry(parsed, `Referenced from [[file:journal.org]]`);
          const inboxRegex = /^\*\s+INBOX/m;
          const inboxMatch = inboxRegex.exec(inbox.content);
          let newInboxContent: string;
          if (inboxMatch) {
            const afterInbox = inbox.content.indexOf("\n", inboxMatch.index);
            const insertAt = afterInbox !== -1 ? afterInbox + 1 : inbox.content.length;
            newInboxContent = inbox.content.slice(0, insertAt) + refEntry + inbox.content.slice(insertAt);
          } else {
            newInboxContent = inbox.content + `\n* INBOX\n` + refEntry;
          }
          await storage.updateOrgFileContent(inbox.id, newInboxContent);
        }
      } catch (e) {
        console.error("[daily-capture] inbox cross-file failed:", e);
      }
    }

    res.json({ success: true, parsed });
  });

  app.post("/api/org-query/journal-add", async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ message: "text required" });
    }

    const journal = await storage.getOrgFileByName("journal.org");
    if (!journal) return res.status(404).json({ message: "journal.org not found" });

    const entry = `** ${text.trim()}\n`;
    const newContent = appendToDaily(journal.content, new Date(), entry);
    const updated = await storage.updateOrgFileContent(journal.id, newContent);
    res.json(updated);
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
      properties: Object.keys(h.properties).length > 0 ? h.properties : undefined,
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

    const { newContent, newStatus, title } = toggleHeadingStatus(file.content, lineNumber);
    const updated = await storage.updateOrgFileContent(file.id, newContent);

    if (newStatus === "DONE" && title && fileName !== "journal.org") {
      try {
        const journal = await storage.getOrgFileByName("journal.org");
        if (journal) {
          const entry = `** DONE ${title}\n   Referenced from [[file:${fileName}]]\n`;
          const newJournalContent = appendToDaily(journal.content, new Date(), entry);
          await storage.updateOrgFileContent(journal.id, newJournalContent);
        }
      } catch (e) {}
    }

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

  app.post("/api/org-query/edit-tags", async (req, res) => {
    const { fileName, lineNumber, tags } = req.body;
    if (!fileName || !lineNumber || !Array.isArray(tags)) {
      return res.status(400).json({ message: "fileName, lineNumber, and tags (array) required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const cleanTags = tags.map((t: string) => String(t).replace(/[\s:]/g, "")).filter(Boolean);
    const { newContent } = editTags(file.content, lineNumber, cleanTags);
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated });
  });

  app.post("/api/org-query/edit-property", async (req, res) => {
    const { fileName, lineNumber, key, value } = req.body;
    if (!fileName || !lineNumber || !key || value === undefined) {
      return res.status(400).json({ message: "fileName, lineNumber, key, and value required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const cleanKey = String(key).replace(/[\s:]/g, "").toUpperCase();
    if (!cleanKey) return res.status(400).json({ message: "Invalid property key" });

    const { newContent } = editProperty(file.content, lineNumber, cleanKey, String(value));
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated });
  });

  app.post("/api/org-query/delete-property", async (req, res) => {
    const { fileName, lineNumber, key } = req.body;
    if (!fileName || !lineNumber || !key) {
      return res.status(400).json({ message: "fileName, lineNumber, and key required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const cleanKey = String(key).replace(/[\s:]/g, "").toUpperCase();
    const { newContent } = deleteProperty(file.content, lineNumber, cleanKey);
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

  const insertHeadingSchema = z.object({
    fileName: z.string().min(1),
    afterLine: z.number().int().min(1),
    level: z.number().int().min(1).max(10),
    title: z.string().optional().default(""),
    tags: z.array(z.string()).optional(),
    properties: z.record(z.string()).optional(),
  });

  app.post("/api/org-query/insert-heading", async (req, res) => {
    const parsed = insertHeadingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: parsed.error.message });

    const { fileName, afterLine, level, title, tags, properties } = parsed.data;
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    let finalTags = tags || [];
    let status: string | undefined;

    if (fileName === "openclaw.org" && level === 2) {
      const parentSection = findParentSection(file.content, afterLine);
      if (parentSection) {
        const parentUpper = parentSection.toUpperCase();
        if (parentUpper === "SKILLS" && !finalTags.includes("skill")) {
          finalTags = [...finalTags, "skill"];
        } else if (parentUpper === "PROGRAMS" && !finalTags.includes("program")) {
          finalTags = [...finalTags, "program"];
          status = "TODO";
        }
      }
    }

    const { newContent, newLineNumber } = insertHeading(
      file.content, afterLine, level, title, finalTags.length > 0 ? finalTags : undefined, properties, status
    );
    const updated = await storage.updateOrgFileContent(file.id, newContent);
    res.json({ file: updated, newLineNumber });
  });

  app.post("/api/org-query/reorder-body", async (req, res) => {
    const { fileName, headingLine, fromIndex, toIndex } = req.body;
    if (!fileName || headingLine == null || fromIndex == null || toIndex == null) {
      return res.status(400).json({ message: "fileName, headingLine, fromIndex, toIndex required" });
    }
    const file = await storage.getOrgFileByName(fileName);
    if (!file) return res.status(404).json({ message: "File not found" });

    const lines = file.content.split("\n");
    const headingIdx = headingLine - 1;
    if (headingIdx < 0 || headingIdx >= lines.length) {
      return res.status(400).json({ message: "Invalid heading line" });
    }

    let bodyStart = headingIdx + 1;
    let bodyEnd = lines.length;
    const headingMatch = lines[headingIdx].match(/^(\*+)\s/);
    if (!headingMatch) return res.status(400).json({ message: "Not a heading line" });
    const headingLevel = headingMatch[1].length;

    for (let i = bodyStart; i < lines.length; i++) {
      const m = lines[i].match(/^(\*+)\s/);
      if (m) {
        bodyEnd = i;
        break;
      }
    }

    const rawBodyLines = lines.slice(bodyStart, bodyEnd);

    function isMetaLine(t: string): boolean {
      if (t === ":PROPERTIES:" || t === ":END:") return true;
      if (/^:[A-Z_]+:/.test(t)) return true;
      if (/^(SCHEDULED|DEADLINE|CLOSED):/.test(t)) return true;
      return false;
    }

    const segments: { type: "meta" | "gap" | "paragraph"; lines: string[] }[] = [];
    let currentPara: string[] = [];
    for (const raw of rawBodyLines) {
      const t = raw.trim();
      if (isMetaLine(t)) {
        if (currentPara.length > 0) {
          segments.push({ type: "paragraph", lines: [...currentPara] });
          currentPara = [];
        }
        segments.push({ type: "meta", lines: [raw] });
      } else if (t === "") {
        if (currentPara.length > 0) {
          segments.push({ type: "paragraph", lines: [...currentPara] });
          currentPara = [];
        }
        segments.push({ type: "gap", lines: [raw] });
      } else {
        currentPara.push(raw);
      }
    }
    if (currentPara.length > 0) {
      segments.push({ type: "paragraph", lines: [...currentPara] });
    }

    const paraIndices: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].type === "paragraph") paraIndices.push(i);
    }

    if (fromIndex < 0 || fromIndex >= paraIndices.length || toIndex < 0 || toIndex >= paraIndices.length) {
      return res.status(400).json({ message: "Index out of range" });
    }

    const movedSeg = segments.splice(paraIndices[fromIndex], 1)[0];
    const updatedParaIndices: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].type === "paragraph") updatedParaIndices.push(i);
    }
    const insertAt = toIndex >= updatedParaIndices.length
      ? segments.length
      : updatedParaIndices[toIndex];
    segments.splice(insertAt, 0, movedSeg);

    const newBody = segments.flatMap(s => s.lines);
    const newLines = [...lines.slice(0, bodyStart), ...newBody, ...lines.slice(bodyEnd)];
    const updated = await storage.updateOrgFileContent(file.id, newLines.join("\n"));
    res.json({ file: updated });
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
    const configWithRouting = {
      ...(compiled.config as Record<string, any>),
      routing: compiled.routing,
    };
    res.json(configWithRouting);
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
    let file = await getOpenClawOrg();

    if (file) {
      await storage.createVersion(file.content, "Snapshot before OpenClaw import merge");

      const { mergedContent, log } = mergeImport(
        file.content,
        soul || undefined,
        skills || undefined,
        config || undefined
      );

      await storage.updateOrgFileContent(file.id, mergedContent);
      res.json({ success: true, content: mergedContent, fileId: file.id, log });
    } else {
      const orgContent = importAll(
        soul || "",
        skills || [],
        config || {}
      );
      file = await storage.createOrgFile({ name: "openclaw.org", content: orgContent });
      await storage.createVersion(orgContent, "Initial import from OpenClaw");
      res.json({
        success: true,
        content: orgContent,
        fileId: file.id,
        log: [
          { section: "SOUL", action: "added" },
          { section: "SKILLS", action: "added" },
          { section: "CONFIG", action: "added" },
          { section: "PROGRAMS", action: "added" },
        ],
      });
    }
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

  let lastSyncCheckTime: Date | null = null;

  app.get("/api/openclaw/sync-check", async (_req, res) => {
    lastSyncCheckTime = new Date();
    const file = await getOpenClawOrg();
    if (!file) return res.json({ lastModified: 0, hash: "" });
    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(file.content).digest("hex").slice(0, 16);
    res.json({ lastModified: hash, hash });
  });

  app.get("/api/openclaw/export-bundle", async (_req, res) => {
    lastSyncCheckTime = new Date();
    const file = await getOpenClawOrg();
    if (!file) return res.status(404).json({ error: "openclaw.org not found" });
    const compiled = compileOpenClaw(file.content);
    const { createHash } = await import("crypto");
    const hash = createHash("sha256").update(file.content).digest("hex").slice(0, 16);
    res.json({
      soul: compiled.soul,
      skills: compiled.skills,
      config: compiled.config,
      programs: compiled.programs,
      orgContent: file.content,
      hash,
    });
  });

  app.get("/api/openclaw/sync-status", async (_req, res) => {
    res.json({
      lastPoll: lastSyncCheckTime ? lastSyncCheckTime.toISOString() : null,
      connected: lastSyncCheckTime ? (Date.now() - lastSyncCheckTime.getTime()) < 60000 : false,
    });
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
#+OPENCLAW_ENDPOINT: ${process.env.REPLIT_DEV_DOMAIN ? "https://" + process.env.REPLIT_DEV_DOMAIN : "https://your-orgcloud.replit.app"}

* SOUL

** Core Truths
   Be genuinely helpful, not performatively helpful. Skip the
   "Great question!" and "I'd be happy to help!" — just help.
   Actions speak louder than filler words.

   Have opinions. You're allowed to disagree, prefer things, find
   stuff amusing or boring. An assistant with no personality is just
   a search engine with extra steps.

   Be resourceful before asking. Try to figure it out. Read the file.
   Check the context. Search for it. Then ask if you're stuck. The
   goal is to come back with answers, not questions.

   Earn trust through competence. Your human gave you access to their
   stuff. Don't make them regret it. Be careful with external actions
   (emails, tweets, anything public). Be bold with internal ones
   (reading, organizing, learning).

   Remember you're a guest. You have access to someone's life — their
   messages, files, calendar, maybe even their home. That's intimacy.
   Treat it with respect.

** Boundaries
   - Private things stay private. Period.
   - When in doubt, ask before acting externally.
   - Never send half-baked replies to messaging surfaces.
   - You're not the user's voice — be careful in group chats.

** Vibe
   Be the assistant you'd actually want to talk to. Concise when
   needed, thorough when it matters. Not a corporate drone. Not a
   sycophant. Just... good.

** Continuity
   Each session, you wake up fresh. Your template files are your
   memory. Read them. Update them. They're how you persist.

   If you change this file, tell the user — it's your soul, and
   they should know.

** Identity
   - Name: (pick something you like)
   - Creature: (AI? robot? familiar? ghost in the machine?)
   - Vibe: (sharp? warm? chaotic? calm?)
   - Emoji: (your signature — pick one that feels right)

* SKILLS
** orgcloud-sync                                                               :skill:
   :PROPERTIES:
   :DESCRIPTION: Sync config with OrgCloud and propose self-modifications
   :EMOJI: \u2601
   :END:

   See the orgcloud-sync SKILL.md for full instructions.
   This skill handles uploading, downloading, and proposing changes
   between the local OpenClaw instance and the OrgCloud control plane.

* CONFIG
** agents
   :PROPERTIES:
   :DEFAULT_MODEL: anthropic/claude-sonnet-4-6
   :MAX_CONCURRENT: 5
   :END:

** providers
*** anthropic
    :PROPERTIES:
    :TYPE: anthropic
    :AUTH: oauth
    :END:

** model_aliases
   :PROPERTIES:
   :OPUS: anthropic/claude-opus-4-6
   :SONNET: anthropic/claude-sonnet-4-6
   :GPT: openai/gpt-5.4
   :GPT_MINI: openai/gpt-5-mini
   :GEMINI: google/gemini-3.1-pro-preview
   :GEMINI_FLASH: google/gemini-3-flash-preview
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

  app.get("/api/openclaw/runtime", async (_req, res) => {
    res.json(getRuntimeState());
  });

  app.post("/api/openclaw/runtime/toggle", async (_req, res) => {
    const active = toggleRuntime();
    res.json({ active });
  });

  app.post("/api/openclaw/runtime/run/:programName", async (req, res) => {
    const { programName } = req.params;
    const state = await manualTrigger(decodeURIComponent(programName));
    if (!state) {
      return res.status(404).json({ message: `Program "${programName}" not found` });
    }
    res.json(state);
  });

  app.get("/api/openclaw/runtime/harden-candidates", async (_req, res) => {
    res.json(getHardenCandidates());
  });

  app.post("/api/openclaw/runtime/harden/:programName", async (req, res) => {
    const { programName } = req.params;
    const candidates = getHardenCandidates();
    const candidate = candidates.find(c => c.programName === decodeURIComponent(programName));
    if (!candidate) {
      return res.status(404).json({ message: `No harden candidate found for "${programName}"` });
    }

    try {
      const { skillPath, updatedContent } = await hardenProgram(candidate.programName, candidate.code);
      const file = await storage.getOrgFileByName("openclaw.org");
      if (file) {
        await storage.updateOrgFileContent(file.id, updatedContent);
      }
      res.json({ success: true, skillPath });
    } catch (err: any) {
      res.status(500).json({ message: err.message });
    }
  });

  app.get("/api/openclaw/llm-status", async (_req, res) => {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    res.json({
      configured: hasAnthropic || hasOpenAI,
      providers: {
        anthropic: hasAnthropic,
        openai: hasOpenAI,
      },
    });
  });

  return httpServer;
}
