import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import { mkdir } from "fs/promises";
import { join } from "path";
import { existsSync, statSync } from "fs";

const VOICE_DIR = join(process.cwd(), ".voice-cache");

const VOICES = {
  assistant: "en-US-JennyNeural",
  warm: "en-US-AriaNeural",
  crisp: "en-US-BrianMultilingualNeural",
} as const;

export type VoiceStyle = keyof typeof VOICES;

export async function synthesizeBriefing(
  text: string,
  style: VoiceStyle = "assistant"
): Promise<{ filePath: string; durationEstSec: number; sizeBytes: number }> {
  await mkdir(VOICE_DIR, { recursive: true });

  const voice = VOICES[style] || VOICES.assistant;
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);

  const { audioFilePath } = await tts.toFile(VOICE_DIR, text, {
    rate: "-5%",
    pitch: "-2Hz",
    volume: "+0%",
  });

  const stats = statSync(audioFilePath);
  const durationEstSec = Math.round(stats.size / (96000 / 8));

  return { filePath: audioFilePath, durationEstSec, sizeBytes: stats.size };
}

export function htmlToSpokenScript(html: string): string {
  let text = html;

  text = text.replace(/<h1[^>]*>(.*?)<\/h1>/gi, "$1. ");
  text = text.replace(/<h2[^>]*>(.*?)<\/h2>/gi, "\n\n$1.\n");
  text = text.replace(/<strong>(.*?)<\/strong>/gi, "$1");
  text = text.replace(/<a[^>]*href="[^"]*"[^>]*>(.*?)<\/a>/gi, "$1");
  text = text.replace(/<li>(.*?)<\/li>/gi, "  $1.\n");
  text = text.replace(/<\/?(?:ul|ol|div|span|p|br\s*\/?)[^>]*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");

  text = text.replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");

  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return text;
}

export function getLatestAudioPath(): string | null {
  if (!existsSync(VOICE_DIR)) return null;
  const { readdirSync } = require("node:fs") as typeof import("fs");
  const files = readdirSync(VOICE_DIR)
    .filter((f: string) => f.endsWith(".mp3"))
    .map((f: string) => ({
      name: f,
      path: join(VOICE_DIR, f),
      mtime: statSync(join(VOICE_DIR, f)).mtimeMs,
    }))
    .sort((a: any, b: any) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].path : null;
}
