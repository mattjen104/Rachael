// Bootstrap that wires the four real surface adapters from
// `packages/cu-core/src/adapters/` onto a process-wide `ComputerUseBus`.
//
// Each adapter is constructed with a host-supplied facade so cu-core stays
// dependency-free (no Playwright, no pyautogui, no Citrix SDK in the package
// boundary). The facades here translate adapter calls into:
//
//   * BrowserExtensionAdapter → `server/bridge-queue.ts` extension queue
//                               (`makeExtensionBridgeQueueApi`)
//   * BrowserPlaywrightAdapter → `server/browser-bridge.ts` Playwright bridge
//                                (lazy: a tab is registered the first time
//                                cu-bus is asked for it)
//   * WindowsUiaAdapter        → `server/epic-agent-bus.ts` typed commands
//                                (the desktop epic-agent executes them)
//   * CitrixVisionAdapter      → same epic-agent-bus, plus Citrix-resilient
//                                IO that defers to the agent's SendInput path
//
// The bus is a singleton — there's only one process. `getCuBus()` returns
// it; `initCuBus()` is the boot-time call from `server/index.ts`.

import { ComputerUseBus } from "@rachael/cu-core";
import {
  BrowserExtensionAdapter,
  BrowserPlaywrightAdapter,
  CitrixVisionAdapter,
  WindowsUiaAdapter,
  type BrowserBridgeApi,
  type CitrixIoApi,
  type UiaClientApi,
} from "@rachael/cu-core";
import { makeExtensionBridgeQueueApi } from "./bridge-queue";
import * as epicAgentBus from "./epic-agent-bus";
import * as browserBridge from "./browser-bridge";

let bus: ComputerUseBus | null = null;
let initialized = false;
const playwrightSurfaces = new Map<string, BrowserPlaywrightAdapter>();

// ---------------------------------------------------------------------------
// UIA client — dispatches to the desktop epic-agent through the in-process
// command queue. Each method enqueues a typed command and awaits the
// agent's `/api/epic/agent/results` callback. The wire shape matches what
// `tools/epic_agent.py:execute_command` already understands.
// ---------------------------------------------------------------------------
function makeUiaClient(): UiaClientApi {
  async function send<T = unknown>(payload: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    // Stamp surfaceId so the Python side can attribute observations
    // back to the originating adapter (windows-uia:<env>) instead of
    // guessing from `env` alone.
    const env = (payload as { env?: string }).env ?? "SUP";
    const cmd = epicAgentBus.enqueueCommand({
      id: epicAgentBus.genCommandId("uia"),
      type: String(payload.type),
      surfaceId: `windows-uia:${env}`,
      ...payload,
    });
    const r = await epicAgentBus.awaitResult(cmd.id, timeoutMs);
    if (r.status === "error" || r.error) throw new Error(r.error || "epic-agent error");
    return (r.data ?? {}) as T;
  }
  return {
    async getUiaTree(env) {
      type UiaElement = {
        automationId?: string;
        controlType?: string;
        name?: string;
        hint?: string;
        rect?: { x: number; y: number; w: number; h: number; cx: number; cy: number };
      };
      const data = await send<{ window?: string; windowTitle?: string; elements?: UiaElement[] }>({
        type: "uia_tree",
        env,
      });
      const elements: UiaElement[] = Array.isArray(data?.elements) ? data.elements : [];
      return { windowTitle: data?.window || data?.windowTitle, elements };
    },
    async screenshot(env) {
      const cmd = epicAgentBus.enqueueCommand({
        id: epicAgentBus.genCommandId("uia"),
        type: "screenshot",
        env,
      });
      const r = await epicAgentBus.awaitResult(cmd.id, 30_000);
      if (r.status === "error" || r.error) throw new Error(r.error || "screenshot failed");
      // The screenshot is reachable via `/api/epic/agent/screenshot/<id>`;
      // we surface the command id as the imageRef so downstream consumers
      // (trajectory inspector, parity replay) can fetch it.
      return { imageRef: cmd.id };
    },
    async click(env, target) {
      if (target.uia) {
        // `tools/epic_agent.py::execute_click` reads `cmd.target` (vision
        // resolves the label to coords). Pass the UIA name/automationId
        // as the visible label so the same handler works for typed CU
        // calls as well as legacy `{type:"click", target}` callers.
        const label = target.uia.name || target.uia.automationId || "";
        await send({ type: "click", env, target: label });
        return { method: "uia" };
      }
      if (target.coords) {
        await send({ type: "cu_action", env, action: { verb: "Click", target: { kind: "coords", ...target.coords } } });
        return { method: "coords" };
      }
      throw new Error("UIA click requires uia or coords target");
    },
    async hint(env, hint, value) {
      // UIA hint flow: same vision-click handler. `value` (if present) is
      // forwarded so a downstream handler can chain a Type after the click.
      await send({ type: "click", env, target: hint, value });
      return { method: "uia" };
    },
    async type(env, text) {
      await send({ type: "cu_action", env, action: { verb: "Type", text } });
    },
    async key(env, chord) {
      await send({ type: "cu_action", env, action: { verb: "Key", chord } });
    },
    async scroll(env, dx, dy) {
      await send({ type: "cu_action", env, action: { verb: "Scroll", dx, dy } });
    },
  };
}

// ---------------------------------------------------------------------------
// Citrix IO — same epic-agent transport, but actions go through
// `cu_action` so the Python side dispatches via the Citrix-resilient
// SendInput path (see `execute_cu_action` in tools/epic_agent.py).
// ---------------------------------------------------------------------------
function makeCitrixIo(env = "SUP"): CitrixIoApi {
  async function send(payload: Record<string, unknown>, timeoutMs = 30_000) {
    // Citrix observations should be attributed to citrix-vision, not
    // the default windows-uia surface id used by `execute_cu_action`.
    const cmd = epicAgentBus.enqueueCommand({
      id: epicAgentBus.genCommandId("citrix"),
      type: String(payload.type),
      env,
      surfaceId: "citrix-vision:default",
      ...payload,
    });
    const r = await epicAgentBus.awaitResult(cmd.id, timeoutMs);
    if (r.status === "error" || r.error) throw new Error(r.error || "epic-agent error");
    return r;
  }
  return {
    async screenshot() {
      const r = await send({ type: "screenshot" });
      return { imageRef: r.commandId };
    },
    async click(target) {
      if (target.coords) {
        await send({ type: "cu_action", action: { verb: "Click", target: { kind: "coords", ...target.coords } } });
      } else if (target.mark) {
        await send({ type: "cu_action", action: { verb: "Click", target: { kind: "mark", mark: target.mark } } });
      } else {
        throw new Error("Citrix click requires coords or mark target");
      }
    },
    async hint(key, value) {
      // Citrix has no UIA tree — fall through to the same vision-click
      // handler the UIA path uses, which expects `target` (label string).
      await send({ type: "click", target: key, value });
    },
    async type(text) {
      await send({ type: "cu_action", action: { verb: "Type", text } });
    },
    async key(chord) {
      await send({ type: "cu_action", action: { verb: "Key", chord } });
    },
  };
}

// ---------------------------------------------------------------------------
// Playwright bridge facade. We don't keep a Playwright handle inside cu-core,
// so we wrap `server/browser-bridge.ts`'s page-keyed helpers behind the
// `BrowserBridgeApi` shape the adapter expects. `screenshot` returns the
// raw PNG buffer base64-encoded as the imageRef (cheap, in-memory).
// ---------------------------------------------------------------------------
function makePlaywrightBridge(): BrowserBridgeApi {
  return {
    async getPageContent(pageId) {
      const c = await browserBridge.getPageContent(pageId);
      if (!c) throw new Error(`Playwright page not open: ${pageId}`);
      // `BrowserBridgeApi.getPageContent` requires `tag` and `text` to be
      // present on every element; the in-process `browser-bridge` returns
      // a looser shape, so we normalize here rather than casting.
      const elements = (c.elements ?? []).map((e: { tag?: string; text?: string; role?: string; href?: string; type?: string }) => ({
        tag: e.tag ?? "",
        text: e.text ?? "",
        role: e.role,
        href: e.href,
        type: e.type,
      }));
      return { title: c.title, url: c.url, text: c.text, elements };
    },
    async screenshot(pageId) {
      const buf = await browserBridge.takeScreenshot(pageId);
      if (!buf) throw new Error(`Playwright screenshot failed: ${pageId}`);
      return { imageRef: `data:image/png;base64,${buf.toString("base64")}` };
    },
    async click(pageId, target) {
      if (target.selector) {
        const ok = await browserBridge.clickElement(pageId, target.selector);
        if (!ok) throw new Error(`click failed: ${target.selector}`);
      } else {
        throw new Error("Playwright click requires a selector (coords not yet wired)");
      }
    },
    async type(pageId, text, target) {
      const sel = target?.selector ?? "body";
      const ok = await browserBridge.typeInPage(pageId, sel, text);
      if (!ok) throw new Error(`type failed in ${sel}`);
    },
    async key(pageId, chord) {
      const ok = await browserBridge.pressKey(pageId, chord);
      if (!ok) throw new Error(`key failed: ${chord}`);
    },
    async scroll(pageId, dx, dy) {
      const page = browserBridge.getPage(pageId);
      if (!page) throw new Error(`Playwright page not open: ${pageId}`);
      await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx ?? 0, dy ?? 0]);
    },
    async goto(pageId, url) {
      const r = await browserBridge.openPage(pageId, url);
      if (!r.success) throw new Error(r.error || "goto failed");
    },
    async wait(_pageId, ms) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
export function initCuBus(): ComputerUseBus {
  if (bus) return bus;
  bus = new ComputerUseBus();

  // BrowserExtensionAdapter: always available — the queue exists even if no
  // extension is currently connected (the adapter just times out).
  const extQueue = makeExtensionBridgeQueueApi({
    surfaceId: "browser-extension:default",
    submittedBy: "cu-bus",
  });
  bus.registerSurface(
    new BrowserExtensionAdapter({
      id: "browser-extension:default",
      queue: extQueue,
    }),
  );

  // BrowserPlaywrightAdapter: register a default surface eagerly so the
  // bus advertises all four kinds at boot. The underlying `browser-bridge`
  // page may not be open yet — calls will throw with a clear "page not
  // open" error until `openPage` is invoked. Additional pages can be
  // registered on-demand via `ensurePlaywrightSurface(pageId)`.
  ensurePlaywrightSurfaceInternal(bus, "default");

  // WindowsUiaAdapter and CitrixVisionAdapter: registered eagerly. When the
  // epic-agent isn't connected, calls will time out via `awaitResult`.
  bus.registerSurface(
    new WindowsUiaAdapter({ id: "windows-uia:SUP", env: "SUP", client: makeUiaClient() }),
  );
  bus.registerSurface(
    new CitrixVisionAdapter({ id: "citrix-vision:default", io: makeCitrixIo("SUP") }),
  );

  initialized = true;
  return bus;
}

export function getCuBus(): ComputerUseBus {
  if (!bus) return initCuBus();
  return bus;
}

export function isCuBusInitialized(): boolean {
  return initialized;
}

function ensurePlaywrightSurfaceInternal(target: ComputerUseBus, pageId: string): string {
  const surfaceId = `browser-playwright:${pageId}`;
  if (playwrightSurfaces.has(surfaceId)) return surfaceId;
  const adapter = new BrowserPlaywrightAdapter({
    id: surfaceId,
    pageId,
    bridge: makePlaywrightBridge(),
  });
  target.registerSurface(adapter);
  playwrightSurfaces.set(surfaceId, adapter);
  return surfaceId;
}

// Public lazy registration: callers (e.g. `/api/cu/*` routes that just
// opened a Playwright page) can ensure a per-page surface exists.
export function ensurePlaywrightSurface(pageId: string): string {
  return ensurePlaywrightSurfaceInternal(getCuBus(), pageId);
}
