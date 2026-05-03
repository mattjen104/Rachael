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
// BrowserExtensionAdapter — wraps `server/bridge-queue.ts`.
//
// The Chrome extension polls the queue on the server, executes jobs in the
// user's browser, and posts results back. Today's queue speaks an ad-hoc
// command shape (`type: "fetch" | "dom"`); the adapter speaks `Action` /
// `Observation` and the host's `BridgeQueueApi` is responsible for the
// translation. The wire payload is Zod-validated upstream against the
// `Action` / `Observation` schemas exported from this package — see the
// `cuAction` / `cuObservation` seams already added to `BridgeJob` /
// `BridgeResult`.
//
// Cost is reported as high (network + user's machine + extension runtime),
// and the adapter declares `requiresUserBrowser: true` in metadata so the
// router knows the policy allowlist applies.
// ---------------------------------------------------------------------------

export interface BridgeQueueApi {
  // Submit a typed action for the extension to execute. Returns the resulting
  // observation (or a partial one if the action does not naturally produce
  // an observation, e.g. Wait — host wraps that as a TextDump "ok").
  submit(action: Action): Promise<Observation | null>;
  // Request a fresh observation of the chosen kind. Host implementation
  // mirrors today's `dom` job for `DomSnapshot` and the new screenshot
  // pipeline for `RawScreenshot` / `SomScreenshot`.
  observe(kind: ObservationKind): Promise<Observation>;
  // Domain allowlist check — preserved from existing
  // `isBridgeOnlyDomain` policy.
  isAllowed?(url: string): boolean;
}

export interface BrowserExtensionAdapterOptions {
  id?: string;
  queue: BridgeQueueApi;
  // The router uses this to filter the surface out for non-allowlisted URLs.
  allowedDomains?: string[];
}

export class BrowserExtensionAdapter implements Surface {
  readonly descriptor: SurfaceDescriptor;
  private readonly queue: BridgeQueueApi;

  constructor(opts: BrowserExtensionAdapterOptions) {
    this.queue = opts.queue;
    this.descriptor = {
      id: opts.id ?? "browser-extension:default",
      kind: "browser-extension",
      label: "Chrome extension bridge",
      capabilities: ADAPTER_CAPABILITIES["browser-extension"].capabilities,
      metadata: {
        requiresUserBrowser: true,
        allowedDomains: opts.allowedDomains ?? [],
        transport: "extension-poll-queue",
      },
    };
  }

  async observe(kinds: ObservationKind[]): Promise<Observation[]> {
    const out: Observation[] = [];
    for (const kind of kinds) {
      if (!this.descriptor.capabilities.observations.includes(kind)) {
        throw new Error(`BrowserExtensionAdapter does not support observation: ${kind}`);
      }
      out.push(await this.queue.observe(kind));
    }
    return out;
  }

  async act(action: Action): Promise<ActResult> {
    if (action.verb === "Composite") {
      for (const step of action.steps) {
        const r = await this.act(step);
        if (!r.ok) return r;
      }
      return { ok: true };
    }
    if (action.verb === "Goto" && this.queue.isAllowed && !this.queue.isAllowed(action.url)) {
      return { ok: false, error: `URL not in extension allowlist: ${action.url}` };
    }
    try {
      const obs = await this.queue.submit(action);
      return { ok: true, observations: obs ? [obs] : undefined };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async verify(verifier: Verifier, observation?: Observation): Promise<VerifierResult> {
    const obs = observation ?? (await this.observe(["DomSnapshot"]))[0];
    switch (verifier.kind) {
      case "expectUrl": {
        const url = obs.kind === "DomSnapshot" ? obs.url ?? "" : "";
        const ok = (verifier.match ?? "contains") === "equals" ? url === verifier.url : url.includes(verifier.url);
        return { status: ok ? "pass" : "fail", evidence: url };
      }
      case "expectText": {
        const hay = obs.kind === "DomSnapshot" ? obs.text ?? "" : JSON.stringify(obs);
        const ok = hay.includes(verifier.text);
        return { status: ok ? "pass" : "fail", evidence: hay.slice(0, 200) };
      }
      case "expectHash":
        return { status: obs.digest === verifier.digest ? "pass" : "fail", observedDigest: obs.digest };
      case "expectNoChange":
        return { status: obs.digest === verifier.sinceDigest ? "pass" : "fail", observedDigest: obs.digest };
      default:
        return { status: "unknown", evidence: `verifier ${verifier.kind} not implemented by BrowserExtensionAdapter` };
    }
  }

  // Helper used by the host to derive a digest for a freshly-built
  // observation (so the queue->observation translator does not need to
  // re-import `digest`).
  static digest(input: string): string {
    return digest(input);
  }
}
