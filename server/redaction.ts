// ────────────────────────────────────────────────────────────────────────────
// PHI / PII redaction pipeline for the Trajectory Inspector.
//
// Default-on. Raw observation/metadata text and screenshot bytes are gated
// behind a one-time, header-delivered unlock token (5 min TTL) which is
// audit-logged at mint time and again at consume time.
//
// The text redactor walks RouterTraceEvents and masks anything matching the
// configured patterns. The screenshot redactor produces an SVG that draws
// the original image (when bytes are available) plus opaque overlay
// rectangles for any configured RedactionRegion that matches the
// surfaceKind/imageRef. When raw bytes are unavailable the SVG renders a
// "REDACTED" placeholder of the original size.
// ────────────────────────────────────────────────────────────────────────────

import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import type { RedactionPolicy, RedactionRegion } from "@shared/trajectory-types";

export interface RedactionResult<T> {
  redacted: T;
  redactedFields: string[];
  rawAvailable: boolean;
}

interface CompiledPattern {
  name: string;
  pattern: RegExp;
  mask: string;
}

const DEFAULT_POLICY: RedactionPolicy = {
  patterns: [
    { name: "ssn", pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b", flags: "g", mask: "[SSN]" },
    { name: "phone", pattern: "\\b\\(?\\d{3}\\)?[-. ]?\\d{3}[-. ]?\\d{4}\\b", flags: "g", mask: "[PHONE]" },
    { name: "email", pattern: "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}", flags: "g", mask: "[EMAIL]" },
    { name: "mrn", pattern: "\\b(?:MRN|mrn|Mrn)[:#\\s]*\\d{4,12}\\b", flags: "g", mask: "[MRN]" },
    { name: "dob", pattern: "\\b(0?[1-9]|1[0-2])[\\/\\-](0?[1-9]|[12]\\d|3[01])[\\/\\-](19|20)\\d{2}\\b", flags: "g", mask: "[DOB]" },
    { name: "long-digit-run", pattern: "\\b\\d{6,}\\b", flags: "g", mask: "[NUM]" },
  ],
  regions: [],
  stripImageRefs: true,
};

let cachedPolicy: { policy: RedactionPolicy; compiled: CompiledPattern[] } | null = null;

function compilePolicy(policy: RedactionPolicy): CompiledPattern[] {
  return policy.patterns.map((p) => ({
    name: p.name,
    pattern: new RegExp(p.pattern, p.flags ?? "g"),
    mask: p.mask,
  }));
}

export function loadRedactionPolicy(): RedactionPolicy {
  if (cachedPolicy) return cachedPolicy.policy;
  const cfgPath = process.env.REDACTION_CONFIG_PATH ?? path.join(process.cwd(), "config", "redaction.json");
  let policy = DEFAULT_POLICY;
  try {
    if (fs.existsSync(cfgPath)) {
      const raw = JSON.parse(fs.readFileSync(cfgPath, "utf8")) as Partial<RedactionPolicy>;
      policy = {
        patterns: raw.patterns ?? DEFAULT_POLICY.patterns,
        regions: raw.regions ?? [],
        stripImageRefs: raw.stripImageRefs ?? true,
      };
    }
  } catch (err) {
    console.warn("[redaction] Failed to load policy, using defaults:", err);
  }
  cachedPolicy = { policy, compiled: compilePolicy(policy) };
  return policy;
}

export function reloadRedactionPolicy(): void {
  cachedPolicy = null;
}

function getCompiled(): CompiledPattern[] {
  if (!cachedPolicy) loadRedactionPolicy();
  return cachedPolicy!.compiled;
}

export function redactString(input: string): { value: string; hits: string[] } {
  if (!input) return { value: input, hits: [] };
  const patterns = getCompiled();
  let value = input;
  const hits: string[] = [];
  for (const { name, pattern, mask } of patterns) {
    pattern.lastIndex = 0;
    const before = value;
    value = value.replace(pattern, mask);
    if (value !== before) hits.push(name);
  }
  return { value, hits };
}

function redactValue(value: unknown, fieldsHit: Set<string>, path: string): unknown {
  if (value == null) return value;
  if (typeof value === "string") {
    const { value: out, hits } = redactString(value);
    if (hits.length) fieldsHit.add(path);
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => redactValue(v, fieldsHit, `${path}[${i}]`));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, fieldsHit, path ? `${path}.${k}` : k);
    }
    return out;
  }
  return value;
}

export interface RedactOptions {
  raw?: boolean;
}

export function redactTraceEvent<T extends Record<string, unknown>>(
  event: T,
  opts: RedactOptions = {},
): RedactionResult<T> {
  if (opts.raw) {
    return { redacted: event, redactedFields: [], rawAvailable: true };
  }
  const policy = loadRedactionPolicy();
  const fieldsHit = new Set<string>();
  const out = redactValue(event, fieldsHit, "") as T;

  if (policy.stripImageRefs) {
    const obs = (out as { observation?: { imageRef?: string } }).observation;
    if (obs && typeof obs === "object" && "imageRef" in obs && obs.imageRef) {
      obs.imageRef = "[REDACTED]";
      fieldsHit.add("observation.imageRef");
    }
    const md = (out as { metadata?: { imageRef?: string } }).metadata;
    if (md && typeof md === "object" && "imageRef" in md && md.imageRef) {
      md.imageRef = "[REDACTED]";
      fieldsHit.add("metadata.imageRef");
    }
  }
  return { redacted: out, redactedFields: Array.from(fieldsHit), rawAvailable: false };
}

export function redactTraceEvents(
  events: Array<Record<string, unknown>>,
  opts: RedactOptions = {},
): { events: Array<Record<string, unknown>>; redactedFieldCount: number; rawAvailable: boolean } {
  let total = 0;
  const out = events.map((e) => {
    const r = redactTraceEvent(e, opts);
    total += r.redactedFields.length;
    return r.redacted;
  });
  return { events: out, redactedFieldCount: total, rawAvailable: !!opts.raw };
}

export function getRedactionRegions(filter: { surfaceKind?: string; imageRef?: string }): RedactionRegion[] {
  const policy = loadRedactionPolicy();
  return policy.regions.filter((r) =>
    (!r.surfaceKind || r.surfaceKind === filter.surfaceKind) &&
    (!r.imageRef || r.imageRef === filter.imageRef),
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Screenshot pipeline. We render an SVG so we have zero native-image
// dependencies and a consistent overlay model. When bytes are present we
// embed them; otherwise we render a labeled placeholder.
// ────────────────────────────────────────────────────────────────────────────

export interface ScreenshotMeta {
  width: number;
  height: number;
  bytes?: Buffer;
  mime?: string;
}

// Render modes (fail-closed):
//   raw=true  + bytes  → embed image with thin overlays (audit-logged unlock)
//   raw=false (any)    → wireframe placeholder showing region boxes only;
//                        the original image bytes are NEVER embedded in
//                        non-raw mode because SVG <image href="data:..."> is
//                        trivially reversible by extracting the base64.
//   raw=true  + no bytes → placeholder
export function renderRedactedSvg(meta: ScreenshotMeta, regions: RedactionRegion[], opts: { raw: boolean }): string {
  const w = Math.max(1, meta.width);
  const h = Math.max(1, meta.height);
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`);

  if (opts.raw && meta.bytes && meta.mime) {
    const b64 = meta.bytes.toString("base64");
    parts.push(`<image href="data:${meta.mime};base64,${b64}" x="0" y="0" width="${w}" height="${h}"/>`);
    for (const r of regions) {
      parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#000"/>`);
      parts.push(`<text x="${r.x + 4}" y="${r.y + 14}" fill="#fff" font-family="monospace" font-size="10">REDACTED</text>`);
    }
  } else {
    // Wireframe placeholder: dark canvas + outlined region boxes so the
    // analyst can see WHERE PHI lives without seeing the pixels themselves.
    parts.push(`<rect width="100%" height="100%" fill="#1a1a1a"/>`);
    for (const r of regions) {
      parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="4,2"/>`);
      parts.push(`<text x="${r.x + 4}" y="${r.y + 14}" fill="#dc2626" font-family="monospace" font-size="10">PHI region</text>`);
    }
    const label = opts.raw
      ? "screenshot bytes not persisted"
      : "REDACTED wireframe — unlock raw to view pixels";
    parts.push(`<text x="50%" y="${h - 12}" fill="#888" font-family="monospace" font-size="12" text-anchor="middle">${label}</text>`);
  }
  parts.push(`</svg>`);
  return parts.join("");
}

// ────────────────────────────────────────────────────────────────────────────
// Per-session raw-unlock tokens. Header-delivered (X-Unlock-Token), TTL-bound
// (5 min), explicitly revocable. Each successful validation is the caller's
// responsibility to audit-log so detail and screenshot endpoints can both
// participate in the same session without burning the token on first use.
// ────────────────────────────────────────────────────────────────────────────

interface UnlockEntry {
  runId: string;
  expiresAt: number;
  reason: string;
  actor: string;
  // SHA-256 hex of the principal credential at mint time (e.g. the API key
  // Bearer value). Validation requires the same principal to present the
  // token, so a leaked token alone cannot be used by another caller.
  principalHash: string;
}

const TOKEN_TTL_MS = 5 * 60 * 1000;
const unlocks = new Map<string, UnlockEntry>();

import { createHash } from "crypto";

export function principalHash(principal: string | undefined | null): string {
  // Anonymous (no API key configured) collapses to a constant bucket so
  // unauthenticated single-tenant deployments still work, but the binding
  // is exercised whenever a principal is present.
  return createHash("sha256").update(principal || "anonymous").digest("hex");
}

export function mintRawUnlock(
  runId: string,
  actor: string,
  reason: string,
  principal?: string,
): { token: string; expiresAt: number } {
  // Cryptographically-random token (32 bytes / 256 bits). We do NOT embed
  // runId in the token string itself — binding is enforced server-side by
  // the map entry, so a token cannot be replayed against a different run
  // even if its prefix were swapped.
  const token = `raw_${randomBytes(32).toString("hex")}`;
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  unlocks.set(token, { runId, expiresAt, reason, actor, principalHash: principalHash(principal) });
  return { token, expiresAt };
}

export interface ValidatedUnlock {
  actor: string;
  reason: string;
  expiresAt: number;
}

export function validateRawUnlock(
  token: string | undefined,
  runId: string,
  principal?: string,
): ValidatedUnlock | null {
  if (!token) return null;
  const entry = unlocks.get(token);
  if (!entry) return null;
  if (entry.runId !== runId) return null;
  if (entry.principalHash !== principalHash(principal)) return null;
  if (Date.now() > entry.expiresAt) {
    unlocks.delete(token);
    return null;
  }
  return { actor: entry.actor, reason: entry.reason, expiresAt: entry.expiresAt };
}

export function revokeRawUnlock(token: string | undefined): boolean {
  if (!token) return false;
  return unlocks.delete(token);
}

// Back-compat shim for tests that still call consumeRawUnlock; behaves
// identically to validateRawUnlock (TTL-bound, non-destructive).
export const consumeRawUnlock = validateRawUnlock;

export function clearExpiredUnlocks(): void {
  const now = Date.now();
  for (const [k, v] of Array.from(unlocks.entries())) {
    if (now > v.expiresAt) unlocks.delete(k);
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Screenshot byte provider — host registers a provider that maps (runId,
// imageRef) → bytes. If unregistered, the SVG renders a placeholder.
// ────────────────────────────────────────────────────────────────────────────

export type ScreenshotProvider = (runId: string, imageRef: string) =>
  Promise<{ bytes: Buffer; mime: string; width: number; height: number } | null>;

let provider: ScreenshotProvider | null = null;

export function registerScreenshotProvider(p: ScreenshotProvider): void {
  provider = p;
}

export function getScreenshotProvider(): ScreenshotProvider | null {
  return provider;
}
