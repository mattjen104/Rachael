import type { Surface, ActResult } from "../../bus";
import { digest } from "../../digest";
import type {
  Action,
  Observation,
  ObservationKind,
  SurfaceDescriptor,
  Verifier,
  VerifierResult,
} from "../../types";
import { ADAPTER_CAPABILITIES } from "../capabilities";

// ---------------------------------------------------------------------------
// CitrixVisionAdapter — wraps the screenshot + hint path used to drive
// Hyperspace under Citrix.
//
// Vision-only by design. Hyperspace inside Citrix exposes no usable UIA or
// DOM tree to the local OS, so this adapter only emits `SomScreenshot`
// (primary, OmniParser-class) and `RawScreenshot` (fallback). Actions are
// limited to `Hint` (vim-overlay key), `Click` (coords or element mark),
// `Key`, and `Type` (the latter going through the existing Citrix-resilient
// SendInput path — we wrap it, we do not touch it).
//
// SoM detection degrades gracefully:
//   1. Try `somDetector.detect(image)` — primary.
//   2. If that returns no marks (or throws), fall back to
//      `hintProvider.overlay(image)` — the existing OCR/vim hint overlay.
//   3. If both are unavailable, emit a `RawScreenshot` instead. The
//      trajectory inspector will see the missing marks.
// A dev toggle `forceHintsOnly: true` skips step 1 entirely for A/B work.
// ---------------------------------------------------------------------------

export interface SomDetectorClient {
  detect(imageRef: string): Promise<Array<{ mark: string; rect: { x: number; y: number; w: number; h: number }; label?: string }>>;
  // The router uses this to short-circuit calls when the service is known
  // down; the Citrix adapter still tolerates a thrown `detect`.
  isHealthy?(): Promise<boolean>;
}

export interface HintProvider {
  overlay(imageRef: string): Promise<Array<{ mark: string; rect: { x: number; y: number; w: number; h: number }; label?: string }>>;
}

export interface CitrixIoApi {
  screenshot(): Promise<{ imageRef: string; width?: number; height?: number }>;
  // Click goes through the Citrix-resilient SendInput path the existing
  // agent already implements; the adapter never touches that path directly.
  click(target: { coords?: { x: number; y: number }; mark?: string }): Promise<void>;
  // Hint-key activation uses the same SendInput path; `value` lets the
  // overlay type into a focused field after activating it.
  hint(key: string, value?: string): Promise<void>;
  type(text: string): Promise<void>;
  key(chord: string): Promise<void>;
}

export interface CitrixVisionAdapterOptions {
  id?: string;
  io: CitrixIoApi;
  somDetector?: SomDetectorClient;
  hintProvider?: HintProvider;
  forceHintsOnly?: boolean;
  // Confidence below which SoM falls back to vim-hints. The detector itself
  // is the authority; this is the adapter's escape hatch when the detector
  // returns marks but flags low confidence (signaled by an empty array).
  minSomMarks?: number;
}

export class CitrixVisionAdapter implements Surface {
  readonly descriptor: SurfaceDescriptor;
  private readonly io: CitrixIoApi;
  private readonly somDetector?: SomDetectorClient;
  private readonly hintProvider?: HintProvider;
  private readonly forceHintsOnly: boolean;
  private readonly minSomMarks: number;

  constructor(opts: CitrixVisionAdapterOptions) {
    this.io = opts.io;
    this.somDetector = opts.somDetector;
    this.hintProvider = opts.hintProvider;
    this.forceHintsOnly = !!opts.forceHintsOnly;
    this.minSomMarks = opts.minSomMarks ?? 1;
    this.descriptor = {
      id: opts.id ?? "citrix-vision:default",
      kind: "citrix-session",
      label: "Citrix vision (Hyperspace)",
      capabilities: ADAPTER_CAPABILITIES["citrix-vision"].capabilities,
      metadata: {
        forceHintsOnly: this.forceHintsOnly,
        somDetectorAvailable: !!this.somDetector,
        hintProviderAvailable: !!this.hintProvider,
      },
    };
  }

  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    const out: Observation[] = [];
    const ts = Date.now();
    for (const kind of kinds) {
      if (kind === "RawScreenshot") {
        const shot = await this.io.screenshot();
        out.push({
          kind: "RawScreenshot",
          surfaceId: this.descriptor.id,
          timestamp: ts,
          digest: digest(shot.imageRef),
          imageRef: shot.imageRef,
          width: shot.width,
          height: shot.height,
        });
        continue;
      }
      if (kind === "SomScreenshot") {
        const shot = await this.io.screenshot();
        let marks: Array<{ mark: string; rect: { x: number; y: number; w: number; h: number }; label?: string }> = [];
        let source: "som" | "hints" | "none" = "none";

        if (!this.forceHintsOnly && this.somDetector) {
          try {
            marks = await this.somDetector.detect(shot.imageRef);
            if (marks.length >= this.minSomMarks) source = "som";
            else marks = [];
          } catch {
            marks = [];
          }
        }
        if (marks.length === 0 && this.hintProvider) {
          try {
            marks = await this.hintProvider.overlay(shot.imageRef);
            if (marks.length > 0) source = "hints";
          } catch {
            marks = [];
          }
        }

        if (marks.length === 0) {
          // Degrade to RawScreenshot — visible in the trajectory inspector.
          out.push({
            kind: "RawScreenshot",
            surfaceId: this.descriptor.id,
            timestamp: ts,
            digest: digest(shot.imageRef + ":raw-degraded"),
            imageRef: shot.imageRef,
            width: shot.width,
            height: shot.height,
          });
        } else {
          out.push({
            kind: "SomScreenshot",
            surfaceId: this.descriptor.id,
            timestamp: ts,
            digest: digest(`${shot.imageRef}:${source}:${marks.length}`),
            imageRef: shot.imageRef,
            marks,
          });
        }
        continue;
      }
      throw new Error(`CitrixVisionAdapter does not support observation: ${kind}`);
    }
    return out;
  }

  async act(action: Action): Promise<ActResult> {
    try {
      switch (action.verb) {
        case "Hint":
          await this.io.hint(action.hint, action.value);
          return { ok: true };
        case "Click": {
          const t = action.target;
          if (t.kind === "coords") {
            await this.io.click({ coords: { x: t.x, y: t.y } });
            return { ok: true };
          }
          if (t.kind === "mark") {
            await this.io.click({ mark: t.mark });
            return { ok: true };
          }
          if (t.kind === "hint") {
            await this.io.hint(t.key);
            return { ok: true };
          }
          return { ok: false, error: `Unsupported locator for citrix click: ${t.kind}` };
        }
        case "Type":
          await this.io.type(action.text);
          return { ok: true };
        case "Key":
          await this.io.key(action.chord);
          return { ok: true };
        case "Wait":
          await new Promise((r) => setTimeout(r, action.ms ?? 0));
          return { ok: true };
        case "Composite": {
          for (const step of action.steps) {
            const r = await this.act(step);
            if (!r.ok) return r;
          }
          return { ok: true };
        }
        default:
          return { ok: false, error: `CitrixVisionAdapter does not support verb: ${(action as Action).verb}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe(["SomScreenshot"]))[0];
    switch (verifier.kind) {
      case "expectImageRegion": {
        if (verifier.expectedDigest === undefined) {
          return { status: "unknown", evidence: "no expectedDigest provided" };
        }
        return {
          status: obs.digest === verifier.expectedDigest ? "pass" : "fail",
          observedDigest: obs.digest,
        };
      }
      case "expectHash":
        return { status: obs.digest === verifier.digest ? "pass" : "fail", observedDigest: obs.digest };
      case "expectNoChange":
        return { status: obs.digest === verifier.sinceDigest ? "pass" : "fail", observedDigest: obs.digest };
      case "expectElement": {
        const target = verifier.target;
        if (target.kind === "mark" && obs.kind === "SomScreenshot") {
          const found = obs.marks.some((m) => m.mark === target.mark);
          const expected = verifier.present ?? true;
          return { status: found === expected ? "pass" : "fail", evidence: `found=${found}` };
        }
        return { status: "unknown", evidence: "expectElement on Citrix requires mark locator + SomScreenshot" };
      }
      default:
        return { status: "unknown", evidence: `verifier ${verifier.kind} not implemented by CitrixVisionAdapter` };
    }
  }
}
