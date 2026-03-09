import React, { useState, useRef, useEffect, useCallback } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useAllHeadings,
  useToggleOrgStatus,
  useEditHeadingTitle,
  useDeleteHeading,
  useMoveHeading,
  useOrgFiles,
  type OutlineHeading,
} from "@/hooks/use-org-data";
import { useQuery } from "@tanstack/react-query";

type FilterMode = "all" | "todos";

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

interface OutlineItemProps {
  heading: OutlineHeading;
  children: OutlineHeading[];
  allHeadings: OutlineHeading[];
  depth: number;
  filter: FilterMode;
  expandedKey: string | null;
  onToggleExpand: (key: string) => void;
  onToggleStatus: (h: OutlineHeading) => void;
  onEditTitle: (h: OutlineHeading, newTitle: string) => void;
  onDelete: (h: OutlineHeading) => void;
  dragItem: React.MutableRefObject<OutlineHeading | null>;
  onDrop: (target: OutlineHeading, position: "before" | "after" | "child") => void;
  backlinksMap: Map<string, BacklinkRef[]>;
}

function getChildren(heading: OutlineHeading, allHeadings: OutlineHeading[]): OutlineHeading[] {
  const result: OutlineHeading[] = [];
  const startIdx = allHeadings.indexOf(heading);
  if (startIdx === -1) return result;

  for (let i = startIdx + 1; i < allHeadings.length; i++) {
    const h = allHeadings[i];
    if (h.sourceFile !== heading.sourceFile) break;
    if (h.level <= heading.level) break;
    if (h.level === heading.level + 1) {
      result.push(h);
    }
  }
  return result;
}

function hasDescendantTodos(heading: OutlineHeading, allHeadings: OutlineHeading[]): boolean {
  if (heading.status === "TODO") return true;
  const startIdx = allHeadings.indexOf(heading);
  if (startIdx === -1) return false;

  for (let i = startIdx + 1; i < allHeadings.length; i++) {
    const h = allHeadings[i];
    if (h.sourceFile !== heading.sourceFile) break;
    if (h.level <= heading.level) break;
    if (h.status === "TODO") return true;
  }
  return false;
}

function OutlineItem({
  heading,
  children: directChildren,
  allHeadings,
  depth,
  filter,
  expandedKey,
  onToggleExpand,
  onToggleStatus,
  onEditTitle,
  onDelete,
  dragItem,
  onDrop,
  backlinksMap,
}: OutlineItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(heading.title);
  const [dropZone, setDropZone] = useState<"before" | "after" | "child" | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  const nodeKey = `${heading.sourceFile}:${heading.lineNumber}`;
  const isExpanded = expandedKey === nodeKey;
  const backlinks = backlinksMap.get(nodeKey) || [];
  const hasChildren = directChildren.length > 0;
  const [childrenOpen, setChildrenOpen] = useState(true);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  const handleEditSubmit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== heading.title) {
      onEditTitle(heading, trimmed);
    }
    setEditing(false);
    setEditValue(heading.title);
  };

  const handleDragStart = (e: React.DragEvent) => {
    dragItem.current = heading;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", nodeKey);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!dragItem.current || dragItem.current === heading) {
      setDropZone(null);
      return;
    }

    const rect = itemRef.current?.getBoundingClientRect();
    if (!rect) return;

    const y = e.clientY - rect.top;
    const third = rect.height / 3;

    if (y < third) {
      setDropZone("before");
    } else if (y > third * 2) {
      setDropZone("after");
    } else {
      setDropZone("child");
    }
    e.dataTransfer.dropEffect = "move";
  };

  const handleDragLeave = () => {
    setDropZone(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (dropZone && dragItem.current && dragItem.current !== heading) {
      onDrop(heading, dropZone);
    }
    setDropZone(null);
  };

  const handleDragEnd = () => {
    dragItem.current = null;
    setDropZone(null);
  };

  const filteredChildren = filter === "todos"
    ? directChildren.filter(c => hasDescendantTodos(c, allHeadings))
    : directChildren;

  if (filter === "todos" && heading.status !== "TODO" && !hasDescendantTodos(heading, allHeadings)) {
    return null;
  }

  const isDone = heading.status === "DONE";

  return (
    <div data-testid={`outline-item-${heading.lineNumber}`}>
      <div
        ref={itemRef}
        className={cn(
          "group flex items-start gap-1 py-0.5 px-1 transition-colors relative",
          dropZone === "before" && "border-t-2 border-foreground",
          dropZone === "after" && "border-b-2 border-foreground",
          dropZone === "child" && "bg-muted/30 border border-foreground/30",
          !dropZone && "hover:bg-muted/10"
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        draggable={!editing}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      >
        {hasChildren ? (
          <button
            onClick={() => setChildrenOpen(!childrenOpen)}
            className="text-muted-foreground w-4 flex-shrink-0 mt-0.5 hover:text-foreground"
            data-testid={`toggle-children-${heading.lineNumber}`}
          >
            {childrenOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0 text-muted-foreground mt-0.5">*</span>
        )}

        {heading.status !== null && (
          <button
            onClick={() => onToggleStatus(heading)}
            className="flex-shrink-0 mt-0.5"
            data-testid={`toggle-status-${heading.lineNumber}`}
          >
            {isDone ? (
              <span className="text-muted-foreground">[x]</span>
            ) : (
              <span className="text-foreground">[&nbsp;]</span>
            )}
          </button>
        )}

        <div className="flex-1 min-w-0">
          {editing ? (
            <input
              ref={editRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleEditSubmit();
                if (e.key === "Escape") { setEditing(false); setEditValue(heading.title); }
              }}
              onBlur={handleEditSubmit}
              className="w-full bg-transparent text-foreground outline-none border-b border-foreground/30 phosphor-glow text-sm"
              data-testid={`edit-title-${heading.lineNumber}`}
            />
          ) : (
            <span
              onClick={() => { setEditing(true); setEditValue(heading.title); }}
              className={cn(
                "cursor-text text-sm leading-snug",
                isDone ? "text-muted-foreground line-through phosphor-glow-dim" : "text-foreground phosphor-glow"
              )}
              data-testid={`title-${heading.lineNumber}`}
            >
              {heading.title}
            </span>
          )}

          {heading.tags.length > 0 && (
            <span className="text-muted-foreground ml-2 text-xs">
              :{heading.tags.join(":")}:
            </span>
          )}
        </div>

        {backlinks.length > 0 && (
          <button
            onClick={() => onToggleExpand(nodeKey)}
            className="text-muted-foreground text-xs flex-shrink-0 hover:text-foreground transition-colors"
            data-testid={`expand-backlinks-${heading.lineNumber}`}
          >
            [{backlinks.length}]
          </button>
        )}

        <span className="hidden group-hover:inline-flex items-center gap-0.5 flex-shrink-0 text-xs">
          {heading.scheduledDate && (
            <span className="text-muted-foreground mr-1">{heading.scheduledDate}</span>
          )}
          <button
            onClick={() => onDelete(heading)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Delete"
            data-testid={`delete-${heading.lineNumber}`}
          >
            [d]
          </button>
        </span>
      </div>

      {isExpanded && backlinks.length > 0 && (
        <div className="ml-8 border-l border-border pl-3 py-1 mb-1" style={{ marginLeft: `${depth * 16 + 24}px` }}>
          <div className="text-muted-foreground uppercase tracking-wider text-xs font-bold mb-1 phosphor-glow-dim">
            Backlinks
          </div>
          {backlinks.map((bl, i) => (
            <div
              key={`${bl.sourceFile}-${bl.lineNumber}-${i}`}
              className="py-0.5 text-xs text-muted-foreground"
              data-testid={`backlink-${bl.lineNumber}-${i}`}
            >
              <span className="text-foreground phosphor-glow-dim">{"*".repeat(bl.level)} {bl.title}</span>
              <span className="ml-1">§ {bl.sourceFile}</span>
            </div>
          ))}
        </div>
      )}

      {childrenOpen && filteredChildren.length > 0 && (
        <div>
          {filteredChildren.map((child) => (
            <OutlineItem
              key={`${child.sourceFile}:${child.lineNumber}`}
              heading={child}
              children={getChildren(child, allHeadings)}
              allHeadings={allHeadings}
              depth={depth + 1}
              filter={filter}
              expandedKey={expandedKey}
              onToggleExpand={onToggleExpand}
              onToggleStatus={onToggleStatus}
              onEditTitle={onEditTitle}
              onDelete={onDelete}
              dragItem={dragItem}
              onDrop={onDrop}
              backlinksMap={backlinksMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function RoamView() {
  const { data: headings = [], isLoading } = useAllHeadings();
  const { data: orgFiles = [] } = useOrgFiles();
  const { data: backlinksData = [] } = useBacklinks();
  const toggleMutation = useToggleOrgStatus();
  const editTitleMutation = useEditHeadingTitle();
  const deleteMutation = useDeleteHeading();
  const moveMutation = useMoveHeading();
  const [filter, setFilter] = useState<FilterMode>("all");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const dragItem = useRef<OutlineHeading | null>(null);

  const backlinksMap = React.useMemo(() => {
    const map = new Map<string, BacklinkRef[]>();
    for (const node of backlinksData) {
      const key = `${node.sourceFile}:${node.lineNumber}`;
      if (node.backlinks.length > 0) {
        map.set(key, node.backlinks);
      }
    }
    return map;
  }, [backlinksData]);

  const handleToggleStatus = useCallback((h: OutlineHeading) => {
    toggleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber });
  }, [toggleMutation]);

  const handleEditTitle = useCallback((h: OutlineHeading, newTitle: string) => {
    editTitleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, newTitle });
  }, [editTitleMutation]);

  const handleDelete = useCallback((h: OutlineHeading) => {
    deleteMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber });
  }, [deleteMutation]);

  const getSubtreeEnd = useCallback((h: OutlineHeading): number => {
    const fileHeadings = headings.filter(x => x.sourceFile === h.sourceFile);
    const idx = fileHeadings.findIndex(x => x.lineNumber === h.lineNumber);
    if (idx === -1) return h.lineNumber;

    for (let i = idx + 1; i < fileHeadings.length; i++) {
      if (fileHeadings[i].level <= h.level) {
        return fileHeadings[i].lineNumber;
      }
    }
    return 999999;
  }, [headings]);

  const isDescendant = useCallback((source: OutlineHeading, target: OutlineHeading): boolean => {
    if (source.sourceFile !== target.sourceFile) return false;
    const subtreeEnd = getSubtreeEnd(source);
    return target.lineNumber > source.lineNumber && target.lineNumber < subtreeEnd;
  }, [getSubtreeEnd]);

  const handleDrop = useCallback((target: OutlineHeading, position: "before" | "after" | "child") => {
    const source = dragItem.current;
    if (!source || source === target) return;
    if (source.sourceFile !== target.sourceFile) return;
    if (isDescendant(source, target)) return;

    let toLine: number;
    let newLevel: number | undefined;

    if (position === "before") {
      toLine = target.lineNumber;
    } else if (position === "after") {
      toLine = getSubtreeEnd(target);
    } else {
      toLine = getSubtreeEnd(target);
      newLevel = target.level + 1;
    }

    moveMutation.mutate({
      fileName: source.sourceFile,
      fromLine: source.lineNumber,
      toLine,
      newLevel,
    });
    dragItem.current = null;
  }, [moveMutation, getSubtreeEnd, isDescendant]);

  const toggleExpand = useCallback((key: string) => {
    setExpandedKey(prev => prev === key ? null : key);
  }, []);

  const fileGroups = React.useMemo(() => {
    const groups: { fileName: string; topLevel: OutlineHeading[] }[] = [];
    const seen = new Set<string>();

    for (const h of headings) {
      if (!seen.has(h.sourceFile)) {
        seen.add(h.sourceFile);
        groups.push({ fileName: h.sourceFile, topLevel: [] });
      }
    }

    for (const h of headings) {
      if (h.level === 1) {
        const group = groups.find(g => g.fileName === h.sourceFile);
        if (group) group.topLevel.push(h);
      }
    }

    for (const file of orgFiles) {
      if (!seen.has(file.name)) {
        groups.push({ fileName: file.name, topLevel: [] });
      }
    }

    return groups;
  }, [headings, orgFiles]);

  const todoCount = React.useMemo(() => {
    return headings.filter(h => h.status === "TODO").length;
  }, [headings]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        Loading outline...
      </div>
    );
  }

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background" data-testid="roam-view">
      <div className="flex items-center border-b border-border bg-card px-2 py-1 gap-1 overflow-x-auto">
        <span className="text-foreground">{"{*}"}</span>
        <span className="text-foreground font-bold phosphor-glow mr-2">Roam</span>
        <button
          onClick={() => setFilter("all")}
          className={cn(
            "px-1.5 py-0.5 text-xs transition-colors",
            filter === "all" ? "text-foreground phosphor-glow font-bold" : "text-muted-foreground hover:text-foreground"
          )}
          data-testid="filter-all"
        >
          All [{headings.length}]
        </button>
        <button
          onClick={() => setFilter("todos")}
          className={cn(
            "px-1.5 py-0.5 text-xs transition-colors",
            filter === "todos" ? "text-foreground phosphor-glow font-bold" : "text-muted-foreground hover:text-foreground"
          )}
          data-testid="filter-todos"
        >
          TODOs [{todoCount}]
        </button>
      </div>

      <ScrollArea className="flex-1">
        <div className="w-full p-1 sm:p-2 pb-32">
          {fileGroups.map((group) => {
            const fileHeadings = headings.filter(h => h.sourceFile === group.fileName);
            const topLevel = filter === "todos"
              ? group.topLevel.filter(h => hasDescendantTodos(h, fileHeadings))
              : group.topLevel;

            if (filter === "todos" && topLevel.length === 0) return null;

            return (
              <div key={group.fileName} className="mb-3" data-testid={`file-group-${group.fileName}`}>
                <div className="text-muted-foreground text-xs uppercase tracking-wider px-1 py-1 border-b border-border/50 mb-1 phosphor-glow-dim">
                  § {group.fileName}
                </div>
                {topLevel.length === 0 ? (
                  <div className="text-muted-foreground text-xs px-1 py-2 phosphor-glow-dim italic">
                    (empty)
                  </div>
                ) : (
                  topLevel.map((h) => (
                    <OutlineItem
                      key={`${h.sourceFile}:${h.lineNumber}`}
                      heading={h}
                      children={getChildren(h, fileHeadings)}
                      allHeadings={fileHeadings}
                      depth={0}
                      filter={filter}
                      expandedKey={expandedKey}
                      onToggleExpand={toggleExpand}
                      onToggleStatus={handleToggleStatus}
                      onEditTitle={handleEditTitle}
                      onDelete={handleDelete}
                      dragItem={dragItem}
                      onDrop={handleDrop}
                      backlinksMap={backlinksMap}
                    />
                  ))
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
