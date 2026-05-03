import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import type { Receipt } from "@shared/schema";

interface DailySummary {
  day: string;
  totalCount: number;
  totalCostUsd: number;
  bySurface: Array<{ surface: string; count: number }>;
  upCount: number;
  downCount: number;
  blockedCount: number;
  failedCount: number;
  ratedPct: number;
  positivePct: number;
  biggestCost: { id: number; surface: string; actionVerb: string; target: string | null; costUsd: number } | null;
  topDownSurface: { surface: string; count: number } | null;
}

const STATUS_COLOR: Record<string, string> = {
  executed: "text-green-500",
  failed: "text-red-500",
  "budget-blocked": "text-yellow-500",
  "permission-blocked": "text-orange-500",
};

function fmtTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().slice(11, 19);
}

function fmtUsd(s: string | number): string {
  const n = typeof s === "string" ? parseFloat(s) : s;
  if (!isFinite(n) || n === 0) return "—";
  if (n < 0.01) return "$" + n.toFixed(5);
  return "$" + n.toFixed(4);
}

export default function LedgerView() {
  const qc = useQueryClient();
  const [filterProgram, setFilterProgram] = useState<string>("");
  const [filterSurface, setFilterSurface] = useState<string>("");
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [filterFeedback, setFilterFeedback] = useState<string>("");
  const [filterDay, setFilterDay] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [chainStatus, setChainStatus] = useState<string>("");

  const programRef = useRef<HTMLSelectElement>(null);
  const surfaceRef = useRef<HTMLSelectElement>(null);
  const categoryRef = useRef<HTMLSelectElement>(null);
  const feedbackRef = useRef<HTMLSelectElement>(null);
  const dayRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const queryParams = new URLSearchParams();
  if (filterProgram) queryParams.set("program", filterProgram);
  if (filterSurface) queryParams.set("surface", filterSurface);
  if (filterCategory) queryParams.set("category", filterCategory);
  if (filterFeedback) queryParams.set("feedback", filterFeedback);
  if (filterDay) { queryParams.set("sinceDay", filterDay); queryParams.set("untilDay", filterDay); }
  if (search) queryParams.set("search", search);
  const qs = queryParams.toString();

  const { data: receipts = [] } = useQuery<Receipt[]>({
    queryKey: [`/api/receipts${qs ? "?" + qs : ""}`],
    refetchInterval: 5000,
  });

  const today = new Date().toISOString().slice(0, 10);
  const summaryDay = filterDay || today;
  const { data: summary } = useQuery<DailySummary>({
    queryKey: [`/api/receipts/summary?day=${summaryDay}`],
    refetchInterval: 10000,
  });

  const setFeedback = useMutation({
    mutationFn: async ({ id, feedback }: { id: number; feedback: "up" | "down" | null }) => {
      const res = await apiRequest("POST", `/api/receipts/${id}/feedback`, { feedback });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [`/api/receipts${qs ? "?" + qs : ""}`] });
      qc.invalidateQueries({ queryKey: [`/api/receipts/summary?day=${summaryDay}`] });
    },
  });

  useEffect(() => {
    if (selectedIdx >= receipts.length) setSelectedIdx(Math.max(0, receipts.length - 1));
  }, [receipts.length, selectedIdx]);

  const selected = receipts[selectedIdx];

  const handleVerifyChain = useCallback(async () => {
    setChainStatus("verifying...");
    try {
      const res = await apiRequest("GET", "/api/receipts/verify-chain");
      const r = await res.json();
      setChainStatus(r.ok ? `chain ok (${r.total})` : `BROKEN @${r.brokenAt}: ${r.reason}`);
    } catch (e: any) {
      setChainStatus("verify error: " + (e.message || e));
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      const inField = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Esc always blurs out of any focused field so hotkeys resume.
      if (e.key === "Escape" && inField) {
        e.preventDefault();
        (document.activeElement as HTMLElement)?.blur();
        return;
      }
      if (inField) return;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIdx((i) => Math.min(i + 1, receipts.length - 1));
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "y" || e.key === "Y") {
        if (selected) { e.preventDefault(); setFeedback.mutate({ id: selected.id, feedback: "up" }); }
      } else if (e.key === "n" || e.key === "N") {
        if (selected) { e.preventDefault(); setFeedback.mutate({ id: selected.id, feedback: "down" }); }
      } else if (e.key === "u" || e.key === "U") {
        if (selected) { e.preventDefault(); setFeedback.mutate({ id: selected.id, feedback: null }); }
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        programRef.current?.focus();
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        surfaceRef.current?.focus();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        categoryRef.current?.focus();
      } else if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        feedbackRef.current?.focus();
      } else if (e.key === "d" || e.key === "D") {
        e.preventDefault();
        dayRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [receipts, selected, setFeedback]);

  const programs = useMemo(() => Array.from(new Set(receipts.map(r => r.programName).filter(Boolean) as string[])).sort(), [receipts]);
  const surfaces = useMemo(() => Array.from(new Set(receipts.map(r => r.surface))).sort(), [receipts]);
  const categories = useMemo(() => Array.from(new Set(receipts.map(r => r.category).filter(Boolean) as string[])).sort(), [receipts]);

  return (
    <div className="flex flex-col h-full bg-background text-foreground font-mono text-[11px]" data-testid="ledger-view">
      {/* Daily summary card */}
      <div className="border-b border-border p-2 bg-card" data-testid="ledger-summary">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="font-bold text-primary">RECEIPTS · {summary?.day || summaryDay}</div>
          <div data-testid="text-summary-count">{summary?.totalCount ?? 0} actions</div>
          <div data-testid="text-summary-cost">{fmtUsd(summary?.totalCostUsd ?? 0)} spent</div>
          <div className="text-green-500">👍 {summary?.upCount ?? 0}</div>
          <div className="text-red-500">👎 {summary?.downCount ?? 0}</div>
          <div className="text-yellow-500">blocked {summary?.blockedCount ?? 0}</div>
          <div className="text-red-400">failed {summary?.failedCount ?? 0}</div>
          <div data-testid="text-summary-rated">rated {summary?.ratedPct ?? 0}%</div>
          <div data-testid="text-summary-positive">positive {summary?.positivePct ?? 0}%</div>
          <button
            data-testid="button-verify-chain"
            onClick={handleVerifyChain}
            className="ml-auto px-2 py-0.5 border border-border hover:bg-accent"
          >verify chain</button>
          <a data-testid="link-export-csv" href="/api/receipts/export.csv" className="px-2 py-0.5 border border-border hover:bg-accent">CSV</a>
          <a data-testid="link-export-ndjson" href="/api/receipts/export.ndjson" className="px-2 py-0.5 border border-border hover:bg-accent">NDJSON</a>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-muted-foreground">
          {summary?.biggestCost && (
            <span data-testid="text-summary-biggest">
              biggest: <span className="text-foreground">{summary.biggestCost.surface}/{summary.biggestCost.actionVerb}</span> {fmtUsd(summary.biggestCost.costUsd)}
              {summary.biggestCost.target ? ` → ${summary.biggestCost.target}` : ""}
            </span>
          )}
          {summary?.topDownSurface && (
            <span data-testid="text-summary-topdown">top 👎: <span className="text-red-400">{summary.topDownSurface.surface}</span> ({summary.topDownSurface.count})</span>
          )}
          {summary && summary.bySurface.length > 0 && (
            <span>{summary.bySurface.map(s => <span key={s.surface} className="mr-3">{s.surface}:{s.count}</span>)}</span>
          )}
        </div>
        {chainStatus && <div className="mt-1" data-testid="text-chain-status">{chainStatus}</div>}
      </div>

      {/* Filters */}
      <div className="border-b border-border p-2 flex items-center gap-2 flex-wrap text-[10px]">
        <input
          ref={searchRef}
          data-testid="input-search"
          type="text"
          placeholder="/ search…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-input border border-border px-1 py-0.5 w-40"
        />
        <select ref={programRef} data-testid="select-filter-program" value={filterProgram} onChange={(e) => setFilterProgram(e.target.value)} className="bg-input border border-border px-1 py-0.5">
          <option value="">P: all programs</option>
          {programs.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <select ref={surfaceRef} data-testid="select-filter-surface" value={filterSurface} onChange={(e) => setFilterSurface(e.target.value)} className="bg-input border border-border px-1 py-0.5">
          <option value="">S: all surfaces</option>
          {surfaces.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select ref={categoryRef} data-testid="select-filter-category" value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="bg-input border border-border px-1 py-0.5">
          <option value="">C: all categories</option>
          {categories.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <select ref={feedbackRef} data-testid="select-filter-feedback" value={filterFeedback} onChange={(e) => setFilterFeedback(e.target.value)} className="bg-input border border-border px-1 py-0.5">
          <option value="">F: all feedback</option>
          <option value="up">👍 only</option>
          <option value="down">👎 only</option>
          <option value="none">no feedback</option>
        </select>
        <input ref={dayRef} data-testid="input-filter-day" type="date" value={filterDay} onChange={(e) => setFilterDay(e.target.value)} className="bg-input border border-border px-1 py-0.5" />
        <button data-testid="button-clear-filters" onClick={() => { setFilterProgram(""); setFilterSurface(""); setFilterCategory(""); setFilterFeedback(""); setFilterDay(""); setSearch(""); }} className="px-2 py-0.5 border border-border">clear</button>
        <span className="text-muted-foreground ml-auto">j/k · y/n/u feedback · / search · P/S/C/F/D filter · esc unfocus</span>
      </div>

      {/* Rows */}
      <div className="flex-1 overflow-y-auto" data-testid="list-receipts">
        {receipts.length === 0 ? (
          <div className="p-4 text-muted-foreground text-center" data-testid="text-empty">No receipts match.</div>
        ) : receipts.map((r, idx) => (
          <div
            key={r.id}
            data-testid={`row-receipt-${r.id}`}
            className={`px-2 py-1 border-b border-border/50 cursor-pointer ${idx === selectedIdx ? "bg-accent" : "hover:bg-accent/50"}`}
            onClick={() => setSelectedIdx(idx)}
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground w-16">{fmtTime(r.occurredAt)}</span>
              <span className={STATUS_COLOR[r.status] || "text-foreground"}>●</span>
              <span className="text-primary w-24 truncate" title={r.surface}>{r.surface}</span>
              <span className="font-bold w-20 truncate" title={r.actionVerb}>{r.actionVerb}</span>
              <span className="text-muted-foreground flex-1 truncate" title={r.target || ""}>{r.target || "—"}</span>
              <span className="w-20 text-right">{fmtUsd(r.costUsd)}</span>
              <span className="w-12 text-center">
                {r.feedback === "up" && <span className="text-green-500">👍</span>}
                {r.feedback === "down" && <span className="text-red-500">👎</span>}
                {!r.feedback && <span className="text-muted-foreground">—</span>}
              </span>
              {r.programName && <span className="text-muted-foreground w-32 truncate" title={r.programName}>{r.programName}</span>}
            </div>
          </div>
        ))}
      </div>

      {/* Detail */}
      {selected && (
        <div className="border-t border-border p-2 bg-card max-h-48 overflow-y-auto" data-testid="panel-receipt-detail">
          <div className="flex gap-3 flex-wrap text-[10px]">
            <span data-testid="text-detail-id">#{selected.id}</span>
            <span>chain: <code className="text-primary">{selected.hash.slice(0, 12)}…</code> ← <code>{selected.prevHash ? selected.prevHash.slice(0, 12) + "…" : "GENESIS"}</code></span>
            <span>status: <span className={STATUS_COLOR[selected.status] || ""}>{selected.status}</span></span>
            <span>cost: {fmtUsd(selected.costUsd)}</span>
            <span>walltime: {selected.wallClockMs}ms</span>
            {selected.verifierScore != null && <span>verifier: {selected.verifierScore}</span>}
            {selected.trajectoryId && (
              <a
                data-testid={`link-trajectory-${selected.id}`}
                href={`/?view=cockpit&trajectory=${encodeURIComponent(selected.trajectoryId)}`}
                className="text-primary underline"
                target="_blank"
                rel="noreferrer"
              >trajectory: {selected.trajectoryId.slice(0, 16)}…</a>
            )}
          </div>
          <pre className="mt-1 text-[10px] text-muted-foreground whitespace-pre-wrap" data-testid="text-detail-meta">{JSON.stringify(selected.targetMeta || {}, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
