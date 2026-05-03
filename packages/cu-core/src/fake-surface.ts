import type { Surface, ActResult } from "./bus";
import { digest } from "./digest";
import type {
  Action,
  Observation,
  ObservationKind,
  SurfaceDescriptor,
  Verifier,
  VerifierResult,
} from "./types";

// ---------------------------------------------------------------------------
// FakeSurface — a tiny in-memory Surface used by the README example and by
// tests. It models a one-page "form" with a text field and a submit button.
// ---------------------------------------------------------------------------

export interface FakeSurfaceState {
  url: string;
  fieldText: string;
  submitted: boolean;
}

export class FakeSurface implements Surface {
  readonly descriptor: SurfaceDescriptor;
  private state: FakeSurfaceState = { url: "fake://form", fieldText: "", submitted: false };

  constructor(id = "fake-1") {
    this.descriptor = {
      id,
      kind: "fake",
      label: "Fake form surface",
      capabilities: {
        observations: ["DomSnapshot", "TextDump"],
        actions: ["Click", "Type", "Goto", "Wait"],
        locators: ["selector", "hint"],
        cost: { observe: 0, act: 0 },
      },
    };
  }

  private snapshot(kind: ObservationKind): Observation {
    const text = `url=${this.state.url} field="${this.state.fieldText}" submitted=${this.state.submitted}`;
    const base = { surfaceId: this.descriptor.id, timestamp: Date.now(), digest: digest(text) };
    if (kind === "TextDump") return { ...base, kind: "TextDump", text };
    if (kind === "DomSnapshot") {
      return {
        ...base,
        kind: "DomSnapshot",
        url: this.state.url,
        title: "Fake Form",
        text,
        elements: [
          { tag: "input", text: this.state.fieldText, type: "text" },
          { tag: "button", text: "Submit" },
        ],
      };
    }
    throw new Error(`FakeSurface does not support observation kind: ${kind}`);
  }

  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    const supported = this.descriptor.capabilities.observations;
    for (const k of kinds) {
      if (!supported.includes(k)) {
        throw new Error(`FakeSurface does not support observation kind: ${k}`);
      }
    }
    return kinds.map((k) => this.snapshot(k));
  }

  async act(action: Action): Promise<ActResult> {
    switch (action.verb) {
      case "Goto":
        this.state = { url: action.url, fieldText: "", submitted: false };
        return { ok: true };
      case "Type":
        this.state.fieldText = action.clearFirst ? action.text : this.state.fieldText + action.text;
        return { ok: true };
      case "Click":
        this.state.submitted = true;
        return { ok: true };
      case "Wait":
        return { ok: true };
      default:
        return { ok: false, error: `FakeSurface does not support verb: ${action.verb}` };
    }
  }

  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe(["TextDump"]))[0];
    const text = obs.kind === "TextDump" ? obs.text : JSON.stringify(obs);
    switch (verifier.kind) {
      case "expectText": {
        const ok = text.includes(verifier.text);
        return { status: ok ? "pass" : "fail", evidence: text };
      }
      case "expectUrl": {
        const ok = this.state.url.includes(verifier.url);
        return { status: ok ? "pass" : "fail", evidence: this.state.url };
      }
      case "expectHash":
        return { status: obs.digest === verifier.digest ? "pass" : "fail", observedDigest: obs.digest };
      case "expectNoChange":
        return { status: obs.digest === verifier.sinceDigest ? "pass" : "fail", observedDigest: obs.digest };
      default:
        return { status: "unknown", evidence: `verifier ${verifier.kind} not implemented by FakeSurface` };
    }
  }
}
