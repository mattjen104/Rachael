import type { Capabilities, SurfaceKind } from "../types";

// Capability declarations for each adapter. The router will read this map to
// decide which surface can satisfy a given recipe step. Numbers come from
// production traces in late 2025: median observe latency in ms, and a rough
// "tokens per observation" cost for vision-heavy paths.
//
// Keep these honest — a router that trusts a guess is worse than no router.

export interface AdapterCapabilityEntry {
  surfaceKind: SurfaceKind;
  capabilities: Capabilities;
  // Median observe latency from production traces, in milliseconds.
  medianObserveMs: number;
  // Median act latency from production traces, in milliseconds.
  medianActMs: number;
  // Approximate tokens-per-observation when the observation is fed to a model.
  // 0 means "no model needed for this observation" (e.g. AxTree fed to a
  // selector picker, not an LLM).
  tokensPerObservation: number;
  // Free-form hints the router may consume.
  notes?: string;
}

export const ADAPTER_CAPABILITIES: Record<string, AdapterCapabilityEntry> = {
  "browser-playwright": {
    surfaceKind: "browser-tab",
    capabilities: {
      observations: ["AxTree", "DomSnapshot", "SomScreenshot", "RawScreenshot"],
      actions: ["Click", "Type", "Key", "Scroll", "Goto", "Wait"],
      locators: ["selector", "coords"],
      cost: { observe: 1, act: 1 },
    },
    medianObserveMs: 180,
    medianActMs: 220,
    tokensPerObservation: 800,
    notes: "AxTree via CDP Accessibility.getFullAXTree; cheapest structured observation.",
  },
  "browser-extension": {
    surfaceKind: "browser-extension",
    capabilities: {
      observations: ["AxTree", "DomSnapshot", "SomScreenshot", "RawScreenshot"],
      actions: ["Click", "Type", "Key", "Scroll", "Goto", "Wait"],
      locators: ["selector", "coords"],
      cost: { observe: 3, act: 3 },
    },
    medianObserveMs: 1400,
    medianActMs: 1600,
    tokensPerObservation: 1200,
    notes:
      "Same observation/action set as the Playwright adapter; only path for Outlook/Teams/ServiceNow under SSO. " +
      "Requires user's authenticated browser; higher latency.",
  },
  "windows-uia": {
    surfaceKind: "desktop-window",
    capabilities: {
      observations: ["UiaTree", "RawScreenshot"],
      actions: ["Click", "Type", "Key", "Scroll", "Hint"],
      locators: ["uia", "hint", "coords"],
      cost: { observe: 1, act: 1 },
    },
    medianObserveMs: 250,
    medianActMs: 180,
    tokensPerObservation: 600,
    notes:
      "Cheap when UIA hits; falls back to coords clicks (tokensPerObservation rises ~3x in fallback).",
  },
  "citrix-vision": {
    surfaceKind: "citrix-session",
    capabilities: {
      observations: ["SomScreenshot", "RawScreenshot"],
      actions: ["Hint", "Click", "Type", "Key"],
      locators: ["hint", "mark", "coords"],
      cost: { observe: 8, act: 6 },
    },
    medianObserveMs: 1800,
    medianActMs: 700,
    tokensPerObservation: 2400,
    notes:
      "Vision-only surface (Hyperspace under Citrix exposes no usable UIA/DOM). " +
      "Primary observation is OmniParser-class SoM; vim-hint overlay is a fallback.",
  },
};
