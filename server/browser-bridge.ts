import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import path from "path";
import os from "os";
import fs from "fs";
import { exec } from "child_process";
import { emitEvent } from "./event-bus";

function safeEvaluate<T>(page: Page, fn: (...args: any[]) => T, ...args: any[]): Promise<T> {
  const fnStr = fn.toString();
  const wrapper = `(function(__name) { return (${fnStr})(${args.map(a => JSON.stringify(a)).join(', ')}); })(function(t){return t})`;
  return page.evaluate(wrapper);
}

const USER_DATA_DIR = path.join(os.homedir(), ".rachael", "browser-data");
const STORAGE_STATE_PATH = path.join(USER_DATA_DIR, "storage-state.json");

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let pages: Map<string, Page> = new Map();
let loginInProgress = false;
let browserIsVisible = false;
let lastLaunchError: string | null = null;
let sessionAuthState: "unknown" | "authenticated" | "login_required" | "expired" = "unknown";
let loginPollingActive = false;
let loginTransitioning = false;

export interface PageContent {
  title: string;
  url: string;
  text: string;
  elements: ExtractedElement[];
}

export interface ExtractedElement {
  tag: string;
  text: string;
  role?: string;
  href?: string;
  type?: string;
}

export interface BridgeStatus {
  running: boolean;
  pageCount: number;
  pages: Array<{ id: string; title: string; url: string }>;
  loginInProgress: boolean;
  visible: boolean;
  authState: string;
  lastError: string | null;
}

export interface BridgeDiagnostics {
  playwrightInstalled: boolean;
  chromiumInstalled: boolean;
  chromiumPath: string | null;
  hasDisplay: boolean;
  hasSavedSession: boolean;
  sessionAge: string | null;
  browserRunning: boolean;
  lastError: string | null;
  authState: string;
  platform: string;
  fixInstructions: string[];
}

function getContextOptions(): any {
  const opts: any = {
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  };

  if (fs.existsSync(STORAGE_STATE_PATH)) {
    try {
      const stateData = fs.readFileSync(STORAGE_STATE_PATH, "utf-8");
      JSON.parse(stateData);
      opts.storageState = STORAGE_STATE_PATH;
    } catch (err) {
      console.warn("[bridge] Saved session state is corrupted, starting fresh:", (err as Error).message);
    }
  }

  return opts;
}

function getChromiumPath(): string | null {
  try {
    const browserPath = chromium.executablePath();
    if (fs.existsSync(browserPath)) return browserPath;
  } catch {}

  const commonPaths = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/snap/bin/chromium",
  ];
  if (process.platform === "win32") {
    commonPaths.push(
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "Application", "chrome.exe"),
    );
  }
  for (const p of commonPaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function checkBridgeDiagnostics(): Promise<BridgeDiagnostics> {
  const platform = `${process.platform} (${os.arch()})`;
  const fixInstructions: string[] = [];

  let playwrightInstalled = false;
  try {
    require.resolve("playwright");
    playwrightInstalled = true;
  } catch {}

  const chromiumPath = getChromiumPath();
  const chromiumInstalled = chromiumPath !== null;

  if (!playwrightInstalled) {
    fixInstructions.push("Run: npm install playwright");
  }
  if (!chromiumInstalled) {
    fixInstructions.push("Run: npx playwright install chromium");
    fixInstructions.push("This downloads the Chromium browser used to scrape Outlook/Teams.");
  }

  let hasDisplay = true;
  if (process.platform !== "win32") {
    hasDisplay = !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
    if (!hasDisplay) {
      fixInstructions.push("No display detected. Headless mode will be used.");
    }
  }

  let hasSavedSession = false;
  let sessionAge: string | null = null;
  if (fs.existsSync(STORAGE_STATE_PATH)) {
    try {
      const stateData = fs.readFileSync(STORAGE_STATE_PATH, "utf-8");
      const parsed = JSON.parse(stateData);
      if (parsed.cookies && parsed.cookies.length > 0) {
        hasSavedSession = true;
        const stat = fs.statSync(STORAGE_STATE_PATH);
        const ageMs = Date.now() - stat.mtimeMs;
        const ageHours = Math.round(ageMs / 3600000);
        if (ageHours < 1) {
          sessionAge = "less than 1 hour ago";
        } else if (ageHours < 24) {
          sessionAge = `${ageHours} hour${ageHours === 1 ? "" : "s"} ago`;
        } else {
          const ageDays = Math.round(ageHours / 24);
          sessionAge = `${ageDays} day${ageDays === 1 ? "" : "s"} ago`;
        }
        if (ageHours > 168) {
          fixInstructions.push("Saved session is over 7 days old and may be expired.");
        }
      } else {
        fixInstructions.push("Saved session exists but has no cookies.");
      }
    } catch {
      fixInstructions.push("Saved session file is corrupted. It will be replaced on next login.");
    }
  } else {
    fixInstructions.push("No saved session found. Use Login to sign in for the first time.");
  }

  if (chromiumInstalled && hasSavedSession && fixInstructions.length === 0) {
    fixInstructions.push("Everything looks good! Trigger a scrape to pull data.");
  }

  return {
    playwrightInstalled,
    chromiumInstalled,
    chromiumPath,
    hasDisplay,
    hasSavedSession,
    sessionAge,
    browserRunning: !!(browser && browser.isConnected()),
    lastError: lastLaunchError,
    authState: sessionAuthState,
    platform,
    fixInstructions,
  };
}

export async function detectAuthState(page: Page, service: "outlook" | "teams"): Promise<"authenticated" | "login_required"> {
  try {
    const url = page.url();
    console.log(`[bridge] Auth check: URL = ${url}`);

    const loginIndicators = [
      "login.microsoftonline.com",
      "login.live.com",
      "login.microsoft.com",
      "accounts.google.com/signin",
      "accounts.google.com/v3",
      "adfs.",
      "/adfs/",
      "idp.",
      "sso.",
      "/oauth2/",
      "/authorize",
      "/common/oauth2",
      "/consent",
      "/kmsi",
    ];
    const isOnLoginPage = loginIndicators.some(indicator => url.includes(indicator));
    if (isOnLoginPage) {
      sessionAuthState = "login_required";
      return "login_required";
    }

    if (url === "about:blank" || url === "" || url === "chrome://newtab/") {
      sessionAuthState = "login_required";
      return "login_required";
    }

    const appDomains = [
      "outlook.office.com", "outlook.live.com", "outlook.office365.com",
      "outlook.com/mail", "outlook.cloud.microsoft",
      "teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft",
      "mail.google.com",
    ];

    const isOnAppDomain = appDomains.some(d => url.includes(d));
    if (isOnAppDomain) {
      sessionAuthState = "authenticated";
      return "authenticated";
    }

    sessionAuthState = "login_required";
    return "login_required";
  } catch (err) {
    console.error("[bridge] Auth detection error:", (err as Error).message);
    sessionAuthState = "unknown";
    return "login_required";
  }
}

export async function launchBrowser(headless: boolean = true): Promise<boolean> {
  try {
    if (browser && browser.isConnected()) return true;

    fs.mkdirSync(USER_DATA_DIR, { recursive: true });

    const launchArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      ...(headless ? ["--disable-gpu"] : []),
    ];

    if (!headless) {
      launchArgs.push("--window-position=100,100", "--window-size=1280,800");
    }

    browser = await chromium.launch({
      headless,
      args: launchArgs,
    });

    context = await browser.newContext(getContextOptions());
    browserIsVisible = !headless;
    lastLaunchError = null;

    return true;
  } catch (err: any) {
    const msg = err.message || String(err);
    lastLaunchError = msg;

    if (msg.includes("Executable doesn't exist") || msg.includes("browserType.launch")) {
      console.error("[bridge] Chromium not found. Run: npx playwright install chromium");
      lastLaunchError = "Chromium browser not installed. Run: npx playwright install chromium";
    } else if (msg.includes("display") || msg.includes("DISPLAY")) {
      console.error("[bridge] No display available for visible browser. Try headless mode.");
      lastLaunchError = "No display available. Headless mode required.";
    } else {
      console.error("[bridge] Failed to launch browser:", msg);
    }

    return false;
  }
}

export async function saveBrowserState(): Promise<void> {
  try {
    if (context) {
      fs.mkdirSync(USER_DATA_DIR, { recursive: true });
      await context.storageState({ path: STORAGE_STATE_PATH });
      console.log("[bridge] Session state saved to", STORAGE_STATE_PATH);
    }
  } catch (err) {
    console.warn("[bridge] Failed to save session state:", (err as Error).message);
  }
}

export function isLoginInProgress(): boolean {
  return loginInProgress;
}

export function getLastLaunchError(): string | null {
  return lastLaunchError;
}

export function getAuthState(): string {
  return sessionAuthState;
}

function moveBrowserWindowBack(): void {
  try {
    if (process.platform === "win32") {
      exec('powershell -Command "Add-Type -Name WinAPI -Namespace Temp -MemberDefinition \'[DllImport(\\\"user32.dll\\\")] public static extern bool SetForegroundWindow(IntPtr hWnd);\'; $prev = [System.Diagnostics.Process]::GetCurrentProcess().MainWindowHandle; [Temp.WinAPI]::SetForegroundWindow($prev)"');
    } else {
      exec('sleep 0.5 && xdotool getactivewindow windowminimize 2>/dev/null || true');
    }
  } catch {}
}

export type LoginProgressCallback = (message: string, done: boolean, authDetected?: boolean) => void;

function stopLoginPolling(): void {
  loginPollingActive = false;
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transitionToHeadless(pageId: string, currentUrl: string, onProgress?: LoginProgressCallback): Promise<void> {
  loginTransitioning = true;
  loginInProgress = false;
  loginPollingActive = false;
  try {
    console.log("[bridge] transitionToHeadless: starting...");
    onProgress?.("Switching to headless mode for scraping...", false);

    if (context) {
      try {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        await context.storageState({ path: STORAGE_STATE_PATH });
      } catch (e) {
        console.error("[bridge] transitionToHeadless: failed to save state:", (e as Error).message);
      }
    }

    const pageIds = Array.from(pages.keys());
    for (const id of pageIds) {
      try { await pages.get(id)?.close(); } catch {}
      pages.delete(id);
    }
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    browser = null;
    context = null;
    browserIsVisible = false;

    const launched = await launchBrowser(true);
    if (launched) {
      const newPage = await context!.newPage();
      pages.set(pageId, newPage);
      await newPage.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      onProgress?.("Ready! Session saved and running headless.", true, true);
    } else {
      onProgress?.("Session saved but failed to start headless browser.", true, true);
    }
  } catch (err) {
    console.error("[bridge] transitionToHeadless error:", (err as Error).message);
    onProgress?.(`Transition failed: ${(err as Error).message}`, true, false);
  } finally {
    loginTransitioning = false;
  }
}

async function cleanupFailedLogin(): Promise<void> {
  loginPollingActive = false;
  loginInProgress = false;
  try {
    const ids = Array.from(pages.keys());
    for (const id of ids) {
      try { await pages.get(id)?.close(); } catch {}
      pages.delete(id);
    }
    try { if (context) await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
  } catch {}
  browser = null;
  context = null;
  browserIsVisible = false;
}

function startLoginPolling(pageId: string, service: "outlook" | "teams", onProgress?: LoginProgressCallback): void {
  stopLoginPolling();
  loginPollingActive = true;

  (async () => {
    let pollCount = 0;
    const maxPolls = 120;

    while (loginPollingActive && pollCount < maxPolls) {
      await delay(5000);
      pollCount++;

      if (!loginPollingActive || loginTransitioning) return;

      try {
        const page = pages.get(pageId);
        if (!page || page.isClosed()) {
          if (!loginTransitioning) {
            onProgress?.("Browser window was closed. Login cancelled.", true, false);
            await cleanupFailedLogin();
          }
          return;
        }

        if (browser && !browser.isConnected()) {
          if (!loginTransitioning) {
            onProgress?.("Browser crashed or was closed. Login cancelled.", true, false);
            await cleanupFailedLogin();
          }
          return;
        }

        if (pollCount % 6 === 0) {
          const mins = Math.round(pollCount * 5 / 60);
          onProgress?.(`Still waiting for login... (${mins}min elapsed)`, false);
        }

        const authState = await detectAuthState(page, service);

        if (authState === "authenticated" && loginPollingActive) {
          onProgress?.("Login detected! Saving session...", false);
          const savedUrl = page.url();
          await transitionToHeadless(pageId, savedUrl, onProgress);
          return;
        }
      } catch (err) {
        console.error("[bridge] Login poll error:", (err as Error).message);
      }
    }

    if (loginPollingActive && pollCount >= maxPolls) {
      onProgress?.("Login timed out after 10 minutes.", true, false);
      await cleanupFailedLogin();
    }
  })();
}

export async function startLoginSession(url: string, onProgress?: LoginProgressCallback): Promise<{ success: boolean; error?: string; alreadyAuthenticated?: boolean }> {
  if (loginInProgress) {
    loginInProgress = false;
    loginPollingActive = false;
    loginTransitioning = false;
  }

  try {
    stopLoginPolling();
    await closeBrowser();

    onProgress?.("Launching browser...", false);

    const launched = await launchBrowser(false);
    if (!launched) {
      const diag = await checkBridgeDiagnostics();
      let errorMsg = "Failed to launch visible browser.";
      if (!diag.chromiumInstalled) {
        errorMsg += "\nChromium not installed. Run: npx playwright install chromium";
      } else if (!diag.hasDisplay) {
        errorMsg += "\nNo display available. You need X11 or Wayland for visible login.";
      } else {
        errorMsg += "\n" + (lastLaunchError || "Unknown error");
      }
      return { success: false, error: errorMsg };
    }

    const page = await context!.newPage();
    const pageId = url.includes("teams") ? "teams" : "outlook";
    pages.set(pageId, page);

    onProgress?.(`Navigating to ${url}...`, false);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    onProgress?.("Checking if already authenticated...", false);
    await page.waitForTimeout(2000);

    const service: "outlook" | "teams" = pageId === "teams" ? "teams" : "outlook";
    const authState = await detectAuthState(page, service);

    if (authState === "authenticated") {
      onProgress?.("Already authenticated! Saving session...", false);
      const savedUrl = page.url();
      await transitionToHeadless(pageId, savedUrl, onProgress);
      return { success: true, alreadyAuthenticated: true };
    }

    loginInProgress = true;
    moveBrowserWindowBack();

    startLoginPolling(pageId, service, onProgress);
    onProgress?.("Login page detected. Complete login in the browser.", true, false);
    return { success: true, alreadyAuthenticated: false };
  } catch (err: any) {
    stopLoginPolling();
    try { await closeBrowser(); } catch {}
    loginInProgress = false;
    lastLaunchError = err.message;
    return { success: false, error: err.message };
  }
}

export async function ensureOnPage(pageId: string, targetUrl: string): Promise<boolean> {
  const page = pages.get(pageId);
  if (!page || page.isClosed()) return false;

  try {
    const currentUrl = page.url();
    if (!currentUrl.includes(new URL(targetUrl).hostname)) {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
      return true;
    }
    return true;
  } catch (err) {
    console.error(`[bridge] Failed to navigate to ${targetUrl}:`, (err as Error).message);
    return false;
  }
}

export async function finishLoginSession(): Promise<{ success: boolean; error?: string }> {
  stopLoginPolling();

  if (!context) {
    return { success: false, error: "No browser session active." };
  }

  if (!loginInProgress) {
    const anyPage = pages.values().next().value;
    if (anyPage && !anyPage.isClosed()) {
      await saveBrowserState();
      return { success: true };
    }
    return { success: false, error: "No login session in progress." };
  }

  try {
    loginInProgress = false;

    if (browserIsVisible) {
      const firstEntry = Array.from(pages.entries()).find(([, p]) => !p.isClosed());
      if (firstEntry) {
        const [pageId, page] = firstEntry;
        const savedUrl = page.url();
        await transitionToHeadless(pageId, savedUrl);
      } else {
        await saveBrowserState();
      }
    } else {
      await saveBrowserState();
    }

    return { success: true };
  } catch (err: any) {
    loginInProgress = false;
    return { success: false, error: err.message };
  }
}

export async function closeBrowser(): Promise<void> {
  stopLoginPolling();
  await saveBrowserState();
  const ids = Array.from(pages.keys());
  for (const id of ids) {
    try {
      await pages.get(id)?.close();
    } catch {}
    pages.delete(id);
  }
  try {
    if (context) await context.close();
  } catch {}
  try {
    if (browser) await browser.close();
  } catch {}
  browser = null;
  context = null;
  loginInProgress = false;
  browserIsVisible = false;
}

export function getBridgeStatus(): BridgeStatus {
  const pageList: Array<{ id: string; title: string; url: string }> = [];
  const ids = Array.from(pages.keys());
  for (const id of ids) {
    try {
      const p = pages.get(id);
      if (p && !p.isClosed()) pageList.push({ id, title: p.url(), url: p.url() });
    } catch {}
  }
  return {
    running: !!(browser && browser.isConnected()),
    pageCount: pages.size,
    pages: pageList,
    loginInProgress,
    visible: browserIsVisible,
    authState: sessionAuthState,
    lastError: lastLaunchError,
  };
}

export async function openPage(id: string, url: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!context) {
      const launched = await launchBrowser();
      if (!launched) {
        return { success: false, error: lastLaunchError || "Failed to launch browser." };
      }
    }

    let page = pages.get(id);
    if (!page || page.isClosed()) {
      page = await context!.newPage();
      pages.set(id, page);
    }

    emitEvent("browser-bridge", `Navigating to ${url}`, "action", { sessionId: id });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    emitEvent("browser-bridge", `Page loaded: ${url}`, "info", { sessionId: id });
    return { success: true };
  } catch (err: any) {
    emitEvent("browser-bridge", `Navigation failed: ${err.message}`, "error", { sessionId: id });
    return { success: false, error: err.message };
  }
}

export async function getPageContent(id: string): Promise<PageContent | null> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return null;

  try {
    const title = await page.title();
    const url = page.url();
    emitEvent("browser-bridge", `Extracting content from: ${title}`, "info", { sessionId: id });
    const text = await safeEvaluate(page, () => {
      return document.body?.innerText?.substring(0, 8000) || "";
    });

    const elements = await safeEvaluate(page, () => {
      const results: Array<{
        tag: string;
        text: string;
        role?: string;
        href?: string;
        type?: string;
      }> = [];

      const interactable = document.querySelectorAll(
        'a, button, input, textarea, [role="button"], [role="link"], [role="listitem"], [role="option"], [role="menuitem"]'
      );

      interactable.forEach((el) => {
        const text = (el as HTMLElement).innerText?.trim()?.substring(0, 200) || "";
        if (!text && !(el as HTMLInputElement).value) return;
        results.push({
          tag: el.tagName.toLowerCase(),
          text: text || (el as HTMLInputElement).value || "",
          role: el.getAttribute("role") || undefined,
          href: (el as HTMLAnchorElement).href || undefined,
          type: (el as HTMLInputElement).type || undefined,
        });
      });

      return results.slice(0, 100);
    });

    return { title, url, text, elements };
  } catch {
    return null;
  }
}

export async function getPageText(id: string, selector?: string): Promise<string> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return "";

  try {
    if (selector) {
      const el = await page.$(selector);
      if (!el) return "(element not found)";
      return (await el.innerText()).substring(0, 4000);
    }

    return await safeEvaluate(page, () => {
      return document.body?.innerText?.substring(0, 4000) || "";
    });
  } catch {
    return "";
  }
}

export async function clickElement(id: string, selector: string): Promise<boolean> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return false;

  try {
    await page.click(selector, { timeout: 5000 });
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

export async function clickByText(id: string, text: string): Promise<boolean> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return false;

  try {
    const el = page.getByText(text, { exact: false }).first();
    await el.click({ timeout: 5000 });
    await page.waitForTimeout(500);
    return true;
  } catch {
    return false;
  }
}

export async function typeInPage(id: string, selector: string, text: string): Promise<boolean> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return false;

  try {
    await page.fill(selector, text, { timeout: 5000 });
    return true;
  } catch {
    try {
      await page.click(selector, { timeout: 3000 });
      await page.keyboard.type(text);
      return true;
    } catch {
      return false;
    }
  }
}

export async function pressKey(id: string, key: string): Promise<boolean> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return false;

  try {
    await page.keyboard.press(key);
    return true;
  } catch {
    return false;
  }
}

export async function takeScreenshot(id: string): Promise<Buffer | null> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return null;

  try {
    return await page.screenshot({ type: "png", fullPage: false });
  } catch {
    return null;
  }
}

export async function closePage(id: string): Promise<boolean> {
  const page = pages.get(id);
  if (!page) return false;

  try {
    await page.close();
  } catch {}
  pages.delete(id);
  return true;
}

export async function waitForPage(id: string, ms: number = 2000): Promise<void> {
  const page = pages.get(id);
  if (!page || page.isClosed()) return;
  await page.waitForTimeout(ms);
}

export function getPage(id: string): Page | null {
  const page = pages.get(id);
  if (!page || page.isClosed()) return null;
  return page;
}
