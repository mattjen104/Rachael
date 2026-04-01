import React, { useState, useCallback, useEffect, useRef } from "react";
import { usePrograms, useToggleProgram, useTriggerProgram, useRuntime, useToggleRuntime } from "@/hooks/use-org-data";
import type { Program } from "@shared/schema";

interface ProgramsViewProps {
  onNavigate?: (view: string, id?: number) => void;
}

export default function ProgramsView({ onNavigate }: ProgramsViewProps) {
  const { data: programs = [], isLoading } = usePrograms();
  const { data: runtime } = useRuntime();
  const toggleProgram = useToggleProgram();
  const triggerProgram = useTriggerProgram();
  const toggleRuntime = useToggleRuntime();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const runtimePrograms = runtime?.programs || [];

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, programs.length - 1));
        break;
      case "k":
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        break;
      case "g":
        e.preventDefault();
        setSelectedIdx(0);
        break;
      case "G":
        e.preventDefault();
        setSelectedIdx(programs.length - 1);
        break;
      case "Tab":
        e.preventDefault();
        const prog = programs[selectedIdx];
        if (prog) setExpandedId(expandedId === prog.id ? null : prog.id);
        break;
      case "Enter":
        e.preventDefault();
        const p = programs[selectedIdx];
        if (p) toggleProgram.mutate(p.id);
        break;
      case "r":
        e.preventDefault();
        const pr = programs[selectedIdx];
        if (pr) triggerProgram.mutate(pr.id);
        break;
      case "R":
        e.preventDefault();
        toggleRuntime.mutate();
        break;
    }
  }, [programs, selectedIdx, expandedId, toggleProgram, triggerProgram, toggleRuntime]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (isLoading) return <div className="p-2 text-muted-foreground" data-testid="loading-programs">Loading...</div>;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="programs-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between items-center">
        <span>PROGRAMS ({programs.length})</span>
        <div className="flex items-center gap-2">
          <span
            data-testid="runtime-toggle"
            className={`cursor-pointer ${runtime?.active ? "text-green-500" : "text-red-500"}`}
            onClick={() => toggleRuntime.mutate()}
          >
            Runtime: {runtime?.active ? "ON" : "OFF"}
          </span>
        </div>
      </div>

      {programs.map((prog, idx) => {
        const sel = idx === selectedIdx;
        const isExpanded = expandedId === prog.id;
        const rp = runtimePrograms.find(p => p.name === prog.name);
        const statusChar = !prog.enabled ? "○" :
          rp?.status === "running" ? "⟳" :
          rp?.status === "queued" ? "…" :
          rp?.status === "error" ? "✗" :
          rp?.status === "completed" ? "✓" : "●";

        return (
          <div key={prog.id}>
            <div
              data-idx={idx}
              data-selected={sel}
              data-testid={`program-item-${prog.id}`}
              className={`px-2 py-1 cursor-pointer select-none flex items-center gap-1 ${
                sel ? "bg-primary/20" : ""
              } ${!prog.enabled ? "text-muted-foreground" : ""}`}
              onClick={() => {
                setSelectedIdx(idx);
                setExpandedId(isExpanded ? null : prog.id);
              }}
            >
              <span className="w-4 shrink-0 text-center">{statusChar}</span>
              <span className="truncate flex-1 font-medium">{prog.name}</span>
              <span className="text-muted-foreground shrink-0 text-[10px]">{prog.costTier}</span>
              {prog.schedule && <span className="text-muted-foreground shrink-0 text-[10px]">{prog.schedule}</span>}
            </div>
            {isExpanded && (
              <div className="px-4 py-1 text-muted-foreground border-l-2 border-primary/30 ml-4 space-y-0.5" data-testid={`program-detail-${prog.id}`}>
                <div>{prog.instructions.slice(0, 200)}</div>
                <div className="flex gap-2 mt-1">
                  <span>type: {prog.type}</span>
                  <span>lang: {prog.codeLang}</span>
                  {prog.code && <span>has-code</span>}
                  {prog.computeTarget && prog.computeTarget !== "local" && (
                    <span data-testid={`compute-target-${prog.id}`} className="text-purple-400">target: {prog.computeTarget}</span>
                  )}
                </div>
                {rp && (
                  <div className="flex gap-2">
                    <span>iter: {rp.iteration}</span>
                    <span>status: {rp.status}</span>
                    {rp.lastRun && <span>last: {new Date(rp.lastRun).toLocaleTimeString()}</span>}
                  </div>
                )}
                {rp?.lastOutput && (
                  <div className="mt-1 text-[10px] max-h-24 overflow-y-auto whitespace-pre-wrap">
                    {rp.lastOutput.slice(0, 500)}
                  </div>
                )}
                {rp?.error && <div className="text-red-400 mt-1">{rp.error}</div>}
                <div className="flex gap-2 mt-1">
                  <button
                    data-testid={`toggle-program-${prog.id}`}
                    className="underline hover:text-primary"
                    onClick={(e) => { e.stopPropagation(); toggleProgram.mutate(prog.id); }}
                  >
                    {prog.enabled ? "disable" : "enable"}
                  </button>
                  <button
                    data-testid={`trigger-program-${prog.id}`}
                    className="underline hover:text-primary"
                    onClick={(e) => { e.stopPropagation(); triggerProgram.mutate(prog.id); }}
                  >
                    run-now
                  </button>
                  <button
                    className="underline hover:text-primary"
                    onClick={(e) => { e.stopPropagation(); onNavigate?.("results"); }}
                  >
                    view-results
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
