import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, apiUrl, getStoredApiKey } from "@/lib/queryClient";
import type {
  TrajectoryRunSummary,
  TrajectoryRunDetail,
  TrajectoryEvent,
  TrajectoryBranchView,
  TrajectoryDiffResponse,
  TrajectoryDiffEntry,
  TrajectoryUnlockResponse,
  TrajectoryCandidate,
} from "@shared/trajectory-types";

const KIND_COLORS: Record<string, string> = {
  decision: "text-blue-400",
  observe: "text-cyan-400",
  act: "text-emerald-400",
  verify: "text-violet-400",
  recovery: "text-yellow-400",
  escalate: "text-orange-400",
  "budget-deny": "text-red-400",
  "tier-miss": "text-amber-400",
  takeover: "text-pink-400",
  complete: "text-green-400",
  abort: "text-red-500",
};

function Panel({ title, children, testId }: { title: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="border border-border rounded p-2 bg-card flex flex-col min-h-0" data-testid={testId}>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">{title}</div>
      <div className="flex-1 overflow-auto text-xs font-mono">{children}</div>
    </div>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex gap-2 leading-tight">
      <span className="text-muted-foreground w-24 shrink-0">{k}</span>
      <span className="break-all">{v}</span>
    </div>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  return target.isContentEditable;
}

function readMetadataString(metadata: TrajectoryEvent["metadata"], key: string): string | undefined {
  if (!metadata) return undefined;
  const v = metadata[key];
  return typeof v === "string" ? v : undefined;
}

function readCandidates(metadata: TrajectoryEvent["metadata"]): TrajectoryCandidate[] {
  if (!metadata) return [];
  const c = metadata.candidates;
  return Array.isArray(c) ? (c as TrajectoryCandidate[]) : [];
}

interface ScreenshotPanelProps {
  runId: string;
  imageRef: string | undefined;
  rawAvailable: boolean;
  unlockToken: string | null;
  onUnlockNeeded: () => Promise<string | null>;
}

function ScreenshotPanel({ runId, imageRef, rawAvailable, unlockToken, onUnlockNeeded }: ScreenshotPanelProps) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const realRef = imageRef && imageRef !== "[REDACTED]" ? imageRef : null;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setBlobUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    if (!realRef) return;
    setLoading(true);
    (async () => {
      try {
        // Goes through apiRequest so the configured API base + Bearer key
        // come along; raw-unlock token is added as an extra header so it
        // never appears in URLs or logs.
        const r = await apiRequest(
          "GET",
          `/api/trajectory/screenshot/${encodeURIComponent(runId)}/${encodeURIComponent(realRef)}`,
          undefined,
          unlockToken ? { "X-Unlock-Token": unlockToken } : undefined,
        );
        const blob = await r.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        setBlobUrl(url);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [runId, realRef, unlockToken]);

  if (!realRef && !rawAvailable) {
    return (
      <div className="text-muted-foreground space-y-1">
        <div>screenshot ref redacted</div>
        <button
          className="px-1.5 py-0.5 border border-border rounded hover:bg-muted text-[10px]"
          onClick={() => void onUnlockNeeded()}
          data-testid="button-unlock-screenshot"
        >request raw unlock</button>
      </div>
    );
  }
  if (!realRef) return <span className="text-muted-foreground">no screenshot</span>;
  if (loading) return <span className="text-muted-foreground">loading…</span>;
  if (error) return <span className="text-red-400">screenshot error: {error}</span>;
  if (!blobUrl) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="space-y-1">
      <img src={blobUrl} alt={unlockToken ? "raw screenshot (audit-logged)" : "redacted screenshot placeholder"} className="max-w-full border border-border rounded" data-testid="img-screenshot" />
      <div className="text-[10px] text-muted-foreground">{unlockToken ? "raw bytes — audit-logged on every fetch" : "REDACTED placeholder; unlock raw to view bytes"}</div>
    </div>
  );
}

interface ObservationDetailProps {
  event: TrajectoryEvent;
  runId: string;
  rawAvailable: boolean;
  unlockToken: string | null;
  onUnlockNeeded: () => Promise<string | null>;
}

function ObservationDetail({ event, runId, rawAvailable, unlockToken, onUnlockNeeded }: ObservationDetailProps) {
  const tree = readMetadataString(event.metadata, "tree");
  const text = readMetadataString(event.metadata, "text");
  const obsKind = event.observation?.kind ?? event.attemptedObservation ?? "—";
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <KV k="kind" v={obsKind} />
        <KV k="digest" v={event.observation?.digest ?? "—"} />
        <KV k="surface" v={`${event.surfaceKind} (${event.surfaceId})`} />
        <KV k="imageRef" v={event.observation?.imageRef ?? "—"} />
        {event.fallbackChain && event.fallbackChain.length > 0 && (
          <KV k="fallback" v={event.fallbackChain.join(" → ")} />
        )}
      </div>
      <ScreenshotPanel runId={runId} imageRef={event.observation?.imageRef} rawAvailable={rawAvailable} unlockToken={unlockToken} onUnlockNeeded={onUnlockNeeded} />
      {tree && (
        <details>
          <summary className="text-muted-foreground cursor-pointer">a11y tree ({obsKind})</summary>
          <pre className="text-[10px] whitespace-pre-wrap break-all max-h-48 overflow-auto" data-testid="text-tree-dump">{tree}</pre>
        </details>
      )}
      {text && (
        <details>
          <summary className="text-muted-foreground cursor-pointer">text dump</summary>
          <pre className="text-[10px] whitespace-pre-wrap break-all max-h-48 overflow-auto" data-testid="text-text-dump">{text}</pre>
        </details>
      )}
    </div>
  );
}

function CandidateExplainer({ event }: { event: TrajectoryEvent }) {
  const candidates = readCandidates(event.metadata);
  const picked = typeof event.metadata?.pickedCandidateIndex === "number"
    ? (event.metadata.pickedCandidateIndex as number)
    : undefined;
  if (!candidates.length && !event.fallbackChain?.length && !event.attemptedLocator) {
    return <span className="text-muted-foreground">no candidate trace recorded</span>;
  }
  return (
    <div className="space-y-2">
      <div className="text-[10px] text-muted-foreground">Why did it click here?</div>
      <KV k="locator" v={event.attemptedLocator ?? "—"} />
      {event.fallbackChain && event.fallbackChain.length > 0 && (
        <KV k="fallback" v={event.fallbackChain.join(" → ")} />
      )}
      {candidates.length > 0 && (
        <div className="space-y-1">
          <div className="text-muted-foreground">candidates ({candidates.length})</div>
          {candidates.map((c, i) => (
            <div
              key={i}
              className={`flex gap-2 ${picked === i ? "text-emerald-400" : ""}`}
              data-testid={`candidate-${i}`}
            >
              <span className="w-4 text-right">{i}</span>
              <span className="w-12 truncate">{c.source ?? "?"}</span>
              <span className="w-12">{c.score != null ? c.score.toFixed(2) : ""}</span>
              <span className="truncate flex-1">{c.label ?? ""}</span>
              {picked === i && <span className="text-[10px]">←picked</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TrajectoryView() {
  const qc = useQueryClient();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [stepIdx, setStepIdx] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorJson, setEditorJson] = useState("");
  const [diffData, setDiffData] = useState<TrajectoryDiffResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  // Active raw-unlock session token. Persisted in component state only —
  // sent via X-Unlock-Token header on detail and screenshot requests, never
  // as a query string.
  const [unlockToken, setUnlockToken] = useState<string | null>(null);
  const stepListRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const runsQuery = useQuery<TrajectoryRunSummary[]>({
    queryKey: ["/api/trajectory/runs"],
    refetchInterval: 5000,
  });

  // Custom queryFn so the active raw-unlock token (if any) is included on
  // every poll via X-Unlock-Token. This keeps "raw mode" durable for the
  // 5-min session window — without it, normal React Query polling would
  // silently overwrite the unlocked payload back to redacted within seconds.
  const detailQuery = useQuery<TrajectoryRunDetail>({
    queryKey: ["/api/trajectory/runs", selectedRunId, unlockToken ? "raw" : "redacted"],
    enabled: !!selectedRunId,
    refetchInterval: selectedRunId ? 4000 : false,
    queryFn: async () => {
      if (!selectedRunId) throw new Error("no run selected");
      const url = unlockToken
        ? `/api/trajectory/runs/${encodeURIComponent(selectedRunId)}?raw=1`
        : `/api/trajectory/runs/${encodeURIComponent(selectedRunId)}`;
      const headers: Record<string, string> = {};
      const apiKey = getStoredApiKey();
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      if (unlockToken) headers["X-Unlock-Token"] = unlockToken;
      const r = await fetch(apiUrl(url), { headers, credentials: "include", cache: "no-store" });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      return (await r.json()) as TrajectoryRunDetail;
    },
  });

  useEffect(() => {
    if (!selectedRunId && runsQuery.data?.length) {
      setSelectedRunId(runsQuery.data[0].runId);
    }
  }, [runsQuery.data, selectedRunId]);

  const events: TrajectoryEvent[] = detailQuery.data?.events ?? [];
  const currentEvent = events[stepIdx];

  useEffect(() => {
    if (stepIdx >= events.length && events.length > 0) {
      setStepIdx(events.length - 1);
    }
  }, [events.length, stepIdx]);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  // ──────────────── HITL actions ────────────────

  async function doTakeover() {
    if (!selectedRunId) return;
    setBusy(true);
    try {
      const res = await apiRequest("POST", `/api/trajectory/runs/${selectedRunId}/takeover`, {
        stepIndex: stepIdx,
        reason: "analyst-takeover",
        actor: "analyst",
      });
      const data = (await res.json()) as { branch: TrajectoryBranchView };
      flash(`Takeover: branch ${data.branch.branchId} (paused at step ${stepIdx})`);
      qc.invalidateQueries({ queryKey: ["/api/trajectory/runs", selectedRunId] });
    } catch (err) {
      flash(`Takeover failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function openEditor() {
    if (!currentEvent) return;
    const seed = {
      verb: currentEvent.actionVerb ?? "",
      locator: currentEvent.attemptedLocator ?? "",
      reason: currentEvent.reason,
    };
    setEditorJson(JSON.stringify(seed, null, 2));
    setEditorOpen(true);
  }

  async function submitEditedAction() {
    if (!selectedRunId) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(editorJson) as Record<string, unknown>; }
    catch (e) { flash(`Invalid JSON: ${(e as Error).message}`); return; }
    setBusy(true);
    try {
      const res = await apiRequest("POST", `/api/trajectory/runs/${selectedRunId}/takeover`, {
        stepIndex: stepIdx,
        reason: "edit-resume",
        editedAction: parsed,
        actor: "analyst",
      });
      const tk = (await res.json()) as { branch: TrajectoryBranchView };
      // Immediately resume into a child run so the branch lifecycle completes.
      const resumeRes = await apiRequest("POST", `/api/trajectory/branches/${tk.branch.branchId}/resume`, {});
      const resume = (await resumeRes.json()) as { branch: TrajectoryBranchView; childRunId: string };
      flash(`Edit-resume → child run ${resume.childRunId}`);
      setEditorOpen(false);
      qc.invalidateQueries({ queryKey: ["/api/trajectory/runs", selectedRunId] });
    } catch (err) {
      flash(`Edit-resume failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function abortBranch(branchId: string) {
    setBusy(true);
    try {
      await apiRequest("POST", `/api/trajectory/branches/${branchId}/abort`, {});
      flash(`Branch ${branchId} aborted`);
      qc.invalidateQueries({ queryKey: ["/api/trajectory/runs", selectedRunId] });
    } catch (err) {
      flash(`Abort failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function resumeBranch(branchId: string) {
    setBusy(true);
    try {
      const r = await apiRequest("POST", `/api/trajectory/branches/${branchId}/resume`, {});
      const data = (await r.json()) as { branch: TrajectoryBranchView; childRunId: string };
      flash(`Resumed → child ${data.childRunId}`);
      qc.invalidateQueries({ queryKey: ["/api/trajectory/runs", selectedRunId] });
    } catch (err) {
      flash(`Resume failed: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  function promptDiff() {
    if (!selectedRunId) return;
    const branches = detailQuery.data?.branches ?? [];
    const candidate = branches.find((b) => b.childRunId)?.childRunId;
    const target = window.prompt("Diff against runId:", candidate ?? "");
    if (!target) return;
    void loadDiff(selectedRunId, target);
  }

  async function loadDiff(a: string, b: string) {
    try {
      const res = await apiRequest("GET", `/api/trajectory/runs/${a}/diff?vs=${encodeURIComponent(b)}`);
      const data = (await res.json()) as TrajectoryDiffResponse;
      setDiffData(data);
    } catch (err) {
      flash(`Diff failed: ${(err as Error).message}`);
    }
  }

  // Mints a session-scoped unlock token (5-min TTL, header-delivered, every
  // use audit-logged). The token is held in component state; the custom
  // queryFn above will then attach it to every detail poll. revoke via
  // lockRaw() to end the session early.
  async function unlockRaw(): Promise<string | null> {
    if (!selectedRunId) return null;
    const reason = window.prompt("Unlock raw observation/screenshot. Reason (audit-logged, ≥3 chars):");
    if (!reason || reason.length < 3) return null;
    try {
      const res = await apiRequest("POST", `/api/trajectory/runs/${selectedRunId}/unlock-raw`, {
        actor: "analyst",
        reason,
      });
      const { token } = (await res.json()) as TrajectoryUnlockResponse;
      setUnlockToken(token);
      // Invalidate so the queryFn re-runs with the new token.
      qc.invalidateQueries({ queryKey: ["/api/trajectory/runs", selectedRunId] });
      flash("Raw mode active (5 min, audit-logged on each fetch)");
      return token;
    } catch (err) {
      flash(`Unlock failed: ${(err as Error).message}`);
      return null;
    }
  }

  async function lockRaw() {
    if (!selectedRunId || !unlockToken) return;
    try {
      await apiRequest(
        "POST",
        `/api/trajectory/runs/${encodeURIComponent(selectedRunId)}/lock-raw`,
        undefined,
        { "X-Unlock-Token": unlockToken },
      );
    } catch {
      // best-effort; we always clear locally
    }
    setUnlockToken(null);
    qc.invalidateQueries({ queryKey: ["/api/trajectory/runs", selectedRunId] });
    flash("Raw mode revoked");
  }

  // ──────────────── Filtered run list (for `/` search) ────────────────

  const filteredRuns = useMemo(() => {
    const all = runsQuery.data ?? [];
    if (!searchTerm.trim()) return all;
    const q = searchTerm.toLowerCase();
    return all.filter((r) =>
      r.runId.toLowerCase().includes(q) ||
      (r.programName ?? "").toLowerCase().includes(q) ||
      r.surfaceKind.toLowerCase().includes(q) ||
      r.status.toLowerCase().includes(q),
    );
  }, [runsQuery.data, searchTerm]);

  // ──────────────── Keyboard ────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) {
        // Allow Esc to close search even from inside the search input.
        if (e.key === "Escape" && searchOpen) { setSearchOpen(false); setSearchTerm(""); }
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "/") { e.preventDefault(); setSearchOpen(true); setTimeout(() => searchInputRef.current?.focus(), 10); return; }
      if (e.key === "?") { e.preventDefault(); setShowHelp((s) => !s); return; }
      if (e.key === "Escape") {
        if (editorOpen) { setEditorOpen(false); return; }
        if (showHelp) { setShowHelp(false); return; }
        if (diffData) { setDiffData(null); return; }
        if (searchOpen) { setSearchOpen(false); setSearchTerm(""); return; }
      }
      if (!selectedRunId || !events.length) return;
      if (e.key === "j") { e.preventDefault(); setStepIdx((i) => Math.min(events.length - 1, i + 1)); }
      else if (e.key === "k") { e.preventDefault(); setStepIdx((i) => Math.max(0, i - 1)); }
      else if (e.key === "g") { e.preventDefault(); setStepIdx(0); }
      else if (e.key === "G") { e.preventDefault(); setStepIdx(events.length - 1); }
      else if (e.key === "t") { e.preventDefault(); void doTakeover(); }
      else if (e.key === "e") { e.preventDefault(); openEditor(); }
      else if (e.key === ",") { e.preventDefault(); promptDiff(); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const el = document.querySelector<HTMLDivElement>(`[data-step-idx="${stepIdx}"]`);
        el?.scrollIntoView({ block: "nearest" });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRunId, events.length, stepIdx, editorOpen, showHelp, diffData, searchOpen]);

  useEffect(() => {
    const el = document.querySelector<HTMLDivElement>(`[data-step-idx="${stepIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [stepIdx]);

  const summary = useMemo(() => {
    if (!detailQuery.data) return null;
    const d = detailQuery.data;
    return `steps:${d.totalSteps} miss:${d.tierMisses} coords:${d.coordClicks} cost:$${d.estimatedCostUsd}`;
  }, [detailQuery.data]);

  return (
    <div className="h-full flex flex-col bg-background text-foreground" data-testid="view-trajectory">
      {/* Top bar */}
      <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs font-mono">
        <span className="text-muted-foreground">RUN</span>
        <select
          className="bg-card border border-border rounded px-1 py-0.5 text-xs max-w-[260px]"
          value={selectedRunId ?? ""}
          onChange={(e) => { setSelectedRunId(e.target.value); setStepIdx(0); }}
          data-testid="select-run"
        >
          <option value="">— select —</option>
          {filteredRuns.map((r) => (
            <option key={r.runId} value={r.runId}>
              {r.runId.slice(0, 18)} · {r.programName ?? "?"} · {r.surfaceKind} · {r.status}
            </option>
          ))}
        </select>
        {summary && <span className="text-muted-foreground" data-testid="text-summary">{summary}</span>}
        {detailQuery.data?.rawAvailable && <span className="text-amber-400" data-testid="badge-raw">RAW</span>}
        {detailQuery.data && !detailQuery.data.rawAvailable && (
          <span className="text-emerald-400" data-testid="badge-redacted">REDACTED ({detailQuery.data.redactedFieldCount})</span>
        )}
        <div className="flex-1" />
        <button className="px-2 py-0.5 border border-border rounded hover:bg-muted disabled:opacity-50" onClick={doTakeover} disabled={!selectedRunId || busy} data-testid="button-takeover">t: take over</button>
        <button className="px-2 py-0.5 border border-border rounded hover:bg-muted disabled:opacity-50" onClick={openEditor} disabled={!currentEvent || busy} data-testid="button-edit">e: edit-resume</button>
        <button className="px-2 py-0.5 border border-border rounded hover:bg-muted disabled:opacity-50" onClick={promptDiff} disabled={!selectedRunId} data-testid="button-diff">, : diff</button>
        {unlockToken
          ? <button className="px-2 py-0.5 border border-amber-400 text-amber-400 rounded hover:bg-muted" onClick={() => void lockRaw()} data-testid="button-lock">lock raw</button>
          : <button className="px-2 py-0.5 border border-border rounded hover:bg-muted" onClick={() => void unlockRaw()} disabled={!selectedRunId} data-testid="button-unlock">unlock raw</button>}
        <button className="px-2 py-0.5 border border-border rounded hover:bg-muted" onClick={() => setShowHelp((s) => !s)} data-testid="button-help">?</button>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="border-b border-border px-2 py-1 text-xs font-mono flex items-center gap-2" data-testid="bar-search">
          <span className="text-muted-foreground">/</span>
          <input
            ref={searchInputRef}
            className="flex-1 bg-card border border-border rounded px-1 py-0.5 text-xs"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="filter runs (runId/program/surface/status)"
            data-testid="input-search"
          />
          <button className="px-2 py-0.5 border border-border rounded" onClick={() => { setSearchOpen(false); setSearchTerm(""); }} data-testid="button-close-search">esc</button>
        </div>
      )}

      {/* Body */}
      <div className="flex-1 grid grid-cols-[200px_1fr] min-h-0">
        {/* Step timeline */}
        <div ref={stepListRef} className="border-r border-border overflow-auto" data-testid="list-steps">
          {events.length === 0 && <div className="p-2 text-xs text-muted-foreground">No frames yet</div>}
          {events.map((ev, i) => {
            const prev = i > 0 ? events[i - 1] : undefined;
            const latencyMs = prev && typeof ev.ts === "number" && typeof prev.ts === "number"
              ? Math.max(0, ev.ts - prev.ts) : null;
            const tier = ev.attemptedObservation ?? "—";
            const source = ev.modelId ?? "—";
            return (
              <div
                key={ev.id || i}
                data-step-idx={i}
                data-testid={`step-${i}`}
                onClick={() => setStepIdx(i)}
                className={`px-2 py-1 text-[11px] font-mono cursor-pointer border-l-2 ${i === stepIdx ? "bg-muted border-l-primary" : "border-l-transparent hover:bg-muted/50"}`}
              >
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground w-6 text-right">{ev.stepIndex}</span>
                  <span className={KIND_COLORS[ev.kind] ?? "text-foreground"}>{ev.kind}</span>
                  <span className="text-muted-foreground flex-1 truncate" data-testid={`step-tier-${i}`}>{tier}</span>
                  <button
                    title="take over from this step"
                    onClick={(e) => { e.stopPropagation(); setStepIdx(i); void doTakeover(); }}
                    className="text-amber-400 hover:text-amber-300 px-1"
                    data-testid={`button-takeover-step-${i}`}
                    disabled={busy}
                  >t</button>
                </div>
                <div className="flex gap-2 pl-8 text-[10px] text-muted-foreground">
                  <span data-testid={`step-source-${i}`}>{source}</span>
                  <span data-testid={`step-latency-${i}`}>{latencyMs != null ? `${latencyMs}ms` : "—"}</span>
                </div>
                <div className="text-muted-foreground truncate pl-8">{ev.reason}</div>
              </div>
            );
          })}
        </div>

        {/* Four panels */}
        <div className="grid grid-cols-2 grid-rows-2 gap-2 p-2 min-h-0">
          <Panel title="Observation" testId="panel-observation">
            {currentEvent && selectedRunId
              ? <ObservationDetail event={currentEvent} runId={selectedRunId} rawAvailable={!!detailQuery.data?.rawAvailable} unlockToken={unlockToken} onUnlockNeeded={unlockRaw} />
              : <span className="text-muted-foreground">—</span>}
          </Panel>

          <Panel title="Decision · Why did it click here?" testId="panel-decision">
            {currentEvent ? (
              <div className="space-y-2">
                <KV k="kind" v={<span className={KIND_COLORS[currentEvent.kind] ?? ""}>{currentEvent.kind}</span>} />
                <KV k="reason" v={currentEvent.reason} />
                <KV k="model" v={currentEvent.modelId ?? "—"} />
                <KV k="cost" v={currentEvent.estimatedCost != null ? `$${currentEvent.estimatedCost.toFixed(4)}` : "—"} />
                <CandidateExplainer event={currentEvent} />
              </div>
            ) : <span className="text-muted-foreground">—</span>}
          </Panel>

          <Panel title="Action" testId="panel-action">
            {currentEvent ? (
              <div className="space-y-1">
                <KV k="verb" v={currentEvent.actionVerb ?? "—"} />
                <KV k="locator" v={currentEvent.attemptedLocator ?? "—"} />
                <KV k="kind" v={currentEvent.kind} />
                <div className="mt-2 text-[10px] text-muted-foreground">Press <kbd>e</kbd> to edit and resume.</div>
              </div>
            ) : <span className="text-muted-foreground">—</span>}
          </Panel>

          <Panel title="Verifier" testId="panel-verifier">
            {currentEvent?.verifier ? (
              <div className="space-y-1">
                <KV k="kind" v={currentEvent.verifier.kind} />
                <KV k="ok" v={currentEvent.verifier.result?.ok == null ? "—" : (currentEvent.verifier.result.ok ? "yes" : "no")} />
                <KV k="reason" v={currentEvent.verifier.result?.reason ?? "—"} />
              </div>
            ) : <span className="text-muted-foreground">no verifier on this frame</span>}
          </Panel>
        </div>
      </div>

      {/* Branches strip */}
      {detailQuery.data && detailQuery.data.branches.length > 0 && (
        <div className="border-t border-border px-2 py-1 text-[10px] font-mono flex gap-2 overflow-x-auto" data-testid="list-branches">
          <span className="text-muted-foreground">BRANCHES</span>
          {detailQuery.data.branches.map((b) => (
            <div key={b.branchId} className="flex items-center gap-1 border border-border rounded px-1 py-0.5" data-testid={`branch-${b.branchId}`} title={b.notes ?? ""}>
              <span>step {b.parentStepIndex} · {b.reason} · <span className={b.status === "completed" ? "text-emerald-400" : b.status === "aborted" ? "text-red-400" : "text-amber-400"}>{b.status}</span></span>
              {b.childRunId && (
                <button className="px-1 hover:bg-muted rounded" onClick={() => loadDiff(selectedRunId!, b.childRunId!)} data-testid={`button-diff-${b.branchId}`}>diff</button>
              )}
              {b.status === "pending" && (
                <>
                  <button className="px-1 hover:bg-muted rounded text-emerald-400" onClick={() => void resumeBranch(b.branchId)} data-testid={`button-resume-${b.branchId}`}>resume</button>
                  <button className="px-1 hover:bg-muted rounded text-red-400" onClick={() => void abortBranch(b.branchId)} data-testid={`button-abort-${b.branchId}`}>abort</button>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-4 right-4 bg-card border border-border rounded px-3 py-2 text-xs font-mono shadow-lg" data-testid="text-toast">{toast}</div>
      )}

      {/* Help overlay */}
      {showHelp && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setShowHelp(false)} data-testid="overlay-help">
          <div className="bg-card border border-border rounded p-4 text-xs font-mono space-y-1" onClick={(e) => e.stopPropagation()}>
            <div className="text-sm mb-2 font-bold">Trajectory Inspector — keys</div>
            <KV k="j / k" v="next / prev step" />
            <KV k="g / G" v="first / last step" />
            <KV k="Enter" v="scroll step into view" />
            <KV k="/" v="search runs" />
            <KV k="t" v="take over (pause + branch)" />
            <KV k="e" v="edit action and resume" />
            <KV k=", (comma)" v="diff against another runId" />
            <KV k="?" v="toggle this help" />
            <KV k="Esc" v="close overlay / editor / search" />
            <div className="mt-2 text-muted-foreground">Observations and screenshots are redacted by default. "Unlock raw" mints a one-time, header-delivered token (5 min, audit-logged).</div>
          </div>
        </div>
      )}

      {/* Action editor */}
      {editorOpen && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" data-testid="overlay-editor">
          <div className="bg-card border border-border rounded p-4 w-[480px]">
            <div className="text-xs font-mono mb-2">Edit action @ step {stepIdx} → resume</div>
            <textarea
              className="w-full h-48 bg-background border border-border rounded p-2 text-xs font-mono"
              value={editorJson}
              onChange={(e) => setEditorJson(e.target.value)}
              data-testid="input-edited-action"
            />
            <div className="flex gap-2 justify-end mt-2 text-xs font-mono">
              <button className="px-2 py-1 border border-border rounded hover:bg-muted" onClick={() => setEditorOpen(false)} data-testid="button-cancel-edit">Cancel</button>
              <button className="px-2 py-1 border border-primary text-primary rounded hover:bg-primary/10 disabled:opacity-50" onClick={submitEditedAction} disabled={busy} data-testid="button-submit-edit">Resume</button>
            </div>
          </div>
        </div>
      )}

      {/* Diff drawer */}
      {diffData && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={() => setDiffData(null)} data-testid="overlay-diff">
          <div className="bg-card border border-border rounded p-4 w-[800px] max-h-[80vh] overflow-auto" onClick={(e) => e.stopPropagation()}>
            <div className="text-xs font-mono mb-2 flex items-center gap-2">
              <span>DIFF</span>
              <span className="text-muted-foreground">{diffData.left.runId}</span>
              <span>vs</span>
              <span className="text-muted-foreground">{diffData.right.runId}</span>
              <button className="ml-auto px-2 py-0.5 border border-border rounded" onClick={() => setDiffData(null)} data-testid="button-close-diff">close</button>
            </div>
            <div className="text-[11px] font-mono space-y-2">
              {diffData.diffs.length === 0 && <div className="text-muted-foreground">no differences</div>}
              {diffData.diffs.map((d: TrajectoryDiffEntry) => (
                <div key={d.stepIndex} className="border border-border rounded p-2" data-testid={`diff-row-${d.stepIndex}`}>
                  <div className="text-muted-foreground">step {d.stepIndex} · changed: {d.changed.join(", ")}</div>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <pre className="bg-background rounded p-1 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(d.left ?? {}, null, 1)}</pre>
                    <pre className="bg-background rounded p-1 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(d.right ?? {}, null, 1)}</pre>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
