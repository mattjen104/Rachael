import type { SiteProfile, NavigationPath, NavigationStep } from "@shared/schema";
import {
  openPage,
  getPageContent,
  getPageText,
  clickElement,
  clickByText,
  typeInPage,
  pressKey,
  waitForPage,
  getPage,
  type PageContent,
} from "./browser-bridge";
import { shouldYield, checkPermission, createTakeoverPoint, recordAction, getControlMode, enqueueCommand, completeCommand, pauseExecution, removePausedExecution, getPausedExecutions } from "./control-bus";

export type UrlValidator = (url: string) => Promise<{ safe: boolean; error?: string }>;

export interface ScrapeResult {
  success: boolean;
  profileName: string;
  pathName: string;
  content: PageContent | null;
  extractedData: Record<string, string>;
  stepResults: StepResult[];
  error?: string;
  durationMs: number;
}

export interface StepResult {
  step: number;
  action: string;
  description?: string;
  success: boolean;
  error?: string;
}

function generatePageId(profile: SiteProfile): string {
  return `scraper-${profile.name}-${Date.now()}`;
}

async function executeStep(
  pageId: string,
  step: NavigationStep,
  stepIndex: number,
  profile: SiteProfile,
  validateUrl?: UrlValidator
): Promise<StepResult> {
  const result: StepResult = {
    step: stepIndex,
    action: step.action,
    description: step.description,
    success: false,
  };

  try {
    switch (step.action) {
      case "navigate": {
        const url = step.target || profile.baseUrl;
        if (!url) {
          result.error = "No URL specified for navigate step";
          return result;
        }
        if (validateUrl) {
          const check = await validateUrl(url);
          if (!check.safe) {
            result.error = `URL blocked: ${check.error}`;
            return result;
          }
        }
        const nav = await openPage(pageId, url);
        result.success = nav.success;
        if (!nav.success) result.error = nav.error;
        break;
      }

      case "click": {
        if (!step.target) {
          result.error = "No selector specified for click step";
          return result;
        }
        result.success = await clickElement(pageId, step.target);
        if (!result.success) result.error = `Could not click selector: ${step.target}`;
        break;
      }

      case "click_text": {
        if (!step.value) {
          result.error = "No text specified for click_text step";
          return result;
        }
        result.success = await clickByText(pageId, step.value);
        if (!result.success) result.error = `Could not find text to click: ${step.value}`;
        break;
      }

      case "type": {
        if (!step.target || !step.value) {
          result.error = "Selector and value required for type step";
          return result;
        }
        result.success = await typeInPage(pageId, step.target, step.value);
        if (!result.success) result.error = `Could not type into: ${step.target}`;
        break;
      }

      case "press_key": {
        if (!step.value) {
          result.error = "No key specified for press_key step";
          return result;
        }
        result.success = await pressKey(pageId, step.value);
        if (!result.success) result.error = `Could not press key: ${step.value}`;
        break;
      }

      case "wait": {
        const ms = step.waitMs || 2000;
        await waitForPage(pageId, ms);
        result.success = true;
        break;
      }

      case "scroll": {
        const page = getPage(pageId);
        if (page) {
          try {
            await page.evaluate((sel: string) => {
              const container = sel ? document.querySelector(sel) : document.documentElement;
              if (container) {
                (container as HTMLElement).scrollTop = (container as HTMLElement).scrollHeight;
              }
            }, step.target || "");
            result.success = true;
          } catch (e: unknown) {
            result.error = e instanceof Error ? e.message : String(e);
          }
        } else {
          result.error = "Page not found";
        }
        break;
      }

      case "extract": {
        result.success = true;
        break;
      }

      default:
        result.error = `Unknown action: ${step.action}`;
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  return result;
}

async function extractDataWithSelectors(
  pageId: string,
  content: PageContent,
  selectors: Record<string, string>
): Promise<Record<string, string>> {
  const extracted: Record<string, string> = {};
  const page = getPage(pageId);

  for (const [key, selector] of Object.entries(selectors)) {
    extracted[key] = "";

    if (page) {
      try {
        const text = await page.evaluate((sel: string) => {
          const els = document.querySelectorAll(sel);
          if (els.length === 0) return "";
          const texts: string[] = [];
          els.forEach(el => {
            const t = (el as HTMLElement).innerText?.trim();
            if (t) texts.push(t);
          });
          return texts.join("\n").slice(0, 5000);
        }, selector);
        if (text) {
          extracted[key] = text;
          continue;
        }
      } catch {}
    }

    for (const el of content.elements) {
      if (el.tag && selector.includes(el.tag) && el.text) {
        extracted[key] = (extracted[key] ? extracted[key] + "\n" : "") + el.text;
      }
    }
  }

  return extracted;
}

export async function executeNavigationPath(
  profile: SiteProfile,
  navPath: NavigationPath,
  validateUrl?: UrlValidator,
  runtimeUrl?: string,
  resumeFromStep?: number,
  resumePageId?: string
): Promise<ScrapeResult> {
  const startTime = Date.now();
  const pageId = resumePageId || generatePageId(profile);

  const result: ScrapeResult = {
    success: false,
    profileName: profile.name,
    pathName: navPath.name,
    content: null,
    extractedData: {},
    stepResults: [],
    durationMs: 0,
  };

  try {
    const steps = navPath.steps as NavigationStep[];

    const isResume = resumeFromStep !== undefined && resumeFromStep > 0;
    if (!isResume) {
      const hasNavigateStep = steps.some(s => s.action === "navigate");
      const initialUrl = runtimeUrl || (!hasNavigateStep && profile.baseUrl ? profile.baseUrl : (steps.length === 0 ? profile.baseUrl : null));
      if (initialUrl) {
        if (validateUrl) {
          const check = await validateUrl(initialUrl);
          if (!check.safe) {
            result.error = `URL blocked: ${check.error}`;
            result.durationMs = Date.now() - startTime;
            return result;
          }
        }
        const nav = await openPage(pageId, initialUrl);
        if (!nav.success) {
          result.error = nav.error || "Failed to open URL";
          result.durationMs = Date.now() - startTime;
          return result;
        }
        await waitForPage(pageId, 2000);
      }
    }

    let hasCriticalFailure = false;
    let wasPaused = false;
    const criticalActions = new Set(["navigate", "click", "click_text", "type"]);
    const startStep = resumeFromStep || 0;

    for (let i = startStep; i < steps.length; i++) {
      if (shouldYield()) {
        pauseExecution({
          type: "navigation",
          profileId: profile.id,
          navPathId: navPath.id,
          stepIndex: i,
          context: { runtimeUrl, pageId, completedSteps: result.stepResults.length },
        });
        result.error = `Paused at step ${i}: human took control. Will resume when agent regains control.`;
        wasPaused = true;
        recordAction(getControlMode(), `nav-paused: ${navPath.name} step ${i}`, profile.name, undefined, "paused");
        break;
      }

      const step = steps[i];
      const actionName = step.description || `${step.action}:${step.target || step.value || ""}`;

      const permCheck = await checkPermission(profile.id, navPath.id, `step ${i}: ${actionName}`, actionName);
      if (!permCheck.allowed && !permCheck.needsApproval) {
        result.stepResults.push({ step: i, action: step.action, description: step.description, success: false, error: `Blocked by permission: ${actionName}` });
        hasCriticalFailure = true;
        result.error = `Step ${i} blocked: ${actionName} (permission: ${permCheck.level})`;
        break;
      }

      if (permCheck.needsApproval) {
        const decision = await createTakeoverPoint(`nav-step: ${actionName}`, `${profile.name}/${navPath.name} step ${i}`, permCheck.level);
        if (decision !== "confirm") {
          result.stepResults.push({ step: i, action: step.action, description: step.description, success: false, error: `Step ${decision}: ${actionName}` });
          hasCriticalFailure = true;
          result.error = `Step ${i} ${decision}: ${actionName}`;
          break;
        }
      }

      const cmd = enqueueCommand("agent", `nav-step: ${step.action}`, `${profile.name}/${navPath.name}[${i}]`);
      const stepResult = await executeStep(pageId, step, i, profile, validateUrl);
      if (cmd) completeCommand(cmd.id, stepResult.success ? "success" : "error");
      result.stepResults.push(stepResult);

      if (!stepResult.success && criticalActions.has(step.action)) {
        console.warn(`[universal-scraper] Critical step ${i} (${step.action}) failed: ${stepResult.error}`);
        hasCriticalFailure = true;
        result.error = `Step ${i} (${step.action}) failed: ${stepResult.error}`;
        break;
      }

      if (step.waitMs && step.action !== "wait") {
        await waitForPage(pageId, step.waitMs!);
      }
    }

    if (wasPaused) {
      result.success = false;
      result.durationMs = Date.now() - startTime;
      return result;
    }

    const content = await getPageContent(pageId);
    result.content = content;

    if (content) {
      const allSelectors = {
        ...((profile.extractionSelectors as Record<string, string>) || {}),
        ...((navPath.extractionRules as Record<string, string>) || {}),
      };

      if (Object.keys(allSelectors).length > 0) {
        result.extractedData = await extractDataWithSelectors(pageId, content, allSelectors);
      }
    }

    if (hasCriticalFailure) {
      result.success = false;
    } else if (!result.content && Object.keys(result.extractedData).length === 0) {
      result.success = false;
      result.error = result.error || "No content extracted — page may not have loaded or selectors did not match";
    } else {
      result.success = true;
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

export async function bestEffortExtract(url: string): Promise<ScrapeResult> {
  const startTime = Date.now();
  const pageId = `generic-${Date.now()}`;

  const result: ScrapeResult = {
    success: false,
    profileName: "any-website",
    pathName: "best-effort-extract",
    content: null,
    extractedData: {},
    stepResults: [],
    durationMs: 0,
  };

  try {
    const nav = await openPage(pageId, url);
    result.stepResults.push({
      step: 0,
      action: "navigate",
      description: `Open ${url}`,
      success: nav.success,
      error: nav.error,
    });

    if (!nav.success) {
      result.error = nav.error || "Failed to open URL";
      result.durationMs = Date.now() - startTime;
      return result;
    }

    await waitForPage(pageId, 3000);

    const content = await getPageContent(pageId);
    result.content = content;

    if (content) {
      result.extractedData = {
        title: content.title || "",
        url: content.url || url,
        textPreview: (content.text || "").slice(0, 2000),
        elementCount: String(content.elements?.length || 0),
      };
      result.success = true;
    } else {
      const text = await getPageText(pageId);
      if (text) {
        result.extractedData = {
          title: "",
          url: url,
          textPreview: text.slice(0, 2000),
          elementCount: "0",
        };
        result.success = true;
      } else {
        result.error = "Could not extract any content from the page";
      }
    }
  } catch (err: unknown) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - startTime;
  return result;
}

export function matchProfileToUrl(
  profiles: SiteProfile[],
  url: string
): SiteProfile | undefined {
  for (const profile of profiles) {
    if (!profile.enabled) continue;

    if (profile.baseUrl && url.startsWith(profile.baseUrl)) {
      return profile;
    }

    const patterns = profile.urlPatterns as string[];
    for (const pattern of patterns) {
      try {
        const regex = new RegExp(pattern);
        if (regex.test(url)) return profile;
      } catch {
        if (url.includes(pattern)) return profile;
      }
    }
  }
  return undefined;
}
