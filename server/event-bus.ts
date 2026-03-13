export type EventType = "info" | "action" | "take-over-point" | "error";

export interface CockpitEvent {
  id: string;
  source: string;
  description: string;
  eventType: EventType;
  sessionId?: string;
  timestamp: number;
  program?: string;
  metadata?: Record<string, unknown>;
}

type EventListener = (event: CockpitEvent) => void;

const listeners: Set<EventListener> = new Set();
const eventHistory: CockpitEvent[] = [];
const MAX_HISTORY = 500;
let eventCounter = 0;

function generateId(): string {
  eventCounter++;
  return `evt-${Date.now()}-${eventCounter}`;
}

export function emitEvent(
  source: string,
  description: string,
  eventType: EventType = "info",
  options: { sessionId?: string; program?: string; metadata?: Record<string, unknown> } = {}
): CockpitEvent {
  const event: CockpitEvent = {
    id: generateId(),
    source,
    description,
    eventType,
    sessionId: options.sessionId,
    timestamp: Date.now(),
    program: options.program,
    metadata: options.metadata,
  };

  eventHistory.push(event);
  if (eventHistory.length > MAX_HISTORY) {
    eventHistory.splice(0, eventHistory.length - MAX_HISTORY);
  }

  for (const listener of listeners) {
    try {
      listener(event);
    } catch (err) {
      console.error("[event-bus] Listener error:", err);
    }
  }

  return event;
}

export function subscribe(listener: EventListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getEventHistory(limit = 100): CockpitEvent[] {
  return eventHistory.slice(-limit);
}

export function getEventsByProgram(program: string, limit = 50): CockpitEvent[] {
  return eventHistory.filter(e => e.program === program).slice(-limit);
}

export function getEventsBySource(source: string, limit = 50): CockpitEvent[] {
  return eventHistory.filter(e => e.source === source).slice(-limit);
}
