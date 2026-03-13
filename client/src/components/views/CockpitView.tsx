import React, { useState, useCallback, useEffect, useRef } from "react";
import { useCockpitEvents, type CockpitEvent } from "@/hooks/use-cockpit-events";
import { apiRequest } from "@/lib/queryClient";

interface NavigationState {
  sessionId: string;
  profileName: string;
  breadcrumb: string[];
  pageSummary: string;
  availableActions: Array<{ index: number; label: string; type: string; target?: string }>;
  currentUrl: string;
  timestamp: number;
}

type CockpitMode = "stream" | "navigation";

export default function CockpitView() {
  const { events, connected } = useCockpitEvents();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [mode, setMode] = useState<CockpitMode>("stream");
  const [focusedEvent, setFocusedEvent] = useState<CockpitEvent | null>(null);
  const [navState, setNavState] = useState<NavigationState | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const filteredEvents = filter
    ? events.filter(e => e.source === filter || e.program === filter)
    : events;

  const groupedEvents = groupBySource(filteredEvents);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [events.length, autoScroll]);

  useEffect(() => {
    setSelectedIdx(Math.max(0, filteredEvents.length - 1));
  }, [filteredEvents.length]);

  const expandEvent = useCallback(async (event: CockpitEvent) => {
    setFocusedEvent(event);
    if (event.sessionId) {
      try {
        const res = await apiRequest("GET", `/api/cockpit/nav/sessions/${event.sessionId}`);
        const session = await res.json();
        setNavState(session);
        setMode("navigation");
        return;
      } catch {}
    }
  }, []);

  const executeNavAction = useCallback(async (actionIdx: number) => {
    if (!navState) return;
    const action = navState.availableActions[actionIdx];
    if (!action) return;
    try {
      await apiRequest("PATCH", `/api/cockpit/nav/sessions/${navState.sessionId}`, {
        actionTaken: action.label,
      });
      const res = await apiRequest("GET", `/api/cockpit/nav/sessions/${navState.sessionId}`);
      const updated = await res.json();
      setNavState(updated);
    } catch {}
  }, [navState]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (mode === "navigation") {
      if (e.key === "Escape") {
        e.preventDefault();
        setMode("stream");
        setFocusedEvent(null);
        setNavState(null);
        return;
      }
      if (navState && e.key >= "1" && e.key <= "9") {
        const actionIdx = parseInt(e.key) - 1;
        if (navState.availableActions[actionIdx]) {
          e.preventDefault();
          executeNavAction(actionIdx);
        }
        return;
      }
      return;
    }

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, filteredEvents.length - 1));
        setAutoScroll(false);
        break;
      case "k":
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        setAutoScroll(false);
        break;
      case "g":
        e.preventDefault();
        setSelectedIdx(0);
        setAutoScroll(false);
        break;
      case "G":
        e.preventDefault();
        setSelectedIdx(filteredEvents.length - 1);
        setAutoScroll(true);
        break;
      case "Enter":
        e.preventDefault();
        if (filteredEvents[selectedIdx]) {
          expandEvent(filteredEvents[selectedIdx]);
        }
        break;
      case "Escape":
        e.preventDefault();
        if (focusedEvent) {
          setFocusedEvent(null);
          setNavState(null);
        } else if (filter) {
          setFilter(null);
        }
        break;
      case "f":
        e.preventDefault();
        if (filteredEvents[selectedIdx]) {
          const ev = filteredEvents[selectedIdx];
          setFilter(ev.program || ev.source);
        }
        break;
      case "F":
        e.preventDefault();
        setFilter(null);
        break;
    }
  }, [mode, filteredEvents, selectedIdx, focusedEvent, navState, filter, expandEvent, executeNavAction]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (mode === "navigation" && navState) {
    return (
      <div className="flex flex-col h-full overflow-hidden font-mono text-xs" data-testid="cockpit-navigation">
        <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between items-center">
          <span>NAV: {navState.profileName}</span>
          <button
            data-testid="nav-back-to-stream"
            className="underline shrink-0 text-[10px]"
            onClick={() => { setMode("stream"); setNavState(null); setFocusedEvent(null); }}
          >
            [stream]
          </button>
        </div>

        <div className="px-2 py-1 border-b border-border text-[10px] text-muted-foreground">
          {navState.breadcrumb.join(" > ")}
        </div>

        <div className="px-2 py-1 border-b border-border text-[10px]">
          <span className="text-muted-foreground">URL: </span>{navState.currentUrl}
        </div>

        <div className="px-2 py-2 border-b border-border flex-1 overflow-y-auto">
          <div className="text-muted-foreground text-[10px] mb-1">PAGE SUMMARY</div>
          <div className="whitespace-pre-wrap leading-relaxed">{navState.pageSummary}</div>
        </div>

        {navState.availableActions.length > 0 && (
          <div className="border-t border-border px-2 py-1">
            <div className="text-muted-foreground text-[10px] mb-1">ACTIONS (press number key)</div>
            {navState.availableActions.map((action) => (
              <div key={action.index} className="flex items-center gap-1 py-0.5" data-testid={`nav-action-${action.index}`}>
                <span className="text-primary font-bold w-4 shrink-0">{action.index + 1}</span>
                <span className="text-muted-foreground text-[10px] w-10 shrink-0">[{action.type}]</span>
                <span className="truncate">{action.label}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-hidden font-mono text-xs" data-testid="cockpit-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between items-center">
        <div className="flex items-center gap-2">
          <span className={connected ? "text-green-500" : "text-red-500"}>
            {connected ? "●" : "○"}
          </span>
          <span>COCKPIT ({filteredEvents.length})</span>
          {filter && (
            <span className="text-primary text-[10px]">[filter: {filter}]</span>
          )}
        </div>
        <div className="text-[10px] flex gap-2">
          <span>j/k:nav</span>
          <span>Enter:expand</span>
          <span>f:filter</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {groupedEvents.map((group, groupIdx) => (
          <div key={group.source + groupIdx}>
            <div className="px-2 py-0.5 text-[10px] text-muted-foreground bg-muted/30 border-b border-border sticky top-0">
              {group.source}
            </div>
            {group.events.map((event) => {
              const eventIdx = filteredEvents.indexOf(event);
              const sel = eventIdx === selectedIdx;
              const isTakeover = event.eventType === "take-over-point";
              const isError = event.eventType === "error";

              return (
                <div
                  key={event.id}
                  data-idx={eventIdx}
                  data-testid={`cockpit-event-${event.id}`}
                  className={`px-2 py-0.5 cursor-pointer select-none flex items-center gap-1 ${
                    sel ? "bg-primary/20" : ""
                  } ${isError ? "text-red-400" : ""} ${isTakeover ? "bg-yellow-500/10 border-l-2 border-yellow-500" : ""}`}
                  onClick={() => {
                    setSelectedIdx(eventIdx);
                    expandEvent(event);
                  }}
                >
                  <span className="w-4 shrink-0 text-center text-[10px]">
                    {eventTypeIcon(event.eventType)}
                  </span>
                  <span className="text-muted-foreground text-[10px] shrink-0 w-12">
                    {formatTime(event.timestamp)}
                  </span>
                  <span className="truncate flex-1">{event.description}</span>
                  {isTakeover && (
                    <span className="text-yellow-500 text-[10px] shrink-0">[TAKE OVER]</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {filteredEvents.length === 0 && (
          <div className="p-4 text-center text-muted-foreground" data-testid="empty-cockpit">
            No activity events yet. Events will appear as the agent runs programs and interacts with browsers.
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {focusedEvent && !navState && (
        <div className="border-t border-border px-2 py-1 bg-muted/20 max-h-32 overflow-y-auto">
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>Event Detail</span>
            <button
              data-testid="close-event-detail"
              className="underline"
              onClick={() => setFocusedEvent(null)}
            >
              [close]
            </button>
          </div>
          <div className="text-[10px]">
            <div><span className="text-muted-foreground">Source: </span>{focusedEvent.source}</div>
            <div><span className="text-muted-foreground">Type: </span>{focusedEvent.eventType}</div>
            {focusedEvent.program && <div><span className="text-muted-foreground">Program: </span>{focusedEvent.program}</div>}
            {focusedEvent.sessionId && <div><span className="text-muted-foreground">Session: </span>{focusedEvent.sessionId}</div>}
            <div><span className="text-muted-foreground">Time: </span>{new Date(focusedEvent.timestamp).toLocaleString()}</div>
            <div className="mt-1">{focusedEvent.description}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function eventTypeIcon(type: string): string {
  switch (type) {
    case "info": return "ℹ";
    case "action": return "▶";
    case "take-over-point": return "⚡";
    case "error": return "✗";
    default: return "·";
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

interface EventGroup {
  source: string;
  events: CockpitEvent[];
}

function groupBySource(events: CockpitEvent[]): EventGroup[] {
  const groups: EventGroup[] = [];
  let currentSource: string | null = null;
  let currentGroup: CockpitEvent[] = [];

  for (const event of events) {
    const src = event.program || event.source;
    if (src !== currentSource) {
      if (currentGroup.length > 0 && currentSource) {
        groups.push({ source: currentSource, events: currentGroup });
      }
      currentSource = src;
      currentGroup = [event];
    } else {
      currentGroup.push(event);
    }
  }

  if (currentGroup.length > 0 && currentSource) {
    groups.push({ source: currentSource, events: currentGroup });
  }

  return groups;
}
