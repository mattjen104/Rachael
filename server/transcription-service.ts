import { storage } from "./storage";
import { emitEvent } from "./event-bus";
import { randomUUID } from "crypto";

interface AudioSession {
  id: string;
  transcriptId: number;
  chunks: Buffer[];
  sourceUrl: string;
  tabTitle: string;
  platform: string;
  recordingType: string;
  startedAt: number;
}

const activeSessions = new Map<string, AudioSession>();
const MAX_SESSION_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_SESSION_DURATION_MS = 4 * 60 * 60 * 1000;

export function detectPlatform(url: string): string {
  if (!url) return "other";
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("teams.microsoft.com") || host.includes("teams.live.com")) return "teams";
    if (host.includes("zoom.us") || host.includes("zoom.com")) return "zoom";
    if (host.includes("meet.google.com")) return "google-meet";
    if (host.includes("webex.com")) return "webex";
    if (host.includes("slack.com")) return "slack";
  } catch {}
  return "other";
}

export async function startRecordingSession(sourceUrl: string, tabTitle: string, recordingType: string = "tab"): Promise<{ sessionId: string; transcriptId: number }> {
  const sessionId = randomUUID();
  const platform = detectPlatform(sourceUrl);
  const title = tabTitle || `${platform} recording`;

  const transcript = await storage.createTranscript({
    title,
    platform,
    sourceUrl: sourceUrl || null,
    status: "recording",
    recordingType,
    rawText: "",
    segments: [],
  });

  activeSessions.set(sessionId, {
    id: sessionId,
    transcriptId: transcript.id,
    chunks: [],
    sourceUrl,
    tabTitle,
    platform,
    recordingType,
    startedAt: Date.now(),
  });

  emitEvent("transcription", `Recording started: ${title} (${platform})`, "action", {
    metadata: { sessionId, transcriptId: transcript.id, platform, recordingType },
  });

  return { sessionId, transcriptId: transcript.id };
}

export async function addAudioChunk(sessionId: string, chunk: Buffer): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error("Recording session not found");

  const currentSize = session.chunks.reduce((sum, c) => sum + c.length, 0);
  if (currentSize + chunk.length > MAX_SESSION_SIZE_BYTES) {
    throw new Error("Recording session exceeds maximum size limit (25MB)");
  }

  const elapsed = Date.now() - session.startedAt;
  if (elapsed > MAX_SESSION_DURATION_MS) {
    throw new Error("Recording session exceeds maximum duration (4 hours)");
  }

  session.chunks.push(chunk);
}

export async function stopRecordingSession(sessionId: string): Promise<{ transcriptId: number }> {
  const session = activeSessions.get(sessionId);
  if (!session) throw new Error("Recording session not found");

  const durationSeconds = Math.round((Date.now() - session.startedAt) / 1000);

  await storage.updateTranscript(session.transcriptId, {
    status: "transcribing",
    durationSeconds,
  });

  emitEvent("transcription", `Recording stopped, transcribing... (${durationSeconds}s)`, "action", {
    metadata: { sessionId, transcriptId: session.transcriptId },
  });

  const audioBuffer = Buffer.concat(session.chunks);
  activeSessions.delete(sessionId);

  transcribeAudio(session.transcriptId, audioBuffer, session.platform, session.tabTitle, durationSeconds).catch(err => {
    console.error("[transcription] Failed:", err);
  });

  return { transcriptId: session.transcriptId };
}

async function transcribeAudio(
  transcriptId: number,
  audioBuffer: Buffer,
  platform: string,
  title: string,
  durationSeconds: number
): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    await storage.updateTranscript(transcriptId, {
      status: "error",
      rawText: "Error: OPENAI_API_KEY not set. Cannot transcribe audio.",
    });
    emitEvent("transcription", "Transcription failed: OPENAI_API_KEY not set", "error", {
      metadata: { transcriptId },
    });
    return;
  }

  try {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: "audio/webm" });
    formData.append("file", blob, "recording.webm");
    formData.append("model", "whisper-1");
    formData.append("response_format", "verbose_json");
    formData.append("timestamp_granularities[]", "segment");

    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Whisper API error ${res.status}: ${errText}`);
    }

    interface WhisperSegment { start?: number; end?: number; text?: string; }
    interface WhisperResponse { text?: string; segments?: WhisperSegment[]; duration?: number; }
    const data: WhisperResponse = await res.json();
    const rawText = data.text || "";
    const segments = (data.segments || []).map((seg: WhisperSegment) => ({
      start: seg.start || 0,
      end: seg.end || 0,
      text: (seg.text || "").trim(),
    }));

    await storage.updateTranscript(transcriptId, {
      status: "done",
      rawText,
      segments,
      durationSeconds: Math.round(data.duration || durationSeconds),
    });

    emitEvent("transcription", `Transcription complete: ${title} (${platform}, ${segments.length} segments)`, "info", {
      metadata: { transcriptId, platform, segmentCount: segments.length },
    });
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await storage.updateTranscript(transcriptId, {
      status: "error",
      rawText: `Transcription error: ${errorMsg}`,
    });
    emitEvent("transcription", `Transcription failed: ${errorMsg.slice(0, 100)}`, "error", {
      metadata: { transcriptId },
    });
  }
}

export function getActiveRecordingSessions(): Array<{ sessionId: string; transcriptId: number; platform: string; durationSoFar: number; recordingType: string }> {
  return Array.from(activeSessions.values()).map(s => ({
    sessionId: s.id,
    transcriptId: s.transcriptId,
    platform: s.platform,
    durationSoFar: Math.round((Date.now() - s.startedAt) / 1000),
    recordingType: s.recordingType,
  }));
}

export async function transcribeUploadedAudio(audioBuffer: Buffer, sourceUrl: string, title: string, recordingType: string = "manual"): Promise<{ transcriptId: number }> {
  const platform = detectPlatform(sourceUrl);
  const displayTitle = title || `${recordingType === "manual" ? "Manual" : platform} recording`;

  const transcript = await storage.createTranscript({
    title: displayTitle,
    platform,
    sourceUrl: sourceUrl || null,
    status: "transcribing",
    recordingType,
    rawText: "",
    segments: [],
  });

  emitEvent("transcription", `Transcribing uploaded audio: ${displayTitle}`, "action", {
    metadata: { transcriptId: transcript.id, platform, recordingType },
  });

  transcribeAudio(transcript.id, audioBuffer, platform, displayTitle, 0).catch(err => {
    console.error("[transcription] Failed:", err);
  });

  return { transcriptId: transcript.id };
}
