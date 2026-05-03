import { mkdir, readFile } from "fs/promises";
import { existsSync, statSync, copyFileSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { storage } from "./storage";
import { synthesizeBriefing, type VoiceStyle } from "./voice-synth";
import { executeChain } from "./cli-engine";
import type { StandupKind, StandupEpisode, StandupSegment } from "@shared/schema";

// Standup audio is intentionally stored OUTSIDE .briefings/ because that
// directory is publicly served. Standup mp3s must only be reachable via the
// token-gated /feed/audio/:token/:slug.mp3 route (or the authenticated
// /api/standup/episodes/:id/audio.mp3 route used by the in-app player).
const STANDUP_AUDIO_DIR = join(process.cwd(), ".standup-audio");
const EPISODES_DIR = join(STANDUP_AUDIO_DIR, "episodes");

const KIND_TO_VOICE: Record<StandupKind, VoiceStyle> = {
  morning: "assistant",
  afternoon: "warm",
  weekly: "crisp",
};

const KIND_OPENER: Record<StandupKind, (date: string) => string> = {
  morning: (d) => `Good morning, Matt. It's ${formatDate(d)}. Here's your standup.`,
  afternoon: (d) => `Hey Matt, quick afternoon check-in for ${formatDate(d)}. Here's where things stand.`,
  weekly: (d) => `Happy Friday, Matt. Here's the week wrap for ${formatDate(d)}.`,
};

const KIND_CLOSER: Record<StandupKind, string> = {
  morning: "That's the morning. Have a good one.",
  afternoon: "That's where things stand. Catch you later.",
  weekly: "That's the week. Enjoy the weekend.",
};

function formatDate(iso: string): string {
  try {
    const d = new Date(iso + "T12:00:00Z");
    return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  } catch { return iso; }
}

const ACRONYM_MAP: Array<[RegExp, string]> = [
  [/\bSNOW\b/g, "ServiceNow"],
  [/\bHN\b/g, "Hacker News"],
  [/\bPR\b/g, "P R"],
  [/\bCLI\b/g, "C L I"],
  [/\bAPI\b/g, "A P I"],
  [/\bMP3\b/g, "M P 3"],
  [/\bRSS\b/g, "R S S"],
  [/\bTLDR\b/gi, "T L D R"],
  [/\bUI\b/g, "U I"],
  [/\bLLM\b/g, "L L M"],
];

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<a[^>]*>([^<]*)<\/a>/gi, "$1")
    .replace(/<\/(h[1-6]|p|div|li|ul|ol)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function expandAcronyms(text: string): string {
  let out = text;
  for (const [re, rep] of ACRONYM_MAP) out = out.replace(re, rep);
  return out;
}

function tightenSentences(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/\.\s+/g, ". ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export interface ScriptSegment {
  topic: string;
  text: string;
}

/**
 * Pure deterministic transformer: brief HTML → ordered podcast segments.
 * Each <h2> becomes a segment; the cold-open and sign-off are added by caller.
 */
export function briefToSegments(briefHtml: string, voiceScriptFallback?: string): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  const headerSplit = briefHtml.split(/<h2[^>]*>/i);
  const intro = headerSplit.shift() || "";
  void intro;
  for (const chunk of headerSplit) {
    const closeIdx = chunk.toLowerCase().indexOf("</h2>");
    if (closeIdx < 0) continue;
    const rawTopic = chunk.slice(0, closeIdx).replace(/<[^>]+>/g, "").trim();
    const body = chunk.slice(closeIdx + 5);
    const nextH2 = body.search(/<h[12][^>]*>/i);
    const sectionHtml = nextH2 >= 0 ? body.slice(0, nextH2) : body;
    const text = tightenSentences(expandAcronyms(stripHtml(sectionHtml)));
    if (!text || text.length < 4) continue;
    const topic = rawTopic.toLowerCase();
    if (topic.includes("index") || topic.includes("source feed") || topic.includes("full source")) continue;
    segments.push({ topic: rawTopic, text });
  }
  if (segments.length === 0 && voiceScriptFallback) {
    const paras = voiceScriptFallback.split(/\n\s*\n/).map(p => tightenSentences(expandAcronyms(p))).filter(Boolean);
    paras.forEach((t, i) => segments.push({ topic: `Segment ${i + 1}`, text: t }));
  }
  return segments;
}

export async function buildStandupScript(kind: StandupKind, briefHtml: string, voiceScriptFallback?: string, dateStr?: string): Promise<{ segments: ScriptSegment[]; fullText: string }> {
  const date = dateStr || new Date().toISOString().slice(0, 10);
  const trimmed = await applyFeedbackTrimming(briefToSegments(briefHtml, voiceScriptFallback));
  const opener: ScriptSegment = { topic: "Cold Open", text: KIND_OPENER[kind](date) };
  const closer: ScriptSegment = { topic: "Sign-off", text: KIND_CLOSER[kind] };
  const all = [opener, ...trimmed, closer];
  const fullText = all.map(s => s.text).join("\n\n");
  return { segments: all, fullText };
}

/**
 * Down-rank segment topics that have accumulated thumbs-down feedback over the last week.
 * Trimming = drop segments whose topic has net feedback ≤ -2 in last 7 days.
 */
async function applyFeedbackTrimming(segments: ScriptSegment[]): Promise<ScriptSegment[]> {
  try {
    const week = 7 * 24 * 60 * 60 * 1000;
    const recent = await storage.getRecentSegmentFeedback(week);
    const tally = new Map<string, number>();
    for (const s of recent) {
      const key = (s.topic || "").trim().toLowerCase();
      if (!key) continue;
      tally.set(key, (tally.get(key) || 0) + (s.feedback || 0));
    }
    return segments.filter(seg => {
      const score = tally.get(seg.topic.trim().toLowerCase());
      if (score === undefined) return true;
      return score > -2;
    });
  } catch {
    return segments;
  }
}

async function ensureDirs(): Promise<void> {
  await mkdir(STANDUP_AUDIO_DIR, { recursive: true });
  await mkdir(EPISODES_DIR, { recursive: true });
}

/**
 * Synthesize each segment, then concatenate into one episode file by binary
 * append. Edge-TTS emits matching encoding (24kHz 96kbps mono MP3) so simple
 * concat plays cleanly in browsers/podcast apps.
 *
 * Resumable: each per-segment file is keyed by content hash inside the
 * episode dir; if the same text/voice was synthesized previously we reuse the
 * cached file instead of calling Edge-TTS again. The episode-level concat is
 * always rebuilt from scratch (cheap) so segment ordering stays consistent.
 */
async function synthesizeAndConcat(episodeSlug: string, segments: ScriptSegment[], voice: VoiceStyle): Promise<{ filePath: string; sizeBytes: number; durationSec: number; segmentTimes: Array<{ startSec: number; endSec: number }> }> {
  await ensureDirs();
  const epDir = join(EPISODES_DIR, episodeSlug);
  await mkdir(epDir, { recursive: true });
  const outPath = join(STANDUP_AUDIO_DIR, `standup-${episodeSlug}.mp3`);
  writeFileSync(outPath, Buffer.alloc(0));
  const times: Array<{ startSec: number; endSec: number }> = [];
  let cursorSec = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const hash = createTextHash(`${voice}::${seg.text}`);
    const segPath = join(epDir, `seg-${String(i).padStart(2, "0")}-${hash}.mp3`);
    let durationEstSec: number;
    if (existsSync(segPath)) {
      const st = statSync(segPath);
      durationEstSec = Math.round(st.size / (96000 / 8));
    } else {
      const result = await synthesizeBriefing(seg.text, voice);
      copyFileSync(result.filePath, segPath);
      durationEstSec = result.durationEstSec;
    }
    const buf = await readFile(segPath);
    appendFileSync(outPath, buf);
    const start = cursorSec;
    const end = cursorSec + durationEstSec;
    times.push({ startSec: start, endSec: end });
    cursorSec = end;
  }
  const stats = statSync(outPath);
  return { filePath: outPath, sizeBytes: stats.size, durationSec: cursorSec, segmentTimes: times };
}

function createTextHash(input: string): string {
  // Tiny, dependency-free FNV-1a hash; collision-safe enough for per-episode keys.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export interface GenerateOptions {
  kind?: StandupKind;
  date?: string;
  baseUrl?: string;
}

function publicBaseUrl(): string {
  const domain = (process.env.REPLIT_DOMAINS || "").split(",")[0].trim();
  return domain ? `https://${domain}` : "http://localhost:5000";
}

/**
 * Send a ntfy push with an attached MP3 so the morning episode can be played
 * directly from the notification (per the "loud + actionable" delivery spec).
 * Uses the standard ntfy `Attach` header pointing at the token-gated audio
 * URL so confidentiality is preserved.
 */
async function pushNtfyWithAttachment(opts: { title: string; message: string; attachUrl: string; filename: string }): Promise<void> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return; // ntfy not configured — silently skip
  const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
  await fetch(`${server}/${encodeURIComponent(topic)}`, {
    method: "POST",
    headers: {
      "Title": opts.title,
      "Attach": opts.attachUrl,
      "Filename": opts.filename,
      "Tags": "microphone",
    },
    body: opts.message,
  });
}

/**
 * Run the existing `standup` CLI command, parse its HTML+voice-script payload,
 * transform → segments → TTS → concat → persist episode + segment rows.
 */
export async function generateEpisode(opts: GenerateOptions = {}): Promise<StandupEpisode> {
  const kind: StandupKind = opts.kind || "morning";
  const date = opts.date || new Date().toISOString().slice(0, 10);
  const slug = `${date}-${kind}`;

  const existing = await storage.getStandupEpisodeBySlug(slug);
  if (existing && existing.status === "ready") return existing;

  const placeholder = existing || await storage.createStandupEpisode({
    slug, kind, publishedDate: date,
    title: titleFor(kind, date), summary: "Generating...", scriptText: "",
    voice: KIND_TO_VOICE[kind], status: "pending", generatedAtMs: Date.now(),
  });

  try {
    const cli = await executeChain("standup --days 1");
    if (cli.exitCode !== 0) throw new Error(`standup CLI exited ${cli.exitCode}: ${(cli.output || "").slice(0, 200)}`);
    const fullOutput = cli.output || "";
    const voiceMatch = fullOutput.match(/<!--VOICE_SCRIPT_START-->\n([\s\S]*?)\n<!--VOICE_SCRIPT_END-->/);
    const voiceScript = voiceMatch ? voiceMatch[1].trim() : "";
    const briefHtml = voiceMatch ? fullOutput.slice(0, voiceMatch.index!).trim() : fullOutput;

    const { segments, fullText } = await buildStandupScript(kind, briefHtml, voiceScript, date);
    if (segments.length <= 2) throw new Error("brief produced no usable segments");

    const synth = await synthesizeAndConcat(slug, segments, KIND_TO_VOICE[kind]);
    const summary = segments.slice(1, -1).map(s => s.topic).join(" · ").slice(0, 240);

    const updated = await storage.updateStandupEpisode(placeholder.id, {
      scriptText: fullText,
      audioPath: synth.filePath,
      // No public audioUrl is persisted — the in-app player and RSS both
      // resolve audio via auth/token-gated routes at request time.
      audioUrl: null,
      durationSec: synth.durationSec,
      sizeBytes: synth.sizeBytes,
      status: "ready",
      summary,
      failureReason: null,
      generatedAtMs: Date.now(),
    });

    // Idempotent re-seed: drop any prior segment rows for this episode
    // before inserting the freshly-built ones so retries don't accumulate
    // duplicate ordinals.
    await storage.deleteStandupSegmentsByEpisode(placeholder.id);
    for (let i = 0; i < segments.length; i++) {
      const t = synth.segmentTimes[i];
      await storage.createStandupSegment({
        episodeId: placeholder.id,
        ordinal: i,
        topic: segments[i].topic,
        text: segments[i].text,
        startSec: t.startSec,
        endSec: t.endSec,
        feedback: 0,
      });
    }

    // Success ntfy push with the mp3 attached for direct in-notification
    // playback. We pick the first available feed token so the attached URL
    // is reachable; if none exist we fall back to a text-only message.
    try {
      const tokens = await storage.listStandupFeedTokens();
      const tk = tokens[0]?.token;
      const base = opts.baseUrl || publicBaseUrl();
      const mins = Math.round(synth.durationSec / 60);
      if (tk) {
        const attachUrl = `${base}/feed/audio/${encodeURIComponent(tk)}/${encodeURIComponent(slug)}.mp3`;
        await pushNtfyWithAttachment({
          title: `Standup.fm ${kind} ready`,
          message: `${mins} min — tap to play`,
          attachUrl,
          filename: `standup-${slug}.mp3`,
        });
      } else {
        await executeChain(`notify "Standup.fm ${kind} ready (${mins}m)"`);
      }
    } catch (notifyErr: unknown) {
      const msg = notifyErr instanceof Error ? notifyErr.message : String(notifyErr);
      console.error("[standup] success notify failed:", msg);
    }

    return updated || placeholder;
  } catch (err: unknown) {
    const raw = err instanceof Error ? err.message : String(err);
    const reason = raw.slice(0, 500);
    const failed = await storage.updateStandupEpisode(placeholder.id, {
      status: "failed",
      failureReason: reason,
      generatedAtMs: Date.now(),
    });
    return failed || placeholder;
  }
}

function titleFor(kind: StandupKind, date: string): string {
  const pretty = formatDate(date);
  if (kind === "morning") return `Standup.fm — Morning, ${pretty}`;
  if (kind === "afternoon") return `Standup.fm — Afternoon, ${pretty}`;
  return `Standup.fm — Week wrap, ${pretty}`;
}

/**
 * Loud-failure check: if it's after the morning deadline and no ready
 * morning episode exists for today, send a loud ntfy alert.
 */
export async function checkMorningFailure(now: Date = new Date()): Promise<{ alerted: boolean; reason?: string }> {
  // Local-time date so this matches the scheduler's slug for the same day.
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const date = `${y}-${m}-${d}`;
  const ep = await storage.getStandupEpisodeByDateKind(date, "morning");
  if (ep && ep.status === "ready") return { alerted: false };
  const reason = ep?.failureReason || "no morning episode by 5:50 AM";
  try {
    const topic = process.env.NTFY_TOPIC;
    if (topic) {
      const server = (process.env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
      await fetch(`${server}/${encodeURIComponent(topic)}`, {
        method: "POST",
        headers: { "Title": "Standup.fm MISSING", "Priority": "urgent", "Tags": "rotating_light" },
        body: reason.slice(0, 200),
      });
    } else {
      await executeChain(`notify "Standup.fm MISSING — ${reason.replace(/"/g, "'").slice(0, 120)}"`);
    }
  } catch {}
  return { alerted: true, reason };
}
