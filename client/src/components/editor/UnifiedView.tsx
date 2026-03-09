import React, { useEffect, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOrgFiles, useToggleOrgStatus } from "@/hooks/use-org-data";
import { renderOrgContent } from "./OrgRenderer";

export interface ScrollTarget {
  file: string;
  heading?: string;
  lineNumber?: number;
}

interface OrgBufferViewProps {
  scrollTarget?: ScrollTarget | null;
  onScrollComplete?: () => void;
}

export default function OrgBufferView({ scrollTarget, onScrollComplete }: OrgBufferViewProps) {
  const { data: orgFiles = [], isLoading } = useOrgFiles();
  const containerRef = useRef<HTMLDivElement>(null);
  const toggleStatus = useToggleOrgStatus();

  useEffect(() => {
    if (!scrollTarget || !containerRef.current) return;
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      let el: Element | null = null;
      if (scrollTarget.lineNumber && scrollTarget.file) {
        el = container.querySelector(`[data-file="${CSS.escape(scrollTarget.file)}"][data-line="${scrollTarget.lineNumber}"]`);
      }
      if (!el && scrollTarget.heading) {
        el = container.querySelector(`[data-heading="${CSS.escape(scrollTarget.heading)}"][data-file="${CSS.escape(scrollTarget.file)}"]`);
        if (!el) {
          el = container.querySelector(`[data-heading="${CSS.escape(scrollTarget.heading)}"]`);
        }
      }
      if (!el) {
        el = container.querySelector(`[data-file-header="${CSS.escape(scrollTarget.file)}"]`);
      }
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      onScrollComplete?.();
    }, 100);
    return () => clearTimeout(timer);
  }, [scrollTarget, orgFiles]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        Loading...
      </div>
    );
  }

  if (orgFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        No org files found.
      </div>
    );
  }

  const handleToggleStatus = (fileName: string, lineNumber: number) => {
    toggleStatus.mutate({ fileName, lineNumber });
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background" data-testid="org-buffer-view">
      <ScrollArea className="flex-1">
        <div ref={containerRef} className="w-full p-2 sm:p-4 pb-32">
          {orgFiles.map((file) => {
            const lines = file.content.split("\n");
            let lineCounter = 0;
            return (
              <div key={file.name} data-file-header={file.name}>
                <div className="font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold mt-2 phosphor-glow-bright">
                  * {file.name}
                </div>
                {lines.map((line, i) => {
                  lineCounter = i + 1;
                  const headingMatch = line.match(/^(\*+)\s+(TODO\s+|DONE\s+)?(.*)$/);
                  const headingTitle = headingMatch ? headingMatch[3]?.replace(/\s*:[\w:]+:\s*$/, "").trim() : undefined;
                  const headingStatus = headingMatch ? headingMatch[2]?.trim() : undefined;
                  const dataAttrs: Record<string, string> = {};
                  if (headingTitle) {
                    dataAttrs["data-heading"] = headingTitle;
                    dataAttrs["data-file"] = file.name;
                    dataAttrs["data-line"] = String(lineCounter);
                  }
                  const rendered = renderOrgContent(line, `${file.name}-${i}-`, {
                    fileName: file.name,
                    lineNumber: lineCounter,
                    onToggleStatus: headingStatus ? handleToggleStatus : undefined,
                  });
                  if (headingTitle) {
                    return <div key={`${file.name}-${i}`} {...dataAttrs}>{rendered}</div>;
                  }
                  return <React.Fragment key={`${file.name}-${i}`}>{rendered}</React.Fragment>;
                })}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
