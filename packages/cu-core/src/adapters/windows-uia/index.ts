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
// WindowsUiaAdapter — wraps the UIA-tree path inside `tools/epic_agent.py`.
//
// The adapter is the TS-side handle; the Python agent is the actual driver.
// Communication goes through a `UiaClientApi` (typically the existing
// command-bus or an HTTP shim the host wires up). This avoids importing
// Python from Node and keeps the wire format Zod-validated.
//
// UIA-first / coords-fallback policy is reported via `details.method`
// returned in `ActResult` so the router can attribute cost correctly:
// "uia" hits stay cheap; "coords" fallbacks should bump cost in the
// router's view.
// ---------------------------------------------------------------------------

export interface UiaClientApi {
  // Read the UIA tree of a window (pywinauto walker).
  getUiaTree(env: string): Promise<{
    windowTitle?: string;
    elements: Array<{
      automationId?: string;
      controlType?: string;
      name?: string;
      hint?: string;
      rect?: { x: number; y: number; w: number; h: number; cx: number; cy: number };
    }>;
  }>;
  screenshot(env: string): Promise<{ imageRef: string; width?: number; height?: number }>;
  click(env: string, target: { uia?: { automationId?: string; controlType?: string; name?: string }; coords?: { x: number; y: number } }): Promise<{ method: "uia" | "coords" }>;
  hint(env: string, hint: string, value?: string): Promise<{ method: "uia" | "coords" }>;
  type(env: string, text: string): Promise<void>;
  key(env: string, chord: string): Promise<void>;
  scroll(env: string, dx: number, dy: number): Promise<void>;
}

export interface WindowsUiaAdapterOptions {
  id?: string;
  env: string;
  client: UiaClientApi;
}

export class WindowsUiaAdapter implements Surface {
  readonly descriptor: SurfaceDescriptor;
  private readonly client: UiaClientApi;
  private readonly env: string;

  constructor(opts: WindowsUiaAdapterOptions) {
    this.client = opts.client;
    this.env = opts.env;
    this.descriptor = {
      id: opts.id ?? `windows-uia:${opts.env}`,
      kind: "desktop-window",
      label: `Windows UIA (${opts.env})`,
      capabilities: ADAPTER_CAPABILITIES["windows-uia"].capabilities,
      metadata: { env: opts.env, transport: "epic-agent-bridge" },
    };
  }

  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    const out: Observation[] = [];
    const ts = Date.now();
    for (const kind of kinds) {
      if (kind === "UiaTree") {
        const tree = await this.client.getUiaTree(this.env);
        out.push({
          kind: "UiaTree",
          surfaceId: this.descriptor.id,
          timestamp: ts,
          digest: digest(JSON.stringify(tree).slice(0, 8192)),
          windowTitle: tree.windowTitle,
          elements: tree.elements,
        });
      } else if (kind === "RawScreenshot") {
        const shot = await this.client.screenshot(this.env);
        out.push({
          kind: "RawScreenshot",
          surfaceId: this.descriptor.id,
          timestamp: ts,
          digest: digest(shot.imageRef),
          imageRef: shot.imageRef,
          width: shot.width,
          height: shot.height,
        });
      } else {
        throw new Error(`WindowsUiaAdapter does not support observation: ${kind}`);
      }
    }
    return out;
  }

  async act(action: Action): Promise<ActResult> {
    try {
      switch (action.verb) {
        case "Click": {
          const t = action.target;
          if (t.kind === "uia") {
            const r = await this.client.click(this.env, { uia: { automationId: t.automationId, controlType: t.controlType, name: t.name } });
            return { ok: true, details: { method: r.method } };
          }
          if (t.kind === "coords") {
            const r = await this.client.click(this.env, { coords: { x: t.x, y: t.y } });
            return { ok: true, details: { method: r.method } };
          }
          if (t.kind === "hint") {
            const r = await this.client.hint(this.env, t.key);
            return { ok: true, details: { method: r.method } };
          }
          return { ok: false, error: `Unsupported locator for UIA click: ${t.kind}` };
        }
        case "Hint": {
          const r = await this.client.hint(this.env, action.hint, action.value);
          return { ok: true, details: { method: r.method } };
        }
        case "Type":
          await this.client.type(this.env, action.text);
          return { ok: true };
        case "Key":
          await this.client.key(this.env, action.chord);
          return { ok: true };
        case "Scroll":
          await this.client.scroll(this.env, action.dx ?? 0, action.dy ?? 0);
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
          return { ok: false, error: `WindowsUiaAdapter does not support verb: ${(action as Action).verb}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe(["UiaTree"]))[0];
    switch (verifier.kind) {
      case "expectElement": {
        if (verifier.target.kind !== "uia" || obs.kind !== "UiaTree") {
          return { status: "unknown", evidence: "expectElement requires uia locator + UiaTree observation" };
        }
        const want = verifier.target;
        const found = obs.elements.some(
          (e) =>
            (!want.automationId || e.automationId === want.automationId) &&
            (!want.controlType || e.controlType === want.controlType) &&
            (!want.name || e.name === want.name),
        );
        const expected = verifier.present ?? true;
        return { status: found === expected ? "pass" : "fail", evidence: `found=${found}` };
      }
      case "expectText": {
        const hay = obs.kind === "UiaTree" ? obs.elements.map((e) => e.name ?? "").join(" ") : JSON.stringify(obs);
        const ok = hay.includes(verifier.text);
        return { status: ok ? "pass" : "fail", evidence: hay.slice(0, 200) };
      }
      case "expectHash":
        return { status: obs.digest === verifier.digest ? "pass" : "fail", observedDigest: obs.digest };
      case "expectNoChange":
        return { status: obs.digest === verifier.sinceDigest ? "pass" : "fail", observedDigest: obs.digest };
      default:
        return { status: "unknown", evidence: `verifier ${verifier.kind} not implemented by WindowsUiaAdapter` };
    }
  }
}
