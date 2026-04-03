import React, { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

interface GalaxyKbViewProps {
  selectedEntryId?: number;
}

export default function GalaxyKbView({ selectedEntryId }: GalaxyKbViewProps) {
  const queryClient = useQueryClient();
  const [viewingId, setViewingId] = useState<number | null>(selectedEntryId || null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedEntryId) setViewingId(selectedEntryId);
  }, [selectedEntryId]);

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["/api/galaxy-kb"],
    queryFn: async () => {
      const res = await fetch("/api/galaxy-kb", { credentials: "include" });
      return res.json();
    },
  });

  const { data: detail } = useQuery({
    queryKey: ["/api/galaxy-kb", viewingId],
    queryFn: async () => {
      const res = await fetch(`/api/galaxy-kb/${viewingId}`, { credentials: "include" });
      return res.json();
    },
    enabled: !!viewingId,
  });

  const verifyMut = useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(`/api/galaxy-kb/${id}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ verifiedBy: "user" }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/galaxy-kb"] });
      if (viewingId) queryClient.invalidateQueries({ queryKey: ["/api/galaxy-kb", viewingId] });
    },
  });

  const flagMut = useMutation({
    mutationFn: async ({ id, reason }: { id: number; reason: string }) => {
      const res = await fetch(`/api/galaxy-kb/${id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ reason }),
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/galaxy-kb"] });
      if (viewingId) queryClient.invalidateQueries({ queryKey: ["/api/galaxy-kb", viewingId] });
    },
  });

  const noteMut = useMutation({
    mutationFn: async ({ id, note }: { id: number; note: string }) => {
      const res = await fetch(`/api/galaxy-kb/${id}/note`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ note }),
      });
      return res.json();
    },
    onSuccess: () => {
      if (viewingId) queryClient.invalidateQueries({ queryKey: ["/api/galaxy-kb", viewingId] });
    },
  });

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (viewingId) {
      if (e.key === "Escape") { e.preventDefault(); setViewingId(null); }
      if (e.key === "v") { e.preventDefault(); verifyMut.mutate(viewingId); }
      if (e.key === "f") {
        e.preventDefault();
        const reason = prompt("Flag reason:");
        if (reason) flagMut.mutate({ id: viewingId, reason });
      }
      if (e.key === "n") {
        e.preventDefault();
        const note = prompt("Add note:");
        if (note) noteMut.mutate({ id: viewingId, note });
      }
      return;
    }

    switch (e.key) {
      case "j": e.preventDefault(); setSelectedIdx(i => Math.min(i + 1, entries.length - 1)); break;
      case "k": e.preventDefault(); setSelectedIdx(i => Math.max(i - 1, 0)); break;
      case "Enter":
        e.preventDefault();
        if (entries[selectedIdx]) setViewingId(entries[selectedIdx].id);
        break;
    }
  }, [viewingId, entries, selectedIdx, verifyMut, flagMut, noteMut]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (isLoading) {
    return <div className="p-4 font-mono text-[var(--crt-text)]">Loading Galaxy KB...</div>;
  }

  if (viewingId && detail) {
    const linkedMemories = detail.linkedMemories || [];
    return (
      <div ref={containerRef} className="p-4 font-mono text-[var(--crt-text)] overflow-y-auto h-full" data-testid="galaxy-kb-detail">
        <div className="mb-4">
          <span className="text-[var(--crt-dim)] cursor-pointer" onClick={() => setViewingId(null)} data-testid="link-back-to-list">[ESC] Back to list</span>
        </div>

        <div className="border border-[var(--crt-border)] p-4 mb-4">
          <div className="text-lg mb-2" data-testid="text-kb-title">{detail.title}</div>
          <div className="text-[var(--crt-dim)] text-sm mb-1">Category: {detail.category}</div>
          <div className="text-[var(--crt-dim)] text-sm mb-1">
            Status: {detail.verified ? "VERIFIED" : detail.flagged ? "FLAGGED" : "unverified"}
            {detail.verified && detail.verifiedBy && ` by ${detail.verifiedBy}`}
          </div>
          <div className="text-[var(--crt-dim)] text-sm mb-1">Memories: {detail.memoryCount}</div>
          <div className="text-[var(--crt-dim)] text-sm mb-2">
            URL: <a href={detail.url} target="_blank" rel="noopener noreferrer" className="underline" data-testid="link-galaxy-url">{detail.url}</a>
          </div>

          <div className="flex gap-2 mb-4">
            <button
              onClick={() => verifyMut.mutate(viewingId)}
              className="px-2 py-1 border border-[var(--crt-border)] text-[var(--crt-text)] hover:bg-[var(--crt-selection)] text-sm"
              data-testid="button-verify"
            >[v] Verify</button>
            <button
              onClick={() => {
                const reason = prompt("Flag reason:");
                if (reason) flagMut.mutate({ id: viewingId, reason });
              }}
              className="px-2 py-1 border border-[var(--crt-border)] text-[var(--crt-text)] hover:bg-[var(--crt-selection)] text-sm"
              data-testid="button-flag"
            >[f] Flag</button>
            <button
              onClick={() => {
                const note = prompt("Add note:");
                if (note) noteMut.mutate({ id: viewingId, note });
              }}
              className="px-2 py-1 border border-[var(--crt-border)] text-[var(--crt-text)] hover:bg-[var(--crt-selection)] text-sm"
              data-testid="button-note"
            >[n] Note</button>
          </div>
        </div>

        {detail.summary && (
          <div className="border border-[var(--crt-border)] p-4 mb-4">
            <div className="text-[var(--crt-accent)] mb-1">Summary</div>
            <div className="text-sm" data-testid="text-kb-summary">{detail.summary}</div>
          </div>
        )}

        {detail.flagReason && (
          <div className="border border-[var(--crt-warn,orange)] p-4 mb-4">
            <div className="text-[var(--crt-warn,orange)] mb-1">Flag Reason</div>
            <div className="text-sm" data-testid="text-flag-reason">{detail.flagReason}</div>
          </div>
        )}

        {detail.userNotes && (
          <div className="border border-[var(--crt-border)] p-4 mb-4">
            <div className="text-[var(--crt-accent)] mb-1">User Notes</div>
            <div className="text-sm whitespace-pre-wrap" data-testid="text-user-notes">{detail.userNotes}</div>
          </div>
        )}

        {linkedMemories.length > 0 && (
          <div className="border border-[var(--crt-border)] p-4 mb-4">
            <div className="text-[var(--crt-accent)] mb-1">Linked Memories ({linkedMemories.length})</div>
            {linkedMemories.slice(0, 10).map((m: any) => (
              <div key={m.id} className="text-xs text-[var(--crt-dim)] mb-1 border-b border-[var(--crt-border)] pb-1" data-testid={`text-memory-${m.id}`}>
                <span className="text-[var(--crt-text)]">#{m.id}</span> [{m.memoryType}] rel:{m.relevanceScore} -- {m.content.substring(0, 120)}
              </div>
            ))}
            {linkedMemories.length > 10 && <div className="text-xs text-[var(--crt-dim)]">... +{linkedMemories.length - 10} more</div>}
          </div>
        )}

        {detail.fullText && (
          <div className="border border-[var(--crt-border)] p-4">
            <div className="text-[var(--crt-accent)] mb-1">Full Text</div>
            <div className="text-xs whitespace-pre-wrap max-h-[60vh] overflow-y-auto" data-testid="text-full-content">{detail.fullText.substring(0, 10000)}</div>
          </div>
        )}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="p-4 font-mono text-[var(--crt-text)]" data-testid="text-kb-empty">
        Galaxy KB is empty. Use: galaxy search + galaxy read to populate.
      </div>
    );
  }

  const catMap = new Map<string, any[]>();
  for (const e of entries) {
    const cat = e.category || "General";
    if (!catMap.has(cat)) catMap.set(cat, []);
    catMap.get(cat)!.push(e);
  }

  let flatIdx = 0;
  return (
    <div ref={containerRef} className="p-4 font-mono text-[var(--crt-text)] overflow-y-auto h-full" data-testid="galaxy-kb-list">
      <div className="mb-3 text-[var(--crt-accent)]">GALAXY KNOWLEDGE BASE ({entries.length} entries)</div>
      {Array.from(catMap.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([cat, items]) => (
        <div key={cat} className="mb-3">
          <div className="text-[var(--crt-accent)] text-sm mb-1">{cat} ({items.length})</div>
          {items.map((e: any) => {
            const idx = flatIdx++;
            const isSelected = idx === selectedIdx;
            const statusIcon = e.verified ? "+" : e.flagged ? "!" : " ";
            return (
              <div
                key={e.id}
                className={`pl-4 py-0.5 cursor-pointer text-sm ${isSelected ? "bg-[var(--crt-selection)] text-[var(--crt-text)]" : "text-[var(--crt-dim)]"}`}
                onClick={() => setViewingId(e.id)}
                data-testid={`card-kb-entry-${e.id}`}
              >
                [{statusIcon}] #{e.id} {e.title.substring(0, 55)} ({e.memoryCount}m)
              </div>
            );
          })}
        </div>
      ))}
      <div className="mt-4 text-xs text-[var(--crt-dim)]">j/k to navigate, Enter to view, v=verify, f=flag, n=note</div>
    </div>
  );
}
