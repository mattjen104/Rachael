import type { SomDetectorClient } from "../../adapters/citrix-vision/index";

// Thin TS client for the local som-detector service. Designed to be passed
// into both the Citrix and browser-Playwright adapters as their
// `somDetector` argument.

export interface SomDetectorHttpOptions {
  baseUrl?: string;
  // Wall-clock cap per detect call. The router should treat a slow detector
  // as "down" rather than block the dispatch loop.
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SomDetectorHttpClient implements SomDetectorClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SomDetectorHttpOptions = {}) {
    this.baseUrl = opts.baseUrl ?? `http://127.0.0.1:${process.env.SOM_DETECTOR_PORT || 8765}`;
    this.timeoutMs = opts.timeoutMs ?? 4000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.withTimeout((sig) => this.fetchImpl(`${this.baseUrl}/health`, { signal: sig }));
      return res.ok;
    } catch {
      return false;
    }
  }

  async detect(imageRef: string): Promise<Array<{ mark: string; rect: { x: number; y: number; w: number; h: number }; label?: string }>> {
    // `imageRef` is expected to be a base64 PNG (the Citrix adapter's IO
    // layer already provides this shape today). Callers can also pass a
    // `data:image/png;base64,...` URI; we strip the prefix.
    const image = imageRef.startsWith("data:") ? imageRef.split(",", 2)[1] ?? "" : imageRef;
    const res = await this.withTimeout((sig) =>
      this.fetchImpl(`${this.baseUrl}/detect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image }),
        signal: sig,
      }),
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { marks?: Array<{ mark: string; rect: { x: number; y: number; w: number; h: number }; label?: string }> };
    return Array.isArray(data?.marks) ? data.marks : [];
  }

  private async withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      return await fn(ctrl.signal);
    } finally {
      clearTimeout(t);
    }
  }
}
