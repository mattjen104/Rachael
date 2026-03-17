import React, { useState, useCallback, useEffect, useRef } from "react";
import { useReaderPages, useCreateReaderPage, useDeleteReaderPage, useSmartCapture } from "@/hooks/use-org-data";

interface ReaderViewProps {
  selectedPageId?: number;
}

export default function ReaderView({ selectedPageId }: ReaderViewProps) {
  const { data: pages = [], isLoading } = useReaderPages();
  const createPage = useCreateReaderPage();
  const deletePage = useDeleteReaderPage();
  const smartCapture = useSmartCapture();
  const [captureMsg, setCaptureMsg] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [readingId, setReadingId] = useState<number | null>(selectedPageId || null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedPageId) setReadingId(selectedPageId);
  }, [selectedPageId]);

  const readingPage = readingId ? pages.find(p => p.id === readingId) : null;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    if (readingPage) {
      if (e.key === "Escape") {
        e.preventDefault();
        setReadingId(null);
      }
      if (e.key === "s") {
        e.preventDefault();
        const selection = window.getSelection()?.toString()?.trim();
        const snippet = selection || readingPage.extractedText.slice(0, 200);
        const captureText = `[${readingPage.title}] ${snippet}`;
        smartCapture.mutate(captureText);
        setCaptureMsg(`Captured: ${captureText.slice(0, 50)}...`);
        setTimeout(() => setCaptureMsg(null), 2000);
      }
      return;
    }

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, pages.length - 1));
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
        setSelectedIdx(pages.length - 1);
        break;
      case "Enter":
        e.preventDefault();
        const p = pages[selectedIdx];
        if (p) setReadingId(p.id);
        break;
      case "d":
        e.preventDefault();
        const pd = pages[selectedIdx];
        if (pd) deletePage.mutate(pd.id);
        break;
    }
  }, [pages, selectedIdx, readingPage, deletePage, smartCapture]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  if (isLoading) return <div className="p-2 text-muted-foreground" data-testid="loading-reader">Loading...</div>;

  if (readingPage) {
    return (
      <div className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="reader-content">
        <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between">
          <span className="truncate">{readingPage.title}</span>
          <button
            data-testid="reader-back"
            className="underline shrink-0"
            onClick={() => setReadingId(null)}
          >
            [back]
          </button>
        </div>
        <div className="px-2 py-1 text-muted-foreground text-[10px] border-b border-border">
          {readingPage.domain} — {readingPage.url}
        </div>
        {captureMsg && (
          <div className="px-2 py-1 text-[10px] bg-primary/20 text-primary" data-testid="reader-capture-msg">{captureMsg}</div>
        )}
        <div className="px-2 py-1 text-muted-foreground text-[10px] border-b border-border">
          Press <kbd>s</kbd> to capture snippet (select text first, or captures first 200 chars)
        </div>
        <div className="px-2 py-2 whitespace-pre-wrap leading-relaxed">
          {readingPage.extractedText}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="reader-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10">
        READER ({pages.length})
      </div>

      {pages.map((page, idx) => {
        const sel = idx === selectedIdx;
        return (
          <div
            key={page.id}
            data-idx={idx}
            data-testid={`reader-item-${page.id}`}
            data-selected={sel}
            className={`px-2 py-0.5 cursor-pointer select-none flex items-center gap-1 ${sel ? "bg-primary/20" : ""}`}
            onClick={() => { setSelectedIdx(idx); setReadingId(page.id); }}
          >
            <span className="w-4 shrink-0 text-center">📖</span>
            <span className="truncate flex-1">{page.title}</span>
            <span className="text-muted-foreground shrink-0 text-[10px]">{page.domain}</span>
          </div>
        );
      })}

      {pages.length === 0 && (
        <div className="p-4 text-center text-muted-foreground" data-testid="empty-reader">
          No saved pages. Paste a URL or use the command palette to add one.
        </div>
      )}
    </div>
  );
}
