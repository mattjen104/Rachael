import type { Express, Request, Response } from "express";
import { randomBytes, createHash } from "crypto";
import { existsSync, statSync, createReadStream } from "fs";
import { storage } from "./storage";
import { generateEpisode, checkMorningFailure } from "./standup-engine";
import { executeChain } from "./cli-engine";
import type { StandupSegment } from "@shared/schema";

function escapeXml(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * Local-time YYYY-MM-DD key — avoids the off-by-one that
 * `toISOString().slice(0,10)` produces when the host is east of UTC at
 * scheduler times like 5:45 AM local.
 */
function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function publicBaseUrl(req: Request): string {
  const fwdHost = (req.headers["x-forwarded-host"] as string) || req.headers.host || "";
  const fwdProto = (req.headers["x-forwarded-proto"] as string) || (fwdHost.startsWith("localhost") ? "http" : "https");
  const domain = (process.env.REPLIT_DOMAINS || "").split(",")[0].trim();
  if (domain) return `https://${domain}`;
  return fwdHost ? `${fwdProto}://${fwdHost}` : "http://localhost:5000";
}

export function registerStandupRoutes(app: Express): void {
  // ── List & detail ──────────────────────────────────────────────────────────
  app.get("/api/standup/episodes", async (_req: Request, res: Response) => {
    const eps = await storage.listStandupEpisodes(50);
    res.json(eps);
  });

  app.get("/api/standup/episodes/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const ep = await storage.getStandupEpisode(id);
    if (!ep) return res.status(404).json({ message: "Not found" });
    const segments = await storage.listStandupSegments(id);
    res.json({ episode: ep, segments });
  });

  // ── Generate-on-demand ─────────────────────────────────────────────────────
  app.post("/api/standup/generate", async (req: Request, res: Response) => {
    const ALLOWED_KINDS = ["morning", "afternoon", "weekly"] as const;
    type Kind = typeof ALLOWED_KINDS[number];
    const isKind = (v: unknown): v is Kind => typeof v === "string" && (ALLOWED_KINDS as readonly string[]).includes(v);
    const rawKind = req.body?.kind;
    const kind: Kind = isKind(rawKind) ? rawKind : "morning";
    const date = typeof req.body?.date === "string" ? req.body.date : undefined;
    if (rawKind !== undefined && !isKind(rawKind)) {
      return res.status(400).json({ message: "kind must be morning|afternoon|weekly" });
    }
    res.json({ ok: true, message: "queued", kind, date: date || localDateKey(new Date()) });
    setImmediate(async () => {
      try { await generateEpisode({ kind, date, baseUrl: publicBaseUrl(req) }); }
      catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[standup] generate failed:", msg);
      }
    });
  });

  // ── Per-segment feedback ──────────────────────────────────────────────────
  app.post("/api/standup/segments/:id/feedback", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const value = parseInt(String(req.body?.value ?? "0"), 10);
    const updated = await storage.setStandupSegmentFeedback(id, value);
    if (!updated) return res.status(404).json({ message: "Not found" });
    res.json(updated);
  });

  // ── Your-move action loop ────────────────────────────────────────────────
  // Constrained action resolver: only do | snooze | drop are accepted, plus
  // an optional `note` that captures a short text alongside the action.
  // Arbitrary command passthrough is intentionally NOT supported here so the
  // surface stays safe to call from voice and notification action paths.
  app.post("/api/standup/your-move", async (req: Request, res: Response) => {
    const ALLOWED = new Set(["do", "snooze", "drop", "note"]);
    const action = String(req.body?.action || "").toLowerCase().trim();
    const segmentId = req.body?.segmentId !== undefined ? parseInt(String(req.body.segmentId), 10) : null;
    const noteText = String(req.body?.note || "").trim().slice(0, 500);
    const source = String(req.body?.source || "your-move").slice(0, 32);

    if (!ALLOWED.has(action)) {
      return res.status(400).json({ message: "action must be one of: do | snooze | drop | note" });
    }

    try {
      const result = await resolveYourMove({
        action: action as "do" | "snooze" | "drop" | "note",
        segmentId: segmentId !== null && !isNaN(segmentId) ? segmentId : null,
        note: noteText,
        snoozeDate: typeof req.body?.snoozeDate === "string" ? req.body.snoozeDate : undefined,
      });
      res.json({ ok: true, action, segmentId, source, ...result });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(500).json({ ok: false, message: msg });
    }
  });

  // ── Authenticated in-app audio mirror (no token needed; uses session auth) ─
  app.get("/api/standup/episodes/:id/audio.mp3", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const ep = await storage.getStandupEpisode(id);
    if (!ep || !ep.audioPath || !existsSync(ep.audioPath)) return res.status(404).send("not found");
    streamAudioWithRange(req, res, ep.audioPath);
  });

  // ── Loud-failure trigger (for cron / manual ping) ────────────────────────
  app.post("/api/standup/check-morning", async (_req: Request, res: Response) => {
    const r = await checkMorningFailure();
    res.json(r);
  });

  // ── Feed tokens (so RSS/audio stays unauth-able for podcast apps) ────────
  app.get("/api/standup/feed-tokens", async (_req: Request, res: Response) => {
    const tokens = await storage.listStandupFeedTokens();
    res.json(tokens);
  });
  app.post("/api/standup/feed-tokens", async (req: Request, res: Response) => {
    const label = String(req.body?.label || "default").slice(0, 64);
    const token = randomBytes(18).toString("base64url");
    const created = await storage.createStandupFeedToken({ token, label });
    res.json(created);
  });
  app.delete("/api/standup/feed-tokens/:token", async (req: Request, res: Response) => {
    await storage.deleteStandupFeedToken(req.params.token);
    res.json({ ok: true });
  });

  // ── RSS feed: token-gated, served outside /api so auth middleware skips ──
  app.get("/feed/standup.xml", async (req: Request, res: Response) => {
    const token = String(req.query.token || "");
    if (!token) return res.status(401).send("token required");
    const t = await storage.getStandupFeedToken(token);
    if (!t) return res.status(401).send("invalid token");
    await storage.touchStandupFeedToken(token);

    const eps = (await storage.listStandupEpisodes(50)).filter(e => e.status === "ready" && e.audioPath);
    const base = publicBaseUrl(req);
    const items = eps.map(e => {
      const guid = `standup-${e.slug}`;
      const pub = new Date(e.createdAt).toUTCString();
      // Always serve via token-gated audio mirror so the feed stays private.
      const audio = `${base}/feed/audio/${encodeURIComponent(token)}/${encodeURIComponent(e.slug)}.mp3`;
      const len = e.sizeBytes || 0;
      return `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml(e.summary || e.title)}</description>
      <pubDate>${pub}</pubDate>
      <guid isPermaLink="false">${guid}</guid>
      <enclosure url="${escapeXml(audio)}" length="${len}" type="audio/mpeg"/>
      <itunes:duration>${e.durationSec}</itunes:duration>
    </item>`;
    }).join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Standup.fm</title>
    <link>${base}/feed/standup.xml</link>
    <description>Matt's personal morning standup, in audio.</description>
    <language>en-us</language>
    <itunes:author>Standup.fm</itunes:author>
    <itunes:explicit>no</itunes:explicit>
${items}
  </channel>
</rss>`;
    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    res.send(xml);
  });

  // ── Token-gated audio mirror (so podcast apps can fetch enclosure) ───────
  app.get("/feed/audio/:token/:slug.mp3", async (req: Request, res: Response) => {
    const t = await storage.getStandupFeedToken(req.params.token);
    if (!t) return res.status(401).send("invalid token");
    const ep = await storage.getStandupEpisodeBySlug(req.params.slug);
    if (!ep || !ep.audioPath || !existsSync(ep.audioPath)) return res.status(404).send("not found");
    streamAudioWithRange(req, res, ep.audioPath);
  });
}

/**
 * Shared "your move" action resolver. The single entry point used by the
 * StandupView UI today and by future surfaces (ntfy action button, voice).
 *
 *   do     → set 👍 feedback + create a TODO task seeded from the segment
 *   snooze → set 0 feedback + create a TODO task with scheduledDate
 *   drop   → set 👎 feedback (segment is excluded from future episodes)
 *   note   → capture a freeform note via the inbox
 *
 * All branches optionally append the user's note to the persisted artifact.
 */
async function resolveYourMove(opts: { action: "do" | "snooze" | "drop" | "note"; segmentId: number | null; note: string; snoozeDate?: string }): Promise<{ outcome: string; taskId?: number }> {
  const { action, segmentId, note, snoozeDate } = opts;
  let segment: StandupSegment | undefined;
  if (segmentId !== null) {
    const segs = await storage.listStandupSegments(0).catch(() => [] as StandupSegment[]);
    segment = segs.find(s => s.id === segmentId);
    if (!segment) {
      // Fallback: look up via episode listing — segments are always episode-scoped
      const all = await storage.listStandupEpisodes(50);
      for (const ep of all) {
        const s = (await storage.listStandupSegments(ep.id)).find(x => x.id === segmentId);
        if (s) { segment = s; break; }
      }
    }
  }

  if (action === "drop" && segment) {
    await storage.setStandupSegmentFeedback(segment.id, -1);
    return { outcome: `dropped: "${segment.topic}" — won't appear in future episodes` };
  }

  if (action === "do" && segment) {
    await storage.setStandupSegmentFeedback(segment.id, 1);
    const title = note ? note.slice(0, 120) : `Standup: ${segment.topic}`;
    const body = note ? `From standup segment "${segment.topic}":\n\n${segment.text}` : segment.text;
    const task = await storage.createTask({
      title,
      status: "TODO",
      body,
      tags: ["standup", "your-move"],
    });
    return { outcome: `created task #${task.id} from "${segment.topic}"`, taskId: task.id };
  }

  if (action === "snooze" && segment) {
    await storage.setStandupSegmentFeedback(segment.id, 0);
    const date = snoozeDate || tomorrowLocal();
    const task = await storage.createTask({
      title: `Standup (snoozed): ${segment.topic}`,
      status: "TODO",
      body: segment.text + (note ? `\n\nNote: ${note}` : ""),
      scheduledDate: date,
      tags: ["standup", "snoozed"],
    });
    return { outcome: `snoozed "${segment.topic}" → task #${task.id} for ${date}`, taskId: task.id };
  }

  if (action === "note") {
    if (!note) return { outcome: "no-op (note action with empty body)" };
    const safe = note.replace(/["`$\\]/g, " ").trim();
    const result = await executeChain(`capture "${safe}"`);
    if (result.exitCode !== 0) {
      // Fall back to creating a note row directly via storage if the CLI
      // path isn't available — guarantees the user's input is persisted.
      await storage.createNote({ title: safe.slice(0, 80), body: safe, tags: ["standup", "your-move"] });
      return { outcome: "note captured (direct)" };
    }
    return { outcome: "note captured" };
  }

  return { outcome: `no-op (action=${action} segmentId=${segmentId ?? "null"})` };
}

function tomorrowLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * RFC 7233 Range support so podcast apps can seek and resume mid-file.
 * Falls back to a normal 200 stream when no Range header is present.
 */
function streamAudioWithRange(req: Request, res: Response, filePath: string): void {
  const stats = statSync(filePath);
  const total = stats.size;
  const rangeHeader = req.headers.range;
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");

  if (!rangeHeader) {
    res.setHeader("Content-Length", String(total));
    createReadStream(filePath).pipe(res);
    return;
  }

  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!m) {
    res.status(416).setHeader("Content-Range", `bytes */${total}`);
    return res.end();
  }
  const startStr = m[1];
  const endStr = m[2];
  let start = startStr ? parseInt(startStr, 10) : 0;
  let end = endStr ? parseInt(endStr, 10) : total - 1;
  if (!startStr && endStr) {
    // suffix range: bytes=-N → last N bytes
    const suffix = parseInt(endStr, 10);
    start = Math.max(0, total - suffix);
    end = total - 1;
  }
  if (isNaN(start) || isNaN(end) || start > end || start >= total) {
    res.status(416).setHeader("Content-Range", `bytes */${total}`);
    return res.end();
  }
  end = Math.min(end, total - 1);
  const chunk = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
  res.setHeader("Content-Length", String(chunk));
  createReadStream(filePath, { start, end }).pipe(res);
}

// ── Scheduler tick (called from server bootstrap) ──────────────────────────
let lastTickKey = "";
let alertedMorning = "";
export function startStandupScheduler(): void {
  const tick = async () => {
    try {
      const now = new Date();
      const hh = now.getHours();
      const mm = now.getMinutes();
      const dow = now.getDay(); // 0 = Sun, 5 = Fri
      const date = localDateKey(now);
      const key = `${date}-${hh}:${mm}`;
      if (key === lastTickKey) return;
      lastTickKey = key;

      const errMsg = (e: unknown) => e instanceof Error ? e.message : String(e);
      // Morning at 5:45
      if (hh === 5 && mm === 45) {
        await generateEpisode({ kind: "morning", date }).catch(e => console.error("[standup] morning gen:", errMsg(e)));
      }
      // Loud-failure check at 5:50
      if (hh === 5 && mm === 50 && alertedMorning !== date) {
        const ep = await storage.getStandupEpisodeByDateKind(date, "morning");
        if (!ep || ep.status !== "ready") {
          await checkMorningFailure(now);
          alertedMorning = date;
        }
      }
      // Optional afternoon at 14:30
      if (hh === 14 && mm === 30) {
        const cfg = await storage.getAgentConfig("standup_afternoon_enabled");
        if (cfg?.value === "true") {
          await generateEpisode({ kind: "afternoon", date }).catch(e => console.error("[standup] afternoon gen:", errMsg(e)));
        }
      }
      // Friday weekly wrap at 17:30
      if (dow === 5 && hh === 17 && mm === 30) {
        await generateEpisode({ kind: "weekly", date }).catch(e => console.error("[standup] weekly gen:", errMsg(e)));
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[standup-scheduler] tick error:", msg);
    }
  };
  setInterval(tick, 30_000);
  // One immediate tick (no-op outside the scheduled minute)
  tick();
}
