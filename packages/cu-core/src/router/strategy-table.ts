import type { LocatorKind, ObservationKind, SurfaceKind } from "../types";

// ---------------------------------------------------------------------------
// Strategy table — per surface, the *priority order* of observation kinds and
// locator kinds the router should prefer. This is data, not code, on purpose:
// the evolution engine will later mutate these entries (e.g. "for surface=
// hyperspace, screen=order-entry, skip AxTree — it's never present").
//
// The router asks `getStrategy(surfaceKind)` and walks the lists top-down,
// dropping anything the surface's actual capabilities don't include.
// ---------------------------------------------------------------------------

export interface SurfaceStrategy {
  surfaceKind: SurfaceKind;
  observationPriority: ObservationKind[];
  locatorPriority: LocatorKind[];
  // Soft hint — when the router escalates to one of these observations, treat
  // it as a "vision tier" miss for the cheaper structured tier and emit an
  // observation-tier-miss event upstream.
  visionTier: ObservationKind[];
  notes?: string;
}

// The canonical ordering — cheapest sufficient observation first, falling all
// the way back to RawScreenshot. Locators follow the same ladder: stable
// handles first, raw coords last.
export const DEFAULT_STRATEGIES: Record<SurfaceKind, SurfaceStrategy> = {
  "browser-tab": {
    surfaceKind: "browser-tab",
    observationPriority: ["AxTree", "DomSnapshot", "SomScreenshot", "RawScreenshot"],
    locatorPriority: ["selector", "hint", "mark", "coords"],
    visionTier: ["SomScreenshot", "RawScreenshot"],
    notes: "Playwright/CDP — AxTree is essentially free; almost never need vision.",
  },
  "browser-extension": {
    surfaceKind: "browser-extension",
    observationPriority: ["AxTree", "DomSnapshot", "SomScreenshot", "RawScreenshot"],
    locatorPriority: ["selector", "hint", "mark", "coords"],
    visionTier: ["SomScreenshot", "RawScreenshot"],
    notes: "Same ladder as Playwright; just slower per observation.",
  },
  "desktop-window": {
    surfaceKind: "desktop-window",
    observationPriority: ["UiaTree", "RawScreenshot"],
    locatorPriority: ["uia", "hint", "mark", "coords"],
    visionTier: ["RawScreenshot"],
    notes: "UIA hits ~95% of standard Win32; vision is the rescue tier.",
  },
  "citrix-session": {
    surfaceKind: "citrix-session",
    observationPriority: ["SomScreenshot", "RawScreenshot"],
    locatorPriority: ["hint", "mark", "coords"],
    visionTier: ["SomScreenshot", "RawScreenshot"],
    notes: "Vision-only. Hint overlay (vim-style) preferred over coord clicks.",
  },
  shell: {
    surfaceKind: "shell",
    observationPriority: ["TextDump"],
    locatorPriority: ["selector"],
    visionTier: [],
  },
  fake: {
    surfaceKind: "fake",
    observationPriority: ["DomSnapshot", "TextDump"],
    locatorPriority: ["selector", "hint"],
    visionTier: [],
  },
};

const overrides = new Map<SurfaceKind, SurfaceStrategy>();

export function getStrategy(kind: SurfaceKind): SurfaceStrategy {
  return overrides.get(kind) ?? DEFAULT_STRATEGIES[kind];
}

export function setStrategy(kind: SurfaceKind, strategy: SurfaceStrategy): void {
  overrides.set(kind, strategy);
}

export function clearStrategyOverrides(): void {
  overrides.clear();
}

// Filter a priority list against what the surface actually supports.
export function intersectPriority<T>(priority: T[], available: T[]): T[] {
  const set = new Set(available);
  return priority.filter((x) => set.has(x));
}
