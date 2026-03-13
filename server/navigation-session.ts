import { emitEvent } from "./event-bus";

export interface NavigationAction {
  index: number;
  label: string;
  type: "link" | "button" | "input" | "custom";
  target?: string;
}

export interface NavigationState {
  sessionId: string;
  profileName: string;
  breadcrumb: string[];
  pageSummary: string;
  availableActions: NavigationAction[];
  currentUrl: string;
  timestamp: number;
}

interface NavigationHistoryEntry {
  state: NavigationState;
  actionTaken?: string;
}

const activeSessions: Map<string, NavigationState> = new Map();
const sessionHistories: Map<string, NavigationHistoryEntry[]> = new Map();
const MAX_HISTORY_PER_SESSION = 100;

export function createNavigationSession(
  sessionId: string,
  profileName: string,
  initialUrl: string
): NavigationState {
  const state: NavigationState = {
    sessionId,
    profileName,
    breadcrumb: [profileName],
    pageSummary: "Initializing...",
    availableActions: [],
    currentUrl: initialUrl,
    timestamp: Date.now(),
  };

  activeSessions.set(sessionId, state);
  sessionHistories.set(sessionId, [{ state: { ...state } }]);

  emitEvent("navigation", `Started navigation session: ${profileName}`, "info", {
    sessionId,
    metadata: { url: initialUrl },
  });

  return state;
}

export function updateNavigationState(
  sessionId: string,
  update: {
    breadcrumb?: string[];
    pageSummary?: string;
    availableActions?: NavigationAction[];
    currentUrl?: string;
    actionTaken?: string;
  }
): NavigationState | null {
  const current = activeSessions.get(sessionId);
  if (!current) return null;

  const updated: NavigationState = {
    ...current,
    ...update,
    timestamp: Date.now(),
  };

  activeSessions.set(sessionId, updated);

  const history = sessionHistories.get(sessionId) || [];
  history.push({ state: { ...updated }, actionTaken: update.actionTaken });
  if (history.length > MAX_HISTORY_PER_SESSION) {
    history.splice(0, history.length - MAX_HISTORY_PER_SESSION);
  }
  sessionHistories.set(sessionId, history);

  if (update.actionTaken) {
    emitEvent("navigation", `Action: ${update.actionTaken}`, "action", {
      sessionId,
      metadata: { url: updated.currentUrl },
    });
  }

  return updated;
}

export function getNavigationSession(sessionId: string): NavigationState | null {
  return activeSessions.get(sessionId) || null;
}

export function getNavigationHistory(sessionId: string): NavigationHistoryEntry[] {
  return sessionHistories.get(sessionId) || [];
}

export function getActiveSessions(): NavigationState[] {
  return Array.from(activeSessions.values());
}

export function closeNavigationSession(sessionId: string): boolean {
  const existed = activeSessions.has(sessionId);
  activeSessions.delete(sessionId);

  if (existed) {
    emitEvent("navigation", `Closed navigation session: ${sessionId}`, "info", { sessionId });
  }

  return existed;
}
