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
// BrowserPlaywrightAdapter — wraps `server/browser-bridge.ts`.
//
// We do not import `server/browser-bridge.ts` directly: that would pull
// Playwright into every consumer of `@rachael/cu-core`. Instead we accept
// a small typed facade (`BrowserBridgeApi`) and the host application wires
// it in (`new BrowserPlaywrightAdapter({ bridge: makeBridge() })`).
//
// New capability: `AxTree` via CDP `Accessibility.getFullAXTree`. The
// existing bridge does not expose this, so the facade provides
// `getAxTree(pageId)` which the host is expected to implement on top of
// `page.context().newCDPSession(page)`.
// ---------------------------------------------------------------------------

export interface BrowserBridgeApi {
  getPageContent(pageId: string): Promise<{
    title: string;
    url: string;
    text: string;
    elements: Array<{ tag: string; text: string; role?: string; href?: string; type?: string }>;
  }>;
  getAxTree?(pageId: string): Promise<unknown>;
  screenshot?(pageId: string): Promise<{ imageRef: string; width?: number; height?: number }>;
  click(pageId: string, target: { selector?: string; x?: number; y?: number }): Promise<void>;
  type(pageId: string, text: string, target?: { selector?: string }, clearFirst?: boolean): Promise<void>;
  key(pageId: string, chord: string): Promise<void>;
  scroll(pageId: string, dx: number, dy: number): Promise<void>;
  goto(pageId: string, url: string): Promise<void>;
  wait(pageId: string, ms: number): Promise<void>;
}

export interface BrowserPlaywrightAdapterOptions {
  id?: string;
  pageId: string;
  bridge: BrowserBridgeApi;
  somDetector?: { detect(imageRef: string): Promise<Array<{ mark: string; rect: { x: number; y: number; w: number; h: number }; label?: string }>> };
}

export class BrowserPlaywrightAdapter implements Surface {
  readonly descriptor: SurfaceDescriptor;
  private readonly bridge: BrowserBridgeApi;
  private readonly pageId: string;
  private readonly somDetector?: BrowserPlaywrightAdapterOptions["somDetector"];

  constructor(opts: BrowserPlaywrightAdapterOptions) {
    this.bridge = opts.bridge;
    this.pageId = opts.pageId;
    this.somDetector = opts.somDetector;
    this.descriptor = {
      id: opts.id ?? `browser-playwright:${opts.pageId}`,
      kind: "browser-tab",
      label: `Playwright tab ${opts.pageId}`,
      capabilities: ADAPTER_CAPABILITIES["browser-playwright"].capabilities,
      metadata: { pageId: opts.pageId, transport: "playwright" },
    };
  }

  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    const out: Observation[] = [];
    const ts = Date.now();
    for (const kind of kinds) {
      switch (kind) {
        case "DomSnapshot": {
          const c = await this.bridge.getPageContent(this.pageId);
          out.push({
            kind: "DomSnapshot",
            surfaceId: this.descriptor.id,
            timestamp: ts,
            digest: digest(`${c.url}|${c.title}|${c.text.slice(0, 4096)}`),
            url: c.url,
            title: c.title,
            text: c.text,
            elements: c.elements,
          });
          break;
        }
        case "AxTree": {
          if (!this.bridge.getAxTree) {
            throw new Error("BrowserBridgeApi.getAxTree not provided by host");
          }
          const root = await this.bridge.getAxTree(this.pageId);
          out.push({
            kind: "AxTree",
            surfaceId: this.descriptor.id,
            timestamp: ts,
            digest: digest(JSON.stringify(root).slice(0, 8192)),
            root,
          });
          break;
        }
        case "RawScreenshot": {
          if (!this.bridge.screenshot) {
            throw new Error("BrowserBridgeApi.screenshot not provided by host");
          }
          const shot = await this.bridge.screenshot(this.pageId);
          out.push({
            kind: "RawScreenshot",
            surfaceId: this.descriptor.id,
            timestamp: ts,
            digest: digest(shot.imageRef),
            imageRef: shot.imageRef,
            width: shot.width,
            height: shot.height,
          });
          break;
        }
        case "SomScreenshot": {
          if (!this.bridge.screenshot) {
            throw new Error("BrowserBridgeApi.screenshot not provided by host");
          }
          const shot = await this.bridge.screenshot(this.pageId);
          // SoM marking degrades to RawScreenshot if the detector is down.
          const marks = this.somDetector
            ? await this.somDetector.detect(shot.imageRef).catch(() => [])
            : [];
          if (marks.length === 0) {
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
            out.push({
              kind: "SomScreenshot",
              surfaceId: this.descriptor.id,
              timestamp: ts,
              digest: digest(shot.imageRef + ":" + marks.length),
              imageRef: shot.imageRef,
              marks,
            });
          }
          break;
        }
        default:
          throw new Error(`BrowserPlaywrightAdapter does not support observation: ${kind}`);
      }
    }
    return out;
  }

  async act(action: Action): Promise<ActResult> {
    try {
      switch (action.verb) {
        case "Click": {
          const t = action.target;
          if (t.kind === "selector") await this.bridge.click(this.pageId, { selector: t.css });
          else if (t.kind === "coords") await this.bridge.click(this.pageId, { x: t.x, y: t.y });
          else return { ok: false, error: `Unsupported locator for browser click: ${t.kind}` };
          return { ok: true };
        }
        case "Type": {
          const sel = action.target?.kind === "selector" ? { selector: action.target.css } : undefined;
          await this.bridge.type(this.pageId, action.text, sel, action.clearFirst);
          return { ok: true };
        }
        case "Key":
          await this.bridge.key(this.pageId, action.chord);
          return { ok: true };
        case "Scroll":
          await this.bridge.scroll(this.pageId, action.dx ?? 0, action.dy ?? 0);
          return { ok: true };
        case "Goto":
          await this.bridge.goto(this.pageId, action.url);
          return { ok: true };
        case "Wait":
          await this.bridge.wait(this.pageId, action.ms ?? 0);
          return { ok: true };
        case "Composite": {
          for (const step of action.steps) {
            const r = await this.act(step);
            if (!r.ok) return r;
          }
          return { ok: true };
        }
        default:
          return { ok: false, error: `BrowserPlaywrightAdapter does not support verb: ${(action as Action).verb}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe(["DomSnapshot"]))[0];
    const dom = obs.kind === "DomSnapshot" ? obs : null;
    switch (verifier.kind) {
      case "expectUrl": {
        if (!dom?.url) return { status: "unknown", evidence: "no url in observation" };
        const ok = (verifier.match ?? "contains") === "equals" ? dom.url === verifier.url : dom.url.includes(verifier.url);
        return { status: ok ? "pass" : "fail", evidence: dom.url };
      }
      case "expectText": {
        const hay = dom?.text ?? JSON.stringify(obs);
        const ok = hay.includes(verifier.text);
        return { status: ok ? "pass" : "fail", evidence: hay.slice(0, 200) };
      }
      case "expectHash":
        return { status: obs.digest === verifier.digest ? "pass" : "fail", observedDigest: obs.digest };
      case "expectNoChange":
        return { status: obs.digest === verifier.sinceDigest ? "pass" : "fail", observedDigest: obs.digest };
      default:
        return { status: "unknown", evidence: `verifier ${verifier.kind} not implemented by BrowserPlaywrightAdapter` };
    }
  }
}
