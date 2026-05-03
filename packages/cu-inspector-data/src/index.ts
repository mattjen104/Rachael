// @rachael/cu-inspector-data — trajectory frame schemas + redaction.
//
// This package ships the *data contract* for the trajectory inspector:
//   - TrajectoryEvent, TrajectoryRunSummary, TrajectoryRunDetail, etc.
//   - RedactionPolicy and the default-on PHI/PII regex set
//   - A reference text redactor and an SVG screenshot redactor that
//     produces a wireframe placeholder rather than embedding pixels.
//
// The React inspector itself is internal to Rachael by design; an external
// adopter can build their own UI on top of this contract.

import { z } from "zod";

export type TrajectoryKind =
  | "decision" | "observe" | "act" | "verify" | "recovery"
  | "escalate" | "budget-deny" | "tier-miss" | "takeover" | "complete" | "abort";

export const TrajectoryKindSchema = z.enum([
  "decision", "observe", "act", "verify", "recovery",
  "escalate", "budget-deny", "tier-miss", "takeover", "complete", "abort",
]);

export interface TrajectoryObservation {
  kind: string;
  digest: string;
  imageRef?: string;
}

export interface TrajectoryVerifier {
  kind: string;
  result?: { ok?: boolean; reason?: string };
}

export interface TrajectoryCandidate {
  index: number;
  label?: string;
  score?: number;
  source?: string;
  bbox?: [number, number, number, number];
}

export interface TrajectoryEventMetadata {
  text?: string;
  tree?: string;
  candidates?: TrajectoryCandidate[];
  pickedCandidateIndex?: number;
  imageWidth?: number;
  imageHeight?: number;
  [k: string]: unknown;
}

export interface TrajectoryEvent {
  id: string;
  ts: number;
  runId: string;
  stepIndex: number;
  kind: TrajectoryKind;
  surfaceId: string;
  surfaceKind: string;
  observation?: TrajectoryObservation;
  attemptedObservation?: string;
  attemptedLocator?: string;
  actionVerb?: string;
  modelId?: string;
  estimatedCost?: number;
  verifier?: TrajectoryVerifier;
  fallbackChain?: string[];
  reason: string;
  metadata?: TrajectoryEventMetadata;
}

export const TrajectoryEventSchema = z.object({
  id: z.string(),
  ts: z.number(),
  runId: z.string(),
  stepIndex: z.number(),
  kind: TrajectoryKindSchema,
  surfaceId: z.string(),
  surfaceKind: z.string(),
  observation: z.object({
    kind: z.string(),
    digest: z.string(),
    imageRef: z.string().optional(),
  }).optional(),
  attemptedObservation: z.string().optional(),
  attemptedLocator: z.string().optional(),
  actionVerb: z.string().optional(),
  modelId: z.string().optional(),
  estimatedCost: z.number().optional(),
  verifier: z.object({
    kind: z.string(),
    result: z.object({ ok: z.boolean().optional(), reason: z.string().optional() }).optional(),
  }).optional(),
  fallbackChain: z.array(z.string()).optional(),
  reason: z.string(),
  metadata: z.record(z.unknown()).optional(),
});

export interface RedactionRegion {
  surfaceKind?: string;
  imageRef?: string;
  x: number; y: number;
  w: number; h: number;
  reason: string;
}

export interface RedactionPolicy {
  patterns: Array<{ name: string; pattern: string; flags?: string; mask: string }>;
  regions: RedactionRegion[];
  stripImageRefs: boolean;
}

export const DEFAULT_REDACTION_POLICY: RedactionPolicy = {
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

export interface TextRedactionResult {
  text: string;
  hits: string[]; // pattern names that matched
}

export function redactText(input: string, policy: RedactionPolicy = DEFAULT_REDACTION_POLICY): TextRedactionResult {
  let out = input;
  const hits: string[] = [];
  for (const p of policy.patterns) {
    const re = new RegExp(p.pattern, p.flags ?? "g");
    if (re.test(out)) hits.push(p.name);
    out = out.replace(new RegExp(p.pattern, p.flags ?? "g"), p.mask);
  }
  return { text: out, hits };
}

export interface FrameRedactionResult {
  event: TrajectoryEvent;
  hits: string[];
}

/**
 * Walk a TrajectoryEvent and redact any PHI/PII strings in metadata.text,
 * metadata.tree, candidate labels, verifier reasons, etc. When
 * `policy.stripImageRefs` is true, observation.imageRef is also dropped.
 */
export function redactFrame(
  event: TrajectoryEvent,
  policy: RedactionPolicy = DEFAULT_REDACTION_POLICY,
): FrameRedactionResult {
  const hits = new Set<string>();
  const next: TrajectoryEvent = JSON.parse(JSON.stringify(event));

  const visit = (val: unknown, path: string): unknown => {
    if (typeof val === "string") {
      const r = redactText(val, policy);
      r.hits.forEach((h) => hits.add(`${path}:${h}`));
      return r.text;
    }
    if (Array.isArray(val)) {
      return val.map((v, i) => visit(v, `${path}[${i}]`));
    }
    if (val && typeof val === "object") {
      const o = val as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(o)) out[k] = visit(o[k], `${path}.${k}`);
      return out;
    }
    return val;
  };

  if (next.metadata) next.metadata = visit(next.metadata, "metadata") as TrajectoryEventMetadata;
  if (next.verifier?.result?.reason) next.verifier.result.reason = visit(next.verifier.result.reason, "verifier") as string;
  if (next.reason) next.reason = visit(next.reason, "reason") as string;
  if (policy.stripImageRefs && next.observation?.imageRef) delete next.observation.imageRef;

  return { event: next, hits: [...hits] };
}

/**
 * Render a wireframe SVG placeholder for a redacted screenshot. Never
 * embeds raw pixels. Use this as the default representation in any
 * inspector UI built on top of this package.
 */
export function redactedScreenshotSvg(opts: {
  width: number;
  height: number;
  regions?: RedactionRegion[];
  surfaceKind?: string;
}): string {
  const { width, height, regions = [], surfaceKind = "unknown" } = opts;
  const parts: string[] = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`  <rect width="100%" height="100%" fill="#1e293b" />`);
  parts.push(`  <text x="50%" y="50%" text-anchor="middle" fill="#94a3b8" font-family="monospace" font-size="14">REDACTED · ${surfaceKind}</text>`);
  for (const r of regions) {
    parts.push(`  <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#0f172a" stroke="#ef4444" stroke-width="2" />`);
    parts.push(`  <text x="${r.x + 4}" y="${r.y + 14}" fill="#fca5a5" font-family="monospace" font-size="10">PHI · ${r.reason}</text>`);
  }
  parts.push(`</svg>`);
  return parts.join("\n");
}
