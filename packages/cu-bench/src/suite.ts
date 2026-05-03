// 30-task curated in-house suite — 10 web, 10 Windows-UIA, 10 Citrix-vision.
//
// Self-contained inside @rachael/cu-bench. Each entry carries the cheapest
// observation tier the production trajectory used so the bench harness can
// exercise the strategy table end-to-end against a stub surface.

import type { ObservationKind, SurfaceKind } from "@rachael/cu-core";
import type { TaskSpec } from "./harness";

interface SuiteEntry extends Omit<TaskSpec, "steps"> {
  expectedCheapestObservation: ObservationKind;
  notes: string;
  stepCount: number;
}

function entry(
  id: string,
  surfaceKind: SurfaceKind,
  intent: string,
  expectedCheapestObservation: ObservationKind,
  stepCount: number,
  notes: string,
): SuiteEntry {
  return { id, surfaceKind, intent, expectedCheapestObservation, stepCount, notes };
}

export const SUITE_ENTRIES: SuiteEntry[] = [
  // ---- Web ----
  entry("web-01-google-search", "browser-tab", "search query and capture top result", "AxTree", 4, "google.com → type → enter → read result"),
  entry("web-02-github-pr-comment", "browser-extension", "leave PR review comment", "AxTree", 6, "PR page → click Files → click Comment → type → submit"),
  entry("web-03-gmail-archive", "browser-extension", "archive top inbox message", "AxTree", 3, "open inbox → click first message → press e"),
  entry("web-04-jira-status-update", "browser-extension", "transition ticket to In Progress", "DomSnapshot", 5, "open ticket → click status → pick option → save"),
  entry("web-05-notion-checkbox", "browser-tab", "tick a daily standup checkbox", "AxTree", 2, "load page → click checkbox"),
  entry("web-06-stack-overflow-extract", "browser-tab", "scrape accepted answer text", "DomSnapshot", 2, "navigate → extract"),
  entry("web-07-wikipedia-toc-jump", "browser-tab", "jump to TOC section H2", "AxTree", 3, "load → click TOC link → assert h2 visible"),
  entry("web-08-form-fill-multi", "browser-tab", "fill 5-field web form", "AxTree", 7, "5 type + tab + submit"),
  entry("web-09-shadow-dom-button", "browser-tab", "click button inside open shadow DOM", "DomSnapshot", 2, "AxTree misses; DomSnapshot finds shadow root child"),
  entry("web-10-iframe-cookie-banner", "browser-tab", "dismiss third-party cookie banner", "DomSnapshot", 3, "switch frame → click 'Accept all'"),

  // ---- Windows UIA ----
  entry("uia-01-explorer-open-folder", "desktop-window", "open Documents in Explorer", "UiaTree", 3, "address bar → type path → enter"),
  entry("uia-02-notepad-save", "desktop-window", "save notepad file with name", "UiaTree", 5, "Ctrl+S → type filename → enter"),
  entry("uia-03-outlook-new-mail", "desktop-window", "compose new mail and set subject", "UiaTree", 4, "click New → focus subject → type"),
  entry("uia-04-teams-call-mute", "desktop-window", "mute mic in Teams call", "UiaTree", 1, "single hint key press"),
  entry("uia-05-snip-rect-capture", "desktop-window", "snip a region with snipping tool", "UiaTree", 4, "Win+Shift+S → drag → save → close"),
  entry("uia-06-control-panel-toggle", "desktop-window", "flip Bluetooth toggle in Settings", "UiaTree", 3, "open Settings → search bluetooth → toggle"),
  entry("uia-07-task-manager-end-process", "desktop-window", "end frozen process by name", "UiaTree", 4, "open Task Mgr → search name → right-click End → confirm"),
  entry("uia-08-file-rename", "desktop-window", "rename file via F2", "UiaTree", 3, "select → F2 → type → enter"),
  entry("uia-09-vscode-cmd-palette", "desktop-window", "run command via Ctrl+Shift+P", "UiaTree", 3, "Ctrl+Shift+P → type → enter"),
  entry("uia-10-uia-fallback-coords", "desktop-window", "click custom WPF control with no UIA name", "RawScreenshot", 2, "UIA misses → fallback to image → coord click"),

  // ---- Citrix vision ----
  entry("cv-01-hyperdrive-login", "citrix-session", "click Sign In after credentials prefilled", "SomScreenshot", 1, "single mark click"),
  entry("cv-02-hyperdrive-patient-search", "citrix-session", "search patient by MRN", "SomScreenshot", 4, "click search box → type → enter → click result"),
  entry("cv-03-hyperdrive-open-chart", "citrix-session", "open chart from result list", "SomScreenshot", 1, "double-click marked row"),
  entry("cv-04-hyperdrive-vitals-tab", "citrix-session", "switch to Vitals tab", "SomScreenshot", 1, "click tab mark"),
  entry("cv-05-hyperdrive-order-set-pick", "citrix-session", "open Order Sets and pick template", "SomScreenshot", 3, "F8 → type filter → click template"),
  entry("cv-06-hyperdrive-allergy-add", "citrix-session", "add allergy with reaction", "SomScreenshot", 5, "open Allergies → add → type → pick reaction → save"),
  entry("cv-07-hyperdrive-note-template", "citrix-session", "insert note template smartphrase", "SomScreenshot", 3, "focus note body → type .smartphrase → enter"),
  entry("cv-08-hyperdrive-printer-pick", "citrix-session", "select printer in print dialog", "SomScreenshot", 3, "Ctrl+P → click dropdown → pick"),
  entry("cv-09-hyperdrive-modal-dismiss", "citrix-session", "dismiss confirm modal", "SomScreenshot", 1, "click OK mark"),
  entry("cv-10-hyperdrive-no-marks", "citrix-session", "act on screen with no SoM marks", "RawScreenshot", 2, "SoM detector empty → fallback to RawScreenshot + coords"),
];

export const SUITE_NOTES = `Curated 30-task bench: 10 web, 10 Windows-UIA, 10 Citrix-vision.
Each entry carries the cheapest observation tier the production trajectory
actually used. Bench computes per-tier hit rate, mean cost, and median wall
time.`;
