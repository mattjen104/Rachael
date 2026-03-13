import React, { useState, useCallback, useEffect, useRef } from "react";
import { useCockpitEvents, type CockpitEvent } from "@/hooks/use-cockpit-events";
import { useControlState, useToggleControlMode, useResolveTakeoverPoint, useAuditLog, useSiteProfiles, useNavigationPaths, useUpdateSiteProfile, useUpdateNavigationPath, useActionPermissions, useSetActionPermission } from "@/hooks/use-org-data";
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

type CockpitTab = "stream" | "navigation" | "audit" | "permissions";

export default function CockpitView() {
  const { events, connected } = useCockpitEvents();
  const { data: control } = useControlState();
  const toggleControlMode = useToggleControlMode();
  const resolvePoint = useResolveTakeoverPoint();
  const { data: auditLogs = [] } = useAuditLog(50);
  const { data: profiles = [] } = useSiteProfiles();
  const { data: navPaths = [] } = useNavigationPaths();
  const updateProfile = useUpdateSiteProfile();
  const updateNavPath = useUpdateNavigationPath();
  const { data: actionPerms = [] } = useActionPermissions();
  const setActionPerm = useSetActionPermission();
  const [newActionName, setNewActionName] = useState("");

  const [tab, setTab] = useState<CockpitTab>("stream");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [focusedEvent, setFocusedEvent] = useState<CockpitEvent | null>(null);
  const [navState, setNavState] = useState<NavigationState | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const controlMode = control?.mode || "human";
  const pendingPoints = control?.pendingTakeoverPoints || [];
  const controlStream = control?.activityStream || [];
  const pausedExecutions = control?.pausedExecutions || [];

  const filteredEvents = filter
    ? events.filter(e => e.source === filter || e.program === filter)
    : events;

  const groupedEvents = groupBySource(filteredEvents);

  useEffect(() => {
    const handleTabEvent = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail === "stream" || detail === "audit" || detail === "permissions") {
        setTab(detail);
      }
    };
    window.addEventListener("cockpit-tab", handleTabEvent);
    return () => window.removeEventListener("cockpit-tab", handleTabEvent);
  }, []);

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
        setTab("navigation");
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
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      toggleControlMode.mutate();
      return;
    }

    if (tab === "navigation") {
      if (e.key === "Escape") {
        e.preventDefault();
        setTab("stream");
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

    if (tab !== "stream") return;

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
  }, [tab, filteredEvents, selectedIdx, focusedEvent, navState, filter, expandEvent, executeNavAction, toggleControlMode]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  function formatTimeTs(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function formatTimeStr(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function permBadge(level?: string) {
    if (!level) return null;
    const colors: Record<string, string> = {
      autonomous: "text-green-400",
      approval: "text-yellow-400",
      blocked: "text-red-400",
    };
    return <span className={`${colors[level] || "text-muted-foreground"} text-[9px] uppercase`}>[{level}]</span>;
  }

  if (tab === "navigation" && navState) {
    return (
      <div className="flex flex-col h-full overflow-hidden font-mono text-xs" data-testid="cockpit-navigation">
        <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between items-center">
          <span>NAV: {navState.profileName}</span>
          <button
            data-testid="nav-back-to-stream"
            className="underline shrink-0 text-[10px] cursor-pointer"
            onClick={() => { setTab("stream"); setNavState(null); setFocusedEvent(null); }}
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
          <span>COCKPIT</span>
          <span
            className={`px-1 py-0.5 text-[10px] font-bold rounded ${
              controlMode === "agent" ? "bg-blue-500/20 text-blue-400" : "bg-orange-500/20 text-orange-400"
            }`}
            data-testid="control-mode-indicator"
          >
            {controlMode.toUpperCase()}
          </span>
          {control?.agentPaused && (
            <span className="text-yellow-400 text-[10px]">PAUSED</span>
          )}
          {tab === "stream" && filter && (
            <span className="text-primary text-[10px]">[filter: {filter}]</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(["stream", "audit", "permissions"] as CockpitTab[]).map(t => (
            <button
              key={t}
              data-testid={`cockpit-tab-${t}`}
              className={`px-1.5 py-0.5 cursor-pointer text-[10px] ${
                tab === t ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-primary"
              }`}
              onClick={() => setTab(t)}
            >
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      {pendingPoints.length > 0 && (
        <div className="border-b border-yellow-500/30 bg-yellow-500/5 px-2 py-1 shrink-0">
          <div className="text-yellow-400 text-[10px] font-bold mb-1">APPROVAL REQUIRED</div>
          {pendingPoints.map(tp => (
            <div key={tp.id} className="flex items-center gap-1 py-0.5" data-testid={`takeover-point-${tp.id}`}>
              <span className="text-yellow-400">⚡</span>
              <span className="flex-1 truncate">{tp.action}</span>
              {permBadge(tp.permissionLevel)}
              <button
                data-testid={`tp-confirm-${tp.id}`}
                className="px-1 text-green-400 hover:bg-green-400/20 cursor-pointer"
                onClick={() => resolvePoint.mutate({ id: tp.id, decision: "confirm" })}
              >
                ✓
              </button>
              <button
                data-testid={`tp-reject-${tp.id}`}
                className="px-1 text-red-400 hover:bg-red-400/20 cursor-pointer"
                onClick={() => resolvePoint.mutate({ id: tp.id, decision: "reject" })}
              >
                ✗
              </button>
              <button
                data-testid={`tp-takeover-${tp.id}`}
                className="px-1 text-orange-400 hover:bg-orange-400/20 cursor-pointer text-[10px]"
                onClick={() => resolvePoint.mutate({ id: tp.id, decision: "takeover" })}
              >
                TAKE
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {tab === "stream" && (
          <div className="h-full overflow-y-auto">
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
                        {formatTimeTs(event.timestamp)}
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

            {controlStream.length > 0 && (
              <div>
                <div className="px-2 py-0.5 text-[10px] text-muted-foreground bg-muted/30 border-b border-border sticky top-0">
                  control-bus
                </div>
                {controlStream.map(evt => (
                  <div
                    key={evt.id}
                    className={`px-2 py-0.5 flex items-start gap-1 ${
                      evt.type === "error" ? "text-red-400" :
                      evt.type === "takeover-point" ? "text-yellow-400" :
                      evt.type === "mode-switch" ? "text-blue-400" :
                      "text-foreground"
                    }`}
                    data-testid={`stream-event-${evt.id}`}
                  >
                    <span className="text-muted-foreground text-[10px] shrink-0 w-12">
                      {formatTimeStr(evt.timestamp)}
                    </span>
                    <span className={`shrink-0 w-10 text-[10px] ${
                      evt.actor === "agent" ? "text-blue-400" : "text-orange-400"
                    }`}>
                      {evt.actor === "agent" ? "AGT" : "HUM"}
                    </span>
                    {permBadge(evt.permissionLevel)}
                    <span className="flex-1 truncate">{evt.action}</span>
                    {evt.result && evt.result !== "success" && (
                      <span className="text-muted-foreground text-[10px] shrink-0">({evt.result})</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {pausedExecutions.length > 0 && (
              <div>
                <div className="px-2 py-0.5 text-[10px] text-yellow-400 bg-yellow-400/10 border-b border-border sticky top-0">
                  paused ({pausedExecutions.length})
                </div>
                {pausedExecutions.map(pe => (
                  <div key={pe.id} className="px-2 py-0.5 flex items-start gap-1 text-yellow-300" data-testid={`paused-exec-${pe.id}`}>
                    <span className="text-muted-foreground text-[10px] shrink-0 w-12">
                      {formatTimeStr(pe.pausedAt)}
                    </span>
                    <span className="text-[10px] shrink-0 w-10 text-yellow-400">{pe.type === "program" ? "PRG" : "NAV"}</span>
                    <span className="flex-1 truncate">
                      {pe.programName || `profile:${pe.profileId}/path:${pe.navPathId}`} @ step {pe.stepIndex}
                    </span>
                    <span className="text-[10px] text-muted-foreground shrink-0">awaiting resume</span>
                  </div>
                ))}
              </div>
            )}

            {filteredEvents.length === 0 && controlStream.length === 0 && pausedExecutions.length === 0 && (
              <div className="p-4 text-center text-muted-foreground" data-testid="empty-cockpit">
                No activity events yet. Press Tab to toggle control mode.
              </div>
            )}

            <div ref={bottomRef} />
          </div>
        )}

        {tab === "audit" && (
          <div className="h-full overflow-y-auto px-2 py-1" data-testid="audit-log-view">
            {auditLogs.length === 0 && (
              <div className="text-muted-foreground py-4 text-center">No audit log entries.</div>
            )}
            {auditLogs.map(log => (
              <div key={log.id} className="flex items-start gap-1 py-0.5 border-b border-border/30" data-testid={`audit-entry-${log.id}`}>
                <span className="text-muted-foreground text-[10px] shrink-0 w-16">
                  {formatTimeStr(String(log.createdAt))}
                </span>
                <span className={`shrink-0 w-10 text-[10px] ${
                  log.actor === "agent" ? "text-blue-400" : "text-orange-400"
                }`}>
                  {log.actor === "agent" ? "AGT" : "HUM"}
                </span>
                {permBadge(log.permissionLevel || undefined)}
                <span className="flex-1 truncate">{log.action}</span>
                <span className={`text-[10px] shrink-0 ${
                  log.result === "success" ? "text-green-400" :
                  log.result === "blocked" ? "text-red-400" :
                  "text-muted-foreground"
                }`}>
                  {log.result}
                </span>
              </div>
            ))}
          </div>
        )}

        {tab === "permissions" && (
          <div className="h-full overflow-y-auto px-2 py-1" data-testid="permission-editor">
            {profiles.length === 0 && (
              <div className="text-muted-foreground py-4 text-center">No site profiles configured.</div>
            )}
            {profiles.map(profile => {
              const profilePaths = navPaths.filter(p => p.siteProfileId === profile.id);
              return (
                <div key={profile.id} className="mb-3" data-testid={`permission-profile-${profile.id}`}>
                  <div className="flex items-center gap-2 py-1 border-b border-border">
                    <span className="font-bold text-primary">{profile.name}</span>
                    <span className="text-muted-foreground text-[10px] flex-1 truncate">{profile.baseUrl}</span>
                    <select
                      data-testid={`profile-permission-${profile.id}`}
                      className="bg-background border border-border text-[10px] px-1 py-0.5 text-foreground"
                      value={profile.defaultPermission || "autonomous"}
                      onChange={(e) => updateProfile.mutate({ id: profile.id, defaultPermission: e.target.value })}
                    >
                      <option value="autonomous">autonomous</option>
                      <option value="approval">approval</option>
                      <option value="blocked">blocked</option>
                    </select>
                  </div>
                  {profilePaths.map(np => {
                    const pathActions = actionPerms.filter(a => a.navPathId === np.id);
                    return (
                      <div key={np.id}>
                        <div className="flex items-center gap-2 pl-4 py-0.5" data-testid={`permission-path-${np.id}`}>
                          <span className="text-foreground flex-1 truncate">{np.name}</span>
                          <span className="text-muted-foreground text-[10px]">{np.description}</span>
                          <select
                            data-testid={`path-permission-${np.id}`}
                            className="bg-background border border-border text-[10px] px-1 py-0.5 text-foreground"
                            value={np.permissionLevel || "autonomous"}
                            onChange={(e) => updateNavPath.mutate({ id: np.id, permissionLevel: e.target.value })}
                          >
                            <option value="autonomous">autonomous</option>
                            <option value="approval">approval</option>
                            <option value="blocked">blocked</option>
                          </select>
                        </div>
                        {pathActions.map(ap => (
                          <div key={`${ap.navPathId}-${ap.actionName}`} className="flex items-center gap-2 pl-8 py-0.5" data-testid={`permission-action-${ap.navPathId}-${ap.actionName}`}>
                            <span className="text-muted-foreground text-[10px]">⤷</span>
                            <span className="text-foreground flex-1 truncate text-[10px]">{ap.actionName}</span>
                            <select
                              data-testid={`action-permission-${ap.navPathId}-${ap.actionName}`}
                              className="bg-background border border-border text-[10px] px-1 py-0.5 text-foreground"
                              value={ap.level}
                              onChange={(e) => setActionPerm.mutate({ navPathId: ap.navPathId, actionName: ap.actionName, level: e.target.value })}
                            >
                              <option value="autonomous">autonomous</option>
                              <option value="approval">approval</option>
                              <option value="blocked">blocked</option>
                            </select>
                          </div>
                        ))}
                        <div className="flex items-center gap-1 pl-8 py-0.5">
                          <input
                            data-testid={`add-action-input-${np.id}`}
                            className="bg-background border border-border text-[10px] px-1 py-0.5 text-foreground flex-1"
                            placeholder="action name..."
                            value={newActionName}
                            onChange={(e) => setNewActionName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && newActionName.trim()) {
                                e.stopPropagation();
                                setActionPerm.mutate({ navPathId: np.id, actionName: newActionName.trim(), level: "approval" });
                                setNewActionName("");
                              }
                            }}
                          />
                          <span className="text-muted-foreground text-[10px]">Enter:add</span>
                        </div>
                      </div>
                    );
                  })}
                  {profilePaths.length === 0 && (
                    <div className="pl-4 py-0.5 text-muted-foreground text-[10px]">No navigation paths</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {focusedEvent && tab === "stream" && !navState && (
        <div className="border-t border-border px-2 py-1 bg-muted/20 max-h-32 overflow-y-auto">
          <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
            <span>Event Detail</span>
            <button
              data-testid="close-event-detail"
              className="underline cursor-pointer"
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

      <div className="border-t border-border px-2 py-0.5 text-[10px] text-muted-foreground flex items-center justify-between shrink-0">
        <div className="flex gap-2">
          <span>Tab:control</span>
          {tab === "stream" && <span>j/k:nav</span>}
          {tab === "stream" && <span>f:filter</span>}
        </div>
        <span>{pendingPoints.length > 0 ? `${pendingPoints.length} pending` : `${filteredEvents.length + controlStream.length} events`}</span>
      </div>
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
