import React, { useState, useCallback, useEffect, useRef } from "react";
import { useResults } from "@/hooks/use-org-data";
import { getStoredApiKey } from "@/lib/queryClient";
import type { AgentResult } from "@shared/schema";

function trackRadarEngagement(url: string, source: string, title: string) {
  const hdrs: Record<string, string> = { "Content-Type": "application/json" };
  const key = getStoredApiKey();
  if (key) hdrs["Authorization"] = `Bearer ${key}`;
  fetch("/api/radar/engagement", {
    method: "POST",
    headers: hdrs,
    body: JSON.stringify({ url, source, title, programName: "research-radar" }),
  }).catch(() => {});
}

function renderLinkedText(text: string, programName: string): React.ReactNode {
  if (programName !== "research-radar") return text;
  const urlRegex = /(https?:\/\/[^\s)\]>,]+)/g;
  const parts = text.split(urlRegex);
  return parts.map((part, i) => {
    if (urlRegex.test(part)) {
      urlRegex.lastIndex = 0;
      const source = part.includes("reddit.com") ? "reddit" : part.includes("github.com") ? "github" : part.includes("ycombinator") ? "hn" : "other";
      return (
        <a
          key={i}
          href={part}
          target="_blank"
          rel="noopener noreferrer"
          data-testid={`engagement-link-${i}`}
          className="text-primary underline hover:text-primary/80"
          onClick={(e) => {
            e.stopPropagation();
            const lineStart = text.lastIndexOf("\n", text.indexOf(part)) + 1;
            const lineEnd = text.indexOf("\n", text.indexOf(part));
            const line = text.slice(lineStart, lineEnd > 0 ? lineEnd : undefined).trim();
            trackRadarEngagement(part, source, line.slice(0, 200));
          }}
        >
          {part}
        </a>
      );
    }
    urlRegex.lastIndex = 0;
    return part;
  });
}

interface ResultsViewProps {
  selectedResultId?: number;
}

export default function ResultsView({ selectedResultId }: ResultsViewProps) {
  const { data: results = [], isLoading } = useResults(undefined, 100);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(selectedResultId || null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedResultId && results.length > 0) {
      const idx = results.findIndex(r => r.id === selectedResultId);
      if (idx >= 0) {
        setSelectedIdx(idx);
        setExpandedId(selectedResultId);
      }
    }
  }, [selectedResultId, results]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, results.length - 1));
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
        setSelectedIdx(results.length - 1);
        break;
      case "Tab":
        e.preventDefault();
        const r = results[selectedIdx];
        if (r) setExpandedId(expandedId === r.id ? null : r.id);
        break;
    }
  }, [results, selectedIdx, expandedId]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (isLoading) return <div className="p-2 text-muted-foreground" data-testid="loading-results">Loading...</div>;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="results-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10">
        RESULTS ({results.length})
      </div>

      {results.map((r, idx) => {
        const sel = idx === selectedIdx;
        const isExpanded = expandedId === r.id;
        const time = r.createdAt ? new Date(r.createdAt).toLocaleString() : "";

        return (
          <div key={r.id}>
            <div
              data-idx={idx}
              data-selected={sel}
              data-testid={`result-row-${r.id}`}
              className={`px-2 py-0.5 cursor-pointer select-none flex items-center gap-1 ${
                sel ? "bg-primary/20" : ""
              } ${r.status === "error" ? "text-red-400" : ""}`}
              onClick={() => {
                setSelectedIdx(idx);
                setExpandedId(isExpanded ? null : r.id);
              }}
            >
              <span className="w-3 shrink-0 text-center">{r.status === "ok" ? "✓" : "✗"}</span>
              <span className="w-24 shrink-0 truncate font-medium">{r.programName}</span>
              <span className="truncate flex-1">{r.summary}</span>
              {r.metric && <span className="text-muted-foreground shrink-0">={r.metric}</span>}
            </div>
            {isExpanded && (r.rawOutput || r.summary) && (
              <div
                className="px-4 py-2 text-muted-foreground border-l-2 border-primary/30 ml-4 max-h-60 overflow-y-auto whitespace-pre-wrap text-[10px]"
                data-testid={`result-detail-${r.id}`}
              >
                <div className="flex gap-3 mb-1 text-[9px]">
                  <span>model: {r.model || "?"}</span>
                  <span>tokens: {r.tokensUsed || 0}</span>
                  <span>iter: {r.iteration || 0}</span>
                  <span>{time}</span>
                </div>
                {renderLinkedText((r.rawOutput || r.summary).slice(0, 5000), r.programName)}
              </div>
            )}
          </div>
        );
      })}

      {results.length === 0 && (
        <div className="p-4 text-center text-muted-foreground" data-testid="empty-results">
          No results yet. Enable the runtime and trigger a program.
        </div>
      )}
    </div>
  );
}
