import React, { useState, useRef, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";

interface BacklinkRef {
  title: string;
  sourceFile: string;
  lineNumber: number;
  level: number;
  context: string;
}

interface RoamNode {
  title: string;
  sourceFile: string;
  lineNumber: number;
  level: number;
  status: string | null;
  tags: string[];
  body: string;
  backlinks: BacklinkRef[];
}

function useBacklinks() {
  return useQuery<RoamNode[]>({
    queryKey: ["/api/org-query/backlinks"],
    queryFn: async () => {
      const res = await fetch("/api/org-query/backlinks");
      if (!res.ok) throw new Error("Failed to fetch backlinks");
      return res.json();
    },
  });
}

function extractLinkTitle(link: string): string {
  const inner = link.replace(/^\[\[/, "").replace(/\]\]$/, "");
  if (inner.startsWith("*")) return inner.slice(1);
  if (inner.startsWith("file:")) {
    const headingMatch = inner.match(/::\*(.+)$/);
    if (headingMatch) return headingMatch[1];
  }
  return inner;
}

export default function RoamView() {
  const { data: nodes = [], isLoading } = useBacklinks();
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const findNodeKeyByTitle = (title: string): string | null => {
    const normalized = title.toLowerCase();
    const match = nodes.find(n => n.title.toLowerCase() === normalized);
    if (match) return `${match.sourceFile}:${match.lineNumber}`;
    return null;
  };

  const navigateToNode = (title: string) => {
    const key = findNodeKeyByTitle(title);
    if (key) {
      setExpandedNode(key);
      setTimeout(() => {
        const el = containerRef.current?.querySelector(`[data-roam-key="${CSS.escape(key)}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  };

  const navigateToBacklinkSource = (sourceFile: string, lineNumber: number) => {
    const key = `${sourceFile}:${lineNumber}`;
    const match = nodes.find(n => `${n.sourceFile}:${n.lineNumber}` === key);
    if (match) {
      setExpandedNode(key);
      setTimeout(() => {
        const el = containerRef.current?.querySelector(`[data-roam-key="${CSS.escape(key)}"]`);
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 50);
    }
  };

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        Loading graph...
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground font-mono phosphor-glow-dim gap-2">
        <div>No linked nodes found.</div>
        <div>Add [[links]] between headings to build the graph.</div>
      </div>
    );
  }

  const toggleNode = (key: string) => {
    setExpandedNode(prev => prev === key ? null : key);
  };

  const renderBodyWithLinks = (body: string) => {
    return body.split("\n").map((line, i) => (
      <div key={i} className="text-foreground phosphor-glow-dim min-h-[1.4em] whitespace-pre-wrap">
        {line.includes("[[") ? (
          <span>
            {line.split(/(\[\[.*?\]\])/).map((part, j) =>
              part.startsWith("[[") ? (
                <span
                  key={j}
                  className="underline underline-offset-2 phosphor-glow cursor-pointer hover:text-org-todo transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigateToNode(extractLinkTitle(part));
                  }}
                  data-testid={`roam-link-${i}-${j}`}
                >
                  {part}
                </span>
              ) : (
                <span key={j}>{part}</span>
              )
            )}
          </span>
        ) : (
          line || "\u00A0"
        )}
      </div>
    ));
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background" data-testid="roam-view">
      <div className="flex items-center border-b border-border bg-card px-2 py-1 gap-2">
        <span className="text-foreground">{"{*}"}</span>
        <span className="text-foreground font-bold phosphor-glow">Roam</span>
        <span className="text-muted-foreground ml-2">[{nodes.length} nodes]</span>
      </div>

      <ScrollArea className="flex-1">
        <div ref={containerRef} className="w-full p-2 sm:p-4 pb-32">
          {nodes.map((node) => {
            const nodeKey = `${node.sourceFile}:${node.lineNumber}`;
            const isExpanded = expandedNode === nodeKey;
            const hasBacklinks = node.backlinks.length > 0;
            const hasOutlinks = node.body.includes("[[");

            return (
              <div key={nodeKey} className="mb-1" data-roam-key={nodeKey} data-testid={`roam-node-${node.lineNumber}`}>
                <button
                  onClick={() => toggleNode(nodeKey)}
                  className={cn(
                    "w-full text-left flex items-start gap-2 py-1 px-2 hover:bg-muted/20 transition-colors",
                    isExpanded && "bg-muted/10"
                  )}
                >
                  <span className="text-muted-foreground w-4 flex-shrink-0">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground font-bold phosphor-glow">
                        {"*".repeat(node.level)} {node.status && (
                          <span className={node.status === "DONE" ? "text-muted-foreground" : "text-org-todo phosphor-glow-bright"}>
                            {node.status}{" "}
                          </span>
                        )}
                        {node.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5 text-muted-foreground">
                      <span>§ {node.sourceFile}:{node.lineNumber}</span>
                      {node.tags.length > 0 && (
                        <span>
                          :{node.tags.join(":")}:
                        </span>
                      )}
                      {hasBacklinks && (
                        <span>
                          [{node.backlinks.length} backlink{node.backlinks.length !== 1 ? "s" : ""}]
                        </span>
                      )}
                      {hasOutlinks && (
                        <span>
                          [links]
                        </span>
                      )}
                    </div>
                  </div>
                </button>

                {isExpanded && (
                  <div className="ml-6 border-l border-border pl-4 pb-3 mt-1">
                    {node.body && (
                      <div className="mb-3">
                        <div className="text-muted-foreground uppercase tracking-wider mb-1 font-bold">
                          Content
                        </div>
                        {renderBodyWithLinks(node.body)}
                      </div>
                    )}

                    {hasBacklinks && (
                      <div>
                        <div className="text-muted-foreground uppercase tracking-wider mb-1 font-bold phosphor-glow-dim">
                          Backlinks
                        </div>
                        {node.backlinks.map((bl, i) => (
                          <div
                            key={`${bl.sourceFile}-${bl.lineNumber}-${i}`}
                            className="py-1 px-2 mb-1 hover:bg-muted/20 transition-colors cursor-pointer"
                            onClick={() => navigateToBacklinkSource(bl.sourceFile, bl.lineNumber)}
                            data-testid={`roam-backlink-${bl.lineNumber}-${i}`}
                          >
                            <div className="text-foreground phosphor-glow">
                              {"*".repeat(bl.level)} {bl.title}
                            </div>
                            <div className="text-muted-foreground">
                              § {bl.sourceFile}:{bl.lineNumber}
                            </div>
                            {bl.context && (
                              <div className="text-muted-foreground mt-0.5 italic phosphor-glow-dim">
                                {bl.context}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {!hasBacklinks && (
                      <div className="text-muted-foreground italic phosphor-glow-dim">
                        No backlinks to this node.
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
