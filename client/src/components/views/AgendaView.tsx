import React, { useState, useCallback, useEffect, useRef } from "react";
import { useAgenda, useToggleTask } from "@/hooks/use-org-data";
import { getStoredApiKey, apiUrl } from "@/lib/queryClient";
import type { Task, Note, AgentResult } from "@shared/schema";

interface AgendaViewProps {
  onNavigate?: (view: string, id?: number) => void;
  onEditItem?: (item: { type: "task"; data: Task } | { type: "note"; data: Note }) => void;
}

export default function AgendaView({ onNavigate, onEditItem }: AgendaViewProps) {
  const { data: agenda, isLoading } = useAgenda();
  const toggleTask = useToggleTask();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set(["overdue", "today", "briefings"]));
  const containerRef = useRef<HTMLDivElement>(null);

  const allItems: Array<{ type: "section"; label: string; key: string } | { type: "task"; item: Task } | { type: "result"; item: AgentResult }> = [];

  if (agenda) {
    if (agenda.overdue.length > 0) {
      allItems.push({ type: "section", label: `OVERDUE (${agenda.overdue.length})`, key: "overdue" });
      if (expandedSections.has("overdue")) {
        for (const t of agenda.overdue) allItems.push({ type: "task", item: t });
      }
    }
    allItems.push({ type: "section", label: `TODAY (${agenda.today.length})`, key: "today" });
    if (expandedSections.has("today")) {
      for (const t of agenda.today) allItems.push({ type: "task", item: t });
    }
    if (agenda.upcoming.length > 0) {
      allItems.push({ type: "section", label: `UPCOMING (${agenda.upcoming.length})`, key: "upcoming" });
      if (expandedSections.has("upcoming")) {
        for (const t of agenda.upcoming) allItems.push({ type: "task", item: t });
      }
    }
    if (agenda.briefings.length > 0) {
      allItems.push({ type: "section", label: `BRIEFINGS (${agenda.briefings.length})`, key: "briefings" });
      if (expandedSections.has("briefings")) {
        for (const r of agenda.briefings) allItems.push({ type: "result", item: r });
      }
    }
  }

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, allItems.length - 1));
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
        setSelectedIdx(allItems.length - 1);
        break;
      case "Tab":
        e.preventDefault();
        const current = allItems[selectedIdx];
        if (current?.type === "section") {
          setExpandedSections(prev => {
            const next = new Set(prev);
            if (next.has(current.key)) next.delete(current.key);
            else next.add(current.key);
            return next;
          });
        }
        break;
      case "e": {
        e.preventDefault();
        const editItem = allItems[selectedIdx];
        if (editItem?.type === "task" && onEditItem) {
          onEditItem({ type: "task", data: editItem.item });
        }
        break;
      }
      case "Enter":
        e.preventDefault();
        const item = allItems[selectedIdx];
        if (item?.type === "task") {
          toggleTask.mutate(item.item.id);
        } else if (item?.type === "result") {
          onNavigate?.("results", item.item.id);
        }
        break;
    }
  }, [allItems, selectedIdx, toggleTask, onNavigate, expandedSections, onEditItem]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    const el = containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (isLoading) return <div className="p-2 text-muted-foreground" data-testid="loading-agenda">Loading agenda...</div>;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="agenda-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10">
        AGENDA — {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
      </div>
      {allItems.map((item, idx) => {
        const isSelected = idx === selectedIdx;
        if (item.type === "section") {
          const expanded = expandedSections.has(item.key);
          return (
            <div
              key={`section-${item.key}`}
              data-idx={idx}
              data-selected={isSelected}
              data-testid={`section-${item.key}`}
              className={`px-2 py-1 cursor-pointer select-none font-bold ${
                isSelected ? "bg-primary/20 text-primary" : "text-muted-foreground"
              }`}
              onClick={() => {
                setSelectedIdx(idx);
                setExpandedSections(prev => {
                  const next = new Set(prev);
                  if (next.has(item.key)) next.delete(item.key);
                  else next.add(item.key);
                  return next;
                });
              }}
            >
              <span className="mr-1">{expanded ? "▼" : "▶"}</span>
              {item.label}
            </div>
          );
        }
        if (item.type === "task") {
          const t = item.item;
          const isDone = t.status === "DONE";
          return (
            <div
              key={`task-${t.id}`}
              data-idx={idx}
              data-selected={isSelected}
              data-testid={`task-item-${t.id}`}
              className={`px-2 py-0.5 cursor-pointer select-none flex items-center gap-1 ${
                isSelected ? "bg-primary/20" : ""
              } ${isDone ? "text-muted-foreground line-through" : ""}`}
              onClick={() => {
                setSelectedIdx(idx);
                toggleTask.mutate(t.id);
              }}
            >
              <span className="w-12 shrink-0 text-muted-foreground">{isDone ? "DONE" : "TODO"}</span>
              <span className="truncate flex-1">{t.title}</span>
              {t.scheduledDate && <span className="text-muted-foreground shrink-0">{t.scheduledDate}</span>}
              {t.priority && <span className="text-primary shrink-0">[{t.priority}]</span>}
            </div>
          );
        }
        if (item.type === "result") {
          const r = item.item;
          return (
            <div
              key={`result-${r.id}`}
              data-idx={idx}
              data-selected={isSelected}
              data-testid={`result-item-${r.id}`}
              className={`px-2 py-0.5 cursor-pointer select-none flex items-center gap-1 ${
                isSelected ? "bg-primary/20" : ""
              }`}
              onClick={() => {
                setSelectedIdx(idx);
                if (r.programName === "research-radar") {
                  const ehdrs: Record<string, string> = { "Content-Type": "application/json" };
                  const ekey = getStoredApiKey();
                  if (ekey) ehdrs["Authorization"] = `Bearer ${ekey}`;
                  fetch(apiUrl("/api/radar/engagement"), {
                    method: "POST",
                    headers: ehdrs,
                    body: JSON.stringify({ url: "briefing://" + r.id, source: "briefing", title: r.summary?.slice(0, 200), programName: "research-radar" }),
                  }).catch(() => {});
                }
                onNavigate?.("results", r.id);
              }}
            >
              <span className="w-28 shrink-0 truncate text-muted-foreground">{r.programName.slice(0, 12)}</span>
              <span className="truncate flex-1">{r.summary}</span>
              {r.metric && <span className="text-muted-foreground shrink-0">={r.metric}</span>}
            </div>
          );
        }
        return null;
      })}
      {allItems.length === 0 && (
        <div className="p-4 text-center text-muted-foreground" data-testid="empty-agenda">
          No items. Press <kbd className="text-primary">c</kbd> to capture.
        </div>
      )}
    </div>
  );
}
