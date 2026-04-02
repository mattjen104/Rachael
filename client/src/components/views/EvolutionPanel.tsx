import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getStoredApiKey, apiUrl } from "@/lib/queryClient";

function authHeaders(): Record<string, string> {
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  const key = getStoredApiKey();
  if (key) hdrs["Authorization"] = `Bearer ${key}`;
  return hdrs;
}

interface GateResultEntry {
  passed: boolean;
  reason: string;
  gate: string;
}

interface MetricsSnapshot {
  successRate: number;
  correctionRate: number;
  totalRuns: number;
  successfulRuns: number;
  corrections: number;
}

interface EvolutionVersionEntry {
  id: number;
  version: number;
  status: string;
  changes: Record<string, { before: string; after: string }>;
  gateResults: Record<string, GateResultEntry>;
  metricsSnapshot: MetricsSnapshot | null;
  appliedAt: string;
  rolledBackAt: string | null;
  rollbackReason: string | null;
}

interface EvolutionState {
  currentVersion: number;
  totalVersions: number;
  activeVersion: EvolutionVersionEntry | null;
  recentVersions: EvolutionVersionEntry[];
  metrics: MetricsSnapshot;
  goldenSuiteSize: number;
  unconsolidatedObservations: number;
}

interface GoldenSuiteEntry {
  id: number;
  input: string;
  expectedOutput: string;
  source: string;
  programName: string | null;
  createdAt: string;
}

interface ObservationEntry {
  id: number;
  content: string;
  observationType: string;
  programName: string | null;
  consolidated: boolean;
  createdAt: string;
}

interface MigrationResult {
  migrated: number;
  total: number;
  errors: number;
}

interface JudgeCostSummary {
  today: number;
  cap: number;
  remaining: number;
  breakdown: Record<string, number>;
}

export default function EvolutionPanel() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<"overview" | "versions" | "golden" | "observations" | "costs">("overview");

  const { data: state, isLoading } = useQuery<EvolutionState>({
    queryKey: ["/api/evolution/state"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/evolution/state"), { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch evolution state");
      return res.json();
    },
    refetchInterval: 30000,
  });

  const { data: judgeCosts } = useQuery<JudgeCostSummary>({
    queryKey: ["/api/evolution/judge-costs"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/evolution/judge-costs"), { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch judge costs");
      return res.json();
    },
    refetchInterval: 60000,
  });

  const { data: goldenSuite = [] } = useQuery<GoldenSuiteEntry[]>({
    queryKey: ["/api/evolution/golden-suite"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/evolution/golden-suite"), { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch golden suite");
      return res.json();
    },
    enabled: activeTab === "golden",
  });

  const { data: observations = [] } = useQuery<ObservationEntry[]>({
    queryKey: ["/api/evolution/observations"],
    queryFn: async () => {
      const res = await fetch(apiUrl("/api/evolution/observations"), { headers: authHeaders() });
      if (!res.ok) throw new Error("Failed to fetch observations");
      return res.json();
    },
    enabled: activeTab === "observations",
  });

  const rollbackMutation = useMutation({
    mutationFn: async (versionId: number) => {
      const res = await fetch(apiUrl(`/api/evolution/versions/${versionId}/rollback`), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Rollback failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/evolution/state"] });
    },
  });

  const consolidateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/evolution/consolidate"), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Consolidation failed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/evolution/observations"] });
      queryClient.invalidateQueries({ queryKey: ["/api/evolution/state"] });
    },
  });

  const migrateMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(apiUrl("/api/memory/migrate-to-qdrant"), {
        method: "POST",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error("Migration failed");
      return res.json();
    },
  });

  if (isLoading) {
    return <div className="p-4 text-muted-foreground" data-testid="evolution-loading">Loading evolution state...</div>;
  }

  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "versions" as const, label: "Versions" },
    { id: "golden" as const, label: "Golden Suite" },
    { id: "observations" as const, label: "Observations" },
    { id: "costs" as const, label: "Judge Costs" },
  ];

  return (
    <div className="h-full flex flex-col bg-background text-foreground" data-testid="evolution-panel">
      <div className="flex items-center gap-1 p-2 border-b border-border overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.id}
            data-testid={`tab-${tab.id}`}
            className={`px-3 py-1.5 text-xs font-mono rounded whitespace-nowrap transition-colors ${
              activeTab === tab.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto p-3">
        {activeTab === "overview" && state && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <MetricCard
                label="Evolution Version"
                value={`v${state.currentVersion}`}
                testId="metric-version"
              />
              <MetricCard
                label="Success Rate"
                value={`${(state.metrics.successRate * 100).toFixed(1)}%`}
                testId="metric-success-rate"
                color={state.metrics.successRate >= 0.8 ? "text-green-400" : state.metrics.successRate >= 0.6 ? "text-yellow-400" : "text-red-400"}
              />
              <MetricCard
                label="Total Runs (7d)"
                value={String(state.metrics.totalRuns)}
                testId="metric-total-runs"
              />
              <MetricCard
                label="Corrections"
                value={String(state.metrics.corrections)}
                testId="metric-corrections"
              />
              <MetricCard
                label="Golden Suite"
                value={`${state.goldenSuiteSize} cases`}
                testId="metric-golden-suite"
              />
              <MetricCard
                label="Pending Observations"
                value={String(state.unconsolidatedObservations)}
                testId="metric-observations"
              />
            </div>

            {judgeCosts && (
              <div className="border border-border rounded p-3">
                <h3 className="text-xs font-mono font-bold mb-2 text-muted-foreground">JUDGE COSTS TODAY</h3>
                <div className="flex items-center gap-2 mb-2">
                  <div className="flex-1 bg-muted rounded-full h-2">
                    <div
                      className="bg-primary rounded-full h-2 transition-all"
                      style={{ width: `${Math.min(100, (judgeCosts.today / judgeCosts.cap) * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono" data-testid="cost-display">
                    ${judgeCosts.today.toFixed(4)} / ${judgeCosts.cap.toFixed(2)}
                  </span>
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                data-testid="btn-consolidate"
                className="px-3 py-1.5 text-xs font-mono bg-muted hover:bg-muted/80 rounded transition-colors"
                onClick={() => consolidateMutation.mutate()}
                disabled={consolidateMutation.isPending}
              >
                {consolidateMutation.isPending ? "Consolidating..." : "Consolidate Observations"}
              </button>
              <button
                data-testid="btn-migrate"
                className="px-3 py-1.5 text-xs font-mono bg-muted hover:bg-muted/80 rounded transition-colors"
                onClick={() => migrateMutation.mutate()}
                disabled={migrateMutation.isPending}
              >
                {migrateMutation.isPending ? "Migrating..." : "Migrate to Qdrant"}
              </button>
            </div>

            {migrateMutation.data && (
              <div className="text-xs font-mono p-2 bg-muted rounded" data-testid="migration-result">
                Migration: {(migrateMutation.data as MigrationResult).migrated}/{(migrateMutation.data as MigrationResult).total} migrated, {(migrateMutation.data as MigrationResult).errors} errors
              </div>
            )}
          </div>
        )}

        {activeTab === "versions" && state && (
          <div className="space-y-2">
            {state.recentVersions.length === 0 && (
              <div className="text-xs text-muted-foreground font-mono" data-testid="no-versions">No evolution versions yet</div>
            )}
            {state.recentVersions.map((v: EvolutionVersionEntry) => (
              <div
                key={v.id}
                className="border border-border rounded p-3"
                data-testid={`version-${v.id}`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-mono font-bold">v{v.version}</span>
                  <span className={`text-xs font-mono px-2 py-0.5 rounded ${
                    v.status === "active" ? "bg-green-900/30 text-green-400" :
                    v.status === "rolled_back" ? "bg-red-900/30 text-red-400" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {v.status}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground font-mono mb-2">
                  Applied: {new Date(v.appliedAt).toLocaleString()}
                  {v.rolledBackAt && ` | Rolled back: ${new Date(v.rolledBackAt).toLocaleString()}`}
                </div>
                {v.metricsSnapshot && (
                  <div className="text-xs font-mono text-muted-foreground mb-2">
                    Success: {(v.metricsSnapshot.successRate * 100).toFixed(1)}% |
                    Corrections: {(v.metricsSnapshot.correctionRate * 100).toFixed(1)}%
                  </div>
                )}
                {v.gateResults && Object.keys(v.gateResults).length > 0 && (
                  <div className="text-xs font-mono space-y-1 mb-2">
                    {Object.entries(v.gateResults).map(([gate, result]: [string, GateResultEntry]) => (
                      <div key={gate} className={result.passed ? "text-green-400" : "text-red-400"}>
                        {result.passed ? "✓" : "✗"} {gate}: {result.reason.slice(0, 100)}
                      </div>
                    ))}
                  </div>
                )}
                {v.status === "active" && (
                  <button
                    data-testid={`btn-rollback-${v.id}`}
                    className="px-2 py-1 text-xs font-mono bg-red-900/30 text-red-400 hover:bg-red-900/50 rounded transition-colors"
                    onClick={() => rollbackMutation.mutate(v.id)}
                    disabled={rollbackMutation.isPending}
                  >
                    {rollbackMutation.isPending ? "Rolling back..." : "Rollback"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {activeTab === "golden" && (
          <div className="space-y-2">
            {goldenSuite.length === 0 && (
              <div className="text-xs text-muted-foreground font-mono" data-testid="no-golden">No golden suite entries yet</div>
            )}
            {goldenSuite.map((entry: GoldenSuiteEntry) => (
              <div
                key={entry.id}
                className="border border-border rounded p-3"
                data-testid={`golden-${entry.id}`}
              >
                <div className="text-xs font-mono mb-1">
                  <span className="text-muted-foreground">Input:</span> {entry.input.slice(0, 150)}
                </div>
                <div className="text-xs font-mono mb-1">
                  <span className="text-muted-foreground">Expected:</span> {entry.expectedOutput.slice(0, 150)}
                </div>
                <div className="text-xs font-mono text-muted-foreground">
                  Source: {entry.source} | {entry.programName || "global"} | {new Date(entry.createdAt).toLocaleDateString()}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeTab === "observations" && (
          <div className="space-y-2">
            {observations.length === 0 && (
              <div className="text-xs text-muted-foreground font-mono" data-testid="no-observations">No observations yet</div>
            )}
            {observations.map((obs: ObservationEntry) => (
              <div
                key={obs.id}
                className={`border rounded p-2 text-xs font-mono ${
                  obs.consolidated ? "border-muted bg-muted/30 text-muted-foreground" : "border-border"
                }`}
                data-testid={`observation-${obs.id}`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{obs.observationType}</span>
                  {obs.programName && <span className="text-muted-foreground">{obs.programName}</span>}
                  {obs.consolidated && <span className="text-green-400">✓ consolidated</span>}
                </div>
                <div>{obs.content.slice(0, 300)}</div>
              </div>
            ))}
          </div>
        )}

        {activeTab === "costs" && judgeCosts && (
          <div className="space-y-4">
            <div className="border border-border rounded p-3">
              <h3 className="text-xs font-mono font-bold mb-3 text-muted-foreground">TODAY'S USAGE</h3>
              <div className="grid grid-cols-3 gap-3">
                <MetricCard label="Spent" value={`$${judgeCosts.today.toFixed(4)}`} testId="cost-spent" />
                <MetricCard label="Cap" value={`$${judgeCosts.cap.toFixed(2)}`} testId="cost-cap" />
                <MetricCard
                  label="Remaining"
                  value={`$${judgeCosts.remaining.toFixed(4)}`}
                  testId="cost-remaining"
                  color={judgeCosts.remaining > 1 ? "text-green-400" : judgeCosts.remaining > 0 ? "text-yellow-400" : "text-red-400"}
                />
              </div>
            </div>

            {Object.keys(judgeCosts.breakdown).length > 0 && (
              <div className="border border-border rounded p-3">
                <h3 className="text-xs font-mono font-bold mb-2 text-muted-foreground">BREAKDOWN BY JUDGE</h3>
                <div className="space-y-1">
                  {Object.entries(judgeCosts.breakdown).map(([judge, cost]) => (
                    <div key={judge} className="flex justify-between text-xs font-mono">
                      <span className="text-muted-foreground">{judge}</span>
                      <span>${(cost as number).toFixed(4)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricCard({ label, value, testId, color }: { label: string; value: string; testId: string; color?: string }) {
  return (
    <div className="border border-border rounded p-2" data-testid={testId}>
      <div className="text-[10px] font-mono text-muted-foreground uppercase">{label}</div>
      <div className={`text-lg font-mono font-bold ${color || ""}`}>{value}</div>
    </div>
  );
}
