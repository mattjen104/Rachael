import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  useAllHeadings,
  useToggleOrgStatus,
  useEditHeadingTitle,
  useDeleteHeading,
  useMoveHeading,
  useReorderBodyLine,
  useOrgFiles,
  useOrgAgenda,
  useOrgTodos,
  useOrgDone,
  useOrgCapture,
  useRescheduleHeading,
  useJournalDaily,
  useJournalAdd,
  useDailyCapture,
  useHeadingsSearch,
  useEditTags,
  useInsertHeading,
  useEditProperty,
  useDeleteProperty,
  useOpenClawStatus,
  useOpenClawProposals,
  useAcceptProposal,
  useRejectProposal,
  useRuntimeState,
  type OutlineHeading,
  type OrgHeading,
  type AgendaDay,
} from "@/hooks/use-org-data";
import { useQuery } from "@tanstack/react-query";

type AgendaTabMode = "today" | "week" | "todos" | "done";

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

function filterBodyLines(body: string): string[] {
  const lines = body.split("\n");
  const filtered: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (t === ":PROPERTIES:" || t === ":END:") continue;
    if (/^:[A-Z_]+:/.test(t)) continue;
    if (/^(SCHEDULED|DEADLINE|CLOSED):/.test(t)) continue;
    filtered.push(l);
  }

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of filtered) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paragraphs.push(current.map(l => l.trim()).join(" "));
        current = [];
      }
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push(current.map(l => l.trim()).join(" "));
  }
  return paragraphs;
}

interface BodyBulletProps {
  line: string;
  index: number;
  headingLine: number;
  depth: number;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (e: React.DragEvent, index: number) => void;
  dropTarget: number | null;
}

function BodyBullet({ line, index, headingLine, depth, onDragStart, onDragOver, onDrop, dropTarget }: BodyBulletProps) {
  return (
    <div
      className={cn(
        "flex items-start gap-1 py-px text-sm text-muted-foreground cursor-grab",
        dropTarget === index && "border-t border-foreground/40"
      )}
      style={{ paddingLeft: `${(depth + 1) * 16 + 4}px` }}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/x-body-index", String(index));
        e.dataTransfer.setData("text/x-heading-line", String(headingLine));
        e.dataTransfer.setData("text/x-body-drag", "true");
        onDragStart(index);
      }}
      onDragOver={(e) => onDragOver(e, index)}
      onDrop={(e) => onDrop(e, index)}
      data-testid={`body-line-${headingLine}-${index}`}
    >
      <span className="flex-shrink-0 mt-0.5">·</span>
      <span className="whitespace-pre-wrap">{line.trim()}</span>
    </div>
  );
}

interface ProposalInfo {
  id: number;
  section: string;
  targetName: string | null;
  reason: string;
  currentContent: string;
  proposedContent: string;
}

interface OutlineItemProps {
  heading: OutlineHeading;
  children: OutlineHeading[];
  allHeadings: OutlineHeading[];
  depth: number;
  expandedKey: string | null;
  onToggleExpand: (key: string) => void;
  onToggleStatus: (h: OutlineHeading) => void;
  onEditTitle: (h: OutlineHeading, newTitle: string) => void;
  onDelete: (h: OutlineHeading) => void;
  onEditTags: (h: OutlineHeading, tags: string[]) => void;
  onInsertHeading: (h: OutlineHeading) => void;
  onEditProperty: (h: OutlineHeading, key: string, value: string) => void;
  onDeleteProperty: (h: OutlineHeading, key: string) => void;
  onAcceptProposal?: (id: number) => void;
  onRejectProposal?: (id: number) => void;
  dragItem: React.MutableRefObject<OutlineHeading | null>;
  onDrop: (target: OutlineHeading, position: "before" | "after" | "child") => void;
  onReorderBody: (heading: OutlineHeading, fromIndex: number, toIndex: number) => void;
  backlinksMap: Map<string, BacklinkRef[]>;
  proposals?: ProposalInfo[];
  isCursored?: boolean;
  pendingInsertLine?: number | null;
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

function OutlineItem({
  heading,
  children: directChildren,
  allHeadings,
  depth,
  expandedKey,
  onToggleExpand,
  onToggleStatus,
  onEditTitle,
  onDelete,
  onEditTags,
  onInsertHeading,
  onEditProperty,
  onDeleteProperty,
  onAcceptProposal,
  onRejectProposal,
  dragItem,
  onDrop,
  onReorderBody,
  backlinksMap,
  proposals,
  isCursored,
  pendingInsertLine,
}: OutlineItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(heading.title);
  const [dropZone, setDropZone] = useState<"before" | "after" | "child" | null>(null);
  const [bodyDropTarget, setBodyDropTarget] = useState<number | null>(null);
  const [bodyDragSource, setBodyDragSource] = useState<number | null>(null);
  const [addingTag, setAddingTag] = useState(false);
  const [newTagValue, setNewTagValue] = useState("");
  const [addingProp, setAddingProp] = useState(false);
  const [newPropKey, setNewPropKey] = useState("");
  const [newPropValue, setNewPropValue] = useState("");
  const [editingPropKey, setEditingPropKey] = useState<string | null>(null);
  const [editingPropValue, setEditingPropValue] = useState("");
  const [showProposal, setShowProposal] = useState(false);
  const editRef = useRef<HTMLInputElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const propKeyRef = useRef<HTMLInputElement>(null);
  const propValueRef = useRef<HTMLInputElement>(null);
  const itemRef = useRef<HTMLDivElement>(null);

  const nodeKey = `${heading.sourceFile}:${heading.lineNumber}`;
  const isExpanded = expandedKey === nodeKey;
  const backlinks = backlinksMap.get(nodeKey) || [];
  const hasBody = !!(heading.body && heading.body.trim());
  const bodyLines = hasBody ? filterBodyLines(heading.body!) : [];
  const hasVisibleBody = bodyLines.length > 0;
  const hasChildren = directChildren.length > 0;
  const hasContent = hasChildren || hasVisibleBody;
  const [childrenOpen, setChildrenOpen] = useState(true);
  const propEntries = heading.properties ? Object.entries(heading.properties) : [];
  const hasProps = propEntries.length > 0;
  const matchedProposals = proposals || [];

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (pendingInsertLine === heading.lineNumber && !editing) {
      setEditing(true);
      setEditValue(heading.title);
    }
  }, [pendingInsertLine, heading.lineNumber, heading.title]);

  useEffect(() => {
    if (addingTag && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [addingTag]);

  useEffect(() => {
    if (addingProp && propKeyRef.current) {
      propKeyRef.current.focus();
    }
  }, [addingProp]);

  useEffect(() => {
    if (editingPropKey && propValueRef.current) {
      propValueRef.current.focus();
      propValueRef.current.select();
    }
  }, [editingPropKey]);

  const handleAddProp = () => {
    const k = newPropKey.replace(/[\s:]/g, "").toUpperCase().trim();
    const v = newPropValue.trim();
    if (k && v) {
      onEditProperty(heading, k, v);
    }
    setNewPropKey("");
    setNewPropValue("");
    setAddingProp(false);
  };

  const handleEditProp = (key: string) => {
    const v = editingPropValue.trim();
    if (v && v !== heading.properties?.[key]) {
      onEditProperty(heading, key, v);
    }
    setEditingPropKey(null);
    setEditingPropValue("");
  };

  const handleRemoveTag = (tagToRemove: string) => {
    const newTags = heading.tags.filter(t => t !== tagToRemove);
    onEditTags(heading, newTags);
  };

  const handleAddTag = () => {
    const tag = newTagValue.replace(/[\s:]/g, "").trim();
    if (tag && !heading.tags.includes(tag)) {
      onEditTags(heading, [...heading.tags, tag]);
    }
    setNewTagValue("");
    setAddingTag(false);
  };

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
    if (e.dataTransfer.types.includes("text/x-body-drag")) {
      setDropZone(null);
      return;
    }
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

  const handleBodyDragStart = (index: number) => {
    setBodyDragSource(index);
  };

  const handleBodyDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.types.includes("text/x-body-index")) {
      setBodyDropTarget(index);
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleBodyDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    e.stopPropagation();
    const fromIndex = parseInt(e.dataTransfer.getData("text/x-body-index"), 10);
    const srcHeadingLine = parseInt(e.dataTransfer.getData("text/x-heading-line"), 10);
    if (!isNaN(fromIndex) && fromIndex !== toIndex && srcHeadingLine === heading.lineNumber) {
      onReorderBody(heading, fromIndex, toIndex);
    }
    setBodyDropTarget(null);
    setBodyDragSource(null);
  };

  const isDone = heading.status === "DONE";
  const guideLeft = depth * 16 + 4 + 7;

  return (
    <div data-testid={`outline-item-${heading.lineNumber}`}>
      <div
        ref={itemRef}
        className={cn(
          "group flex items-start gap-1 py-0.5 px-1 transition-colors relative",
          dropZone === "before" && "border-t-2 border-foreground",
          dropZone === "after" && "border-b-2 border-foreground",
          dropZone === "child" && "bg-muted/30 border border-foreground/30",
          isCursored && "bg-muted/20 ring-1 ring-foreground/20",
          !dropZone && !isCursored && "hover:bg-muted/10"
        )}
        style={{ paddingLeft: `${depth * 16 + 4}px` }}
        draggable={!editing}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onDragEnd={handleDragEnd}
      >
        {hasContent ? (
          <button
            onClick={() => setChildrenOpen(!childrenOpen)}
            className="text-muted-foreground w-4 flex-shrink-0 mt-0.5 hover:text-foreground"
            data-testid={`toggle-children-${heading.lineNumber}`}
          >
            {childrenOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="w-4 flex-shrink-0 text-muted-foreground mt-0.5">·</span>
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
              className="w-full bg-transparent text-foreground outline-none border-b border-foreground/30 text-sm"
              data-testid={`edit-title-${heading.lineNumber}`}
            />
          ) : (
            <span
              onClick={() => { setEditing(true); setEditValue(heading.title); }}
              className={cn(
                "cursor-text text-sm leading-snug",
                isDone ? "text-muted-foreground line-through" : "text-foreground"
              )}
              data-testid={`title-${heading.lineNumber}`}
            >
              {heading.title}
            </span>
          )}

          {heading.tags.length > 0 && (
            <span className="text-muted-foreground ml-2 text-xs inline-flex items-center gap-0.5 flex-wrap">
              {heading.tags.map((tag) => (
                <button
                  key={tag}
                  onClick={(e) => { e.stopPropagation(); handleRemoveTag(tag); }}
                  className="hover:text-foreground hover:line-through transition-colors cursor-pointer"
                  title={`Remove :${tag}:`}
                  data-testid={`tag-remove-${heading.lineNumber}-${tag}`}
                >
                  :{tag}:
                </button>
              ))}
            </span>
          )}

          {addingTag ? (
            <input
              ref={tagInputRef}
              type="text"
              value={newTagValue}
              onChange={(e) => setNewTagValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleAddTag();
                if (e.key === "Escape") { setAddingTag(false); setNewTagValue(""); }
              }}
              onBlur={handleAddTag}
              className="ml-1 w-16 bg-transparent text-foreground outline-none border-b border-foreground/30 text-xs"
              placeholder="tag"
              data-testid={`tag-input-${heading.lineNumber}`}
            />
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setAddingTag(true); }}
              className="hidden group-hover:inline text-muted-foreground hover:text-foreground text-xs ml-1 transition-colors"
              title="Add tag"
              data-testid={`tag-add-${heading.lineNumber}`}
            >
              [+tag]
            </button>
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
            onClick={() => onInsertHeading(heading)}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title="Insert heading below"
            data-testid={`insert-heading-${heading.lineNumber}`}
          >
            [+]
          </button>
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
        <div className="border-l border-border pl-3 py-1 mb-1" style={{ marginLeft: `${guideLeft}px` }}>
          <div className="text-muted-foreground uppercase tracking-wider text-xs font-bold mb-1">
            Backlinks
          </div>
          {backlinks.map((bl, i) => (
            <div
              key={`${bl.sourceFile}-${bl.lineNumber}-${i}`}
              className="py-0.5 text-xs text-muted-foreground"
              data-testid={`backlink-${bl.lineNumber}-${i}`}
            >
              <span className="text-foreground">{"*".repeat(bl.level)} {bl.title}</span>
              <span className="ml-1">§ {bl.sourceFile}</span>
            </div>
          ))}
        </div>
      )}

      {childrenOpen && hasProps && (
        <div
          className="py-0.5"
          style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
          data-testid={`props-drawer-${heading.lineNumber}`}
        >
          {propEntries.map(([key, val]) => (
            <div key={key} className="flex items-center gap-1 py-px text-xs group/prop">
              <span className="text-muted-foreground/60 font-bold">:{key}:</span>
              {editingPropKey === key ? (
                <input
                  ref={propValueRef}
                  type="text"
                  value={editingPropValue}
                  onChange={(e) => setEditingPropValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleEditProp(key);
                    if (e.key === "Escape") { setEditingPropKey(null); setEditingPropValue(""); }
                  }}
                  onBlur={() => handleEditProp(key)}
                  className="flex-1 bg-transparent text-foreground outline-none border-b border-foreground/30 text-xs min-w-0"
                  data-testid={`prop-edit-${heading.lineNumber}-${key}`}
                />
              ) : (
                <span
                  onClick={() => { setEditingPropKey(key); setEditingPropValue(val); }}
                  className="text-muted-foreground cursor-text hover:text-foreground transition-colors"
                  data-testid={`prop-value-${heading.lineNumber}-${key}`}
                >
                  {val}
                </span>
              )}
              <button
                onClick={() => onDeleteProperty(heading, key)}
                className="hidden group-hover/prop:inline text-muted-foreground/40 hover:text-foreground text-xs transition-colors"
                title={`Delete :${key}:`}
                data-testid={`prop-delete-${heading.lineNumber}-${key}`}
              >
                [x]
              </button>
            </div>
          ))}
          {addingProp ? (
            <div className="flex items-center gap-1 py-px text-xs">
              <span className="text-muted-foreground/60">:</span>
              <input
                ref={propKeyRef}
                type="text"
                value={newPropKey}
                onChange={(e) => setNewPropKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Tab" && newPropKey.trim()) { e.preventDefault(); propValueRef.current?.focus(); }
                  if (e.key === "Escape") { setAddingProp(false); setNewPropKey(""); setNewPropValue(""); }
                }}
                className="w-20 bg-transparent text-foreground outline-none border-b border-foreground/30 text-xs uppercase"
                placeholder="KEY"
                data-testid={`prop-new-key-${heading.lineNumber}`}
              />
              <span className="text-muted-foreground/60">:</span>
              <input
                ref={propValueRef}
                type="text"
                value={newPropValue}
                onChange={(e) => setNewPropValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddProp();
                  if (e.key === "Escape") { setAddingProp(false); setNewPropKey(""); setNewPropValue(""); }
                }}
                className="flex-1 bg-transparent text-foreground outline-none border-b border-foreground/30 text-xs min-w-0"
                placeholder="value"
                data-testid={`prop-new-value-${heading.lineNumber}`}
              />
            </div>
          ) : (
            <button
              onClick={() => setAddingProp(true)}
              className="text-muted-foreground/40 hover:text-foreground text-xs transition-colors"
              data-testid={`prop-add-${heading.lineNumber}`}
            >
              [+ prop]
            </button>
          )}
        </div>
      )}

      {childrenOpen && !hasProps && (
        <div
          className="py-0.5 hidden group-hover:block"
          style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}
        >
          {addingProp ? (
            <div className="flex items-center gap-1 py-px text-xs">
              <span className="text-muted-foreground/60">:</span>
              <input
                ref={propKeyRef}
                type="text"
                value={newPropKey}
                onChange={(e) => setNewPropKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setAddingProp(false); setNewPropKey(""); setNewPropValue(""); }
                }}
                className="w-20 bg-transparent text-foreground outline-none border-b border-foreground/30 text-xs uppercase"
                placeholder="KEY"
              />
              <span className="text-muted-foreground/60">:</span>
              <input
                type="text"
                value={newPropValue}
                onChange={(e) => setNewPropValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleAddProp();
                  if (e.key === "Escape") { setAddingProp(false); setNewPropKey(""); setNewPropValue(""); }
                }}
                className="flex-1 bg-transparent text-foreground outline-none border-b border-foreground/30 text-xs min-w-0"
                placeholder="value"
              />
            </div>
          ) : (
            <button
              onClick={() => setAddingProp(true)}
              className="text-muted-foreground/40 hover:text-foreground text-xs transition-colors"
            >
              [+ prop]
            </button>
          )}
        </div>
      )}

      {matchedProposals.length > 0 && (
        <div style={{ paddingLeft: `${(depth + 1) * 16 + 8}px` }}>
          <button
            onClick={() => setShowProposal(!showProposal)}
            className="text-foreground text-xs font-bold phosphor-glow py-0.5"
            data-testid={`proposal-badge-${heading.lineNumber}`}
          >
            [{matchedProposals.length} proposal{matchedProposals.length > 1 ? "s" : ""}]
          </button>
          {showProposal && matchedProposals.map((p) => (
            <div key={p.id} className="border border-border/40 p-2 my-1 text-xs" data-testid={`proposal-${p.id}`}>
              <div className="text-muted-foreground mb-1">{p.reason}</div>
              <div className="grid grid-cols-2 gap-2 mb-2">
                <div>
                  <div className="text-muted-foreground/60 uppercase tracking-wider mb-0.5">Current</div>
                  <pre className="text-muted-foreground whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">{p.currentContent || "(empty)"}</pre>
                </div>
                <div>
                  <div className="text-foreground/60 uppercase tracking-wider mb-0.5">Proposed</div>
                  <pre className="text-foreground whitespace-pre-wrap text-xs max-h-32 overflow-y-auto">{p.proposedContent}</pre>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => onAcceptProposal?.(p.id)}
                  className="text-foreground font-bold hover:phosphor-glow transition-colors"
                  data-testid={`proposal-accept-${p.id}`}
                >
                  [accept]
                </button>
                <button
                  onClick={() => onRejectProposal?.(p.id)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  data-testid={`proposal-reject-${p.id}`}
                >
                  [reject]
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {childrenOpen && (hasVisibleBody || directChildren.length > 0) && (
        <div
          className="border-l border-border/40"
          style={{ marginLeft: `${guideLeft}px` }}
        >
          {hasVisibleBody && (
            <div onDragLeave={() => setBodyDropTarget(null)}>
              {bodyLines.map((line, i) => (
                <BodyBullet
                  key={i}
                  line={line}
                  index={i}
                  headingLine={heading.lineNumber}
                  depth={depth}
                  onDragStart={handleBodyDragStart}
                  onDragOver={handleBodyDragOver}
                  onDrop={handleBodyDrop}
                  dropTarget={bodyDropTarget}
                />
              ))}
            </div>
          )}

          {directChildren.map((child) => {
            const childProposals = matchedProposals.length > 0
              ? matchedProposals.filter(p => p.targetName?.toLowerCase() === child.title.toLowerCase())
              : [];
            return (
              <OutlineItem
                key={`${child.sourceFile}:${child.lineNumber}`}
                heading={child}
                children={getChildren(child, allHeadings)}
                allHeadings={allHeadings}
                depth={depth + 1}
                expandedKey={expandedKey}
                onToggleExpand={onToggleExpand}
                onToggleStatus={onToggleStatus}
                onEditTitle={onEditTitle}
                onDelete={onDelete}
                onEditTags={onEditTags}
                onInsertHeading={onInsertHeading}
                onEditProperty={onEditProperty}
                onDeleteProperty={onDeleteProperty}
                onAcceptProposal={onAcceptProposal}
                onRejectProposal={onRejectProposal}
                dragItem={dragItem}
                onDrop={onDrop}
                onReorderBody={onReorderBody}
                backlinksMap={backlinksMap}
                proposals={childProposals.length > 0 ? childProposals : undefined}
                pendingInsertLine={pendingInsertLine}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function parseCaptureSyntax(content: string): { hasTask: boolean; nestingLevel: number; label: string } {
  const trimmed = content.trim();
  let body = trimmed;
  let nestingLevel = 0;

  const nestMatch = body.match(/^(>+)\s*/);
  if (nestMatch) {
    nestingLevel = nestMatch[1].length;
    body = body.slice(nestMatch[0].length);
  }

  const hasTask = /^t\s+/i.test(body);

  let label = "";
  if (hasTask && nestingLevel > 0) label = `${"›".repeat(nestingLevel)} todo`;
  else if (hasTask) label = "todo";
  else if (nestingLevel > 0) label = `${"›".repeat(nestingLevel)} note`;

  return { hasTask, nestingLevel, label };
}

function DailyInputBacklinkDropdown({ query, onSelect, onClose, visible, selectedIdx, onSelectedIdxChange }: {
  query: string;
  onSelect: (link: string) => void;
  onClose: () => void;
  visible: boolean;
  selectedIdx: number;
  onSelectedIdxChange: (idx: number) => void;
}) {
  const { data: headings = [] } = useHeadingsSearch(query);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onSelectedIdxChange(0); }, [headings.length]);

  useEffect(() => {
    if (!visible) return;
    const handle = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [visible, onClose]);

  if (!visible || headings.length === 0) return null;

  return (
    <div ref={dropdownRef} className="absolute left-0 right-0 top-full mt-1 bg-card border border-border shadow-xl z-50 max-h-40 overflow-y-auto">
      {headings.map((h, i) => (
        <button
          key={`${h.sourceFile}-${h.lineNumber}`}
          className={cn(
            "w-full text-left px-3 py-1 flex items-center gap-2 transition-colors",
            i === selectedIdx ? "bg-muted text-foreground phosphor-glow" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
          )}
          onClick={() => onSelect(`[[file:${h.sourceFile}::*${h.title}]]`)}
          onMouseEnter={() => onSelectedIdxChange(i)}
          data-testid={`daily-backlink-option-${i}`}
        >
          <span>{"*".repeat(h.level)}</span>
          <span className="flex-1 truncate">{h.title}</span>
          <span className="text-muted-foreground">{h.sourceFile}</span>
        </button>
      ))}
    </div>
  );
}

function DailyInput() {
  const [value, setValue] = useState("");
  const dailyCapture = useDailyCapture();
  const journalAdd = useJournalAdd();
  const inputRef = useRef<HTMLInputElement>(null);
  const [backlinkQuery, setBacklinkQuery] = useState("");
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [backlinkStart, setBacklinkStart] = useState(-1);
  const [dropdownIdx, setDropdownIdx] = useState(0);
  const { data: blHeadings = [] } = useHeadingsSearch(backlinkQuery);

  const syntax = parseCaptureSyntax(value);
  const showHint = syntax.hasTask || syntax.nestingLevel > 0;

  const handleSubmit = () => {
    if (!value.trim()) return;
    if (syntax.hasTask || syntax.nestingLevel > 0) {
      dailyCapture.mutate(
        { content: value.trim() },
        { onSuccess: () => setValue("") }
      );
    } else {
      journalAdd.mutate(
        { text: value.trim() },
        { onSuccess: () => setValue("") }
      );
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    setValue(newVal);
    const cursorPos = e.target.selectionStart || 0;
    const before = newVal.slice(0, cursorPos);
    const bracketIdx = before.lastIndexOf("[[");
    if (bracketIdx !== -1 && !before.slice(bracketIdx).includes("]]")) {
      setBacklinkQuery(before.slice(bracketIdx + 2));
      setBacklinkStart(bracketIdx);
      setShowBacklinks(true);
    } else {
      setShowBacklinks(false);
      setBacklinkQuery("");
    }
  };

  const handleBacklinkSelect = (link: string) => {
    const before = value.slice(0, backlinkStart);
    const cursorPos = inputRef.current?.selectionStart || value.length;
    const afterBracket = value.slice(cursorPos).replace(/^\]*/, "");
    setValue(before + link + (afterBracket ? " " + afterBracket : ""));
    setShowBacklinks(false);
    setBacklinkQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showBacklinks && blHeadings.length > 0) {
      if (e.key === "ArrowDown") { e.preventDefault(); setDropdownIdx(i => Math.min(i + 1, blHeadings.length - 1)); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setDropdownIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const h = blHeadings[dropdownIdx];
        if (h) handleBacklinkSelect(`[[file:${h.sourceFile}::*${h.title}]]`);
        return;
      }
    }
    if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
  };

  const isPending = dailyCapture.isPending || journalAdd.isPending;

  return (
    <div className="mb-3">
      <div className="relative">
        <div className="flex items-center bg-card border border-border overflow-hidden focus-within:border-foreground transition-colors">
          <span className="text-muted-foreground ml-2.5 flex-shrink-0">
            {showHint ? "#" : "+"}
          </span>
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="t task · > nest · [[ link · or just type a note"
            className="flex-1 bg-transparent text-foreground p-2 outline-none phosphor-glow"
            data-testid="daily-input"
          />
          {value.trim() && (
            <button
              onClick={handleSubmit}
              disabled={isPending}
              className="px-3 py-1 mr-1 bg-foreground text-background font-bold hover:brightness-110 transition-all text-xs"
              data-testid="daily-input-submit"
            >
              {isPending ? "..." : "Add"}
            </button>
          )}
        </div>
        <DailyInputBacklinkDropdown
          query={backlinkQuery}
          onSelect={handleBacklinkSelect}
          onClose={() => setShowBacklinks(false)}
          visible={showBacklinks}
          selectedIdx={dropdownIdx}
          onSelectedIdxChange={setDropdownIdx}
        />
      </div>
      {showHint && (
        <div className="mt-1 text-foreground/70 text-xs font-bold phosphor-glow-dim pl-2">
          {syntax.label} → journal
        </div>
      )}
    </div>
  );
}

const BRIEFINGS_SEEN_KEY = "orgcloud-briefings-seen";
const BRIEFINGS_DISMISSED_KEY = "orgcloud-briefings-dismissed";

function getBriefingsSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(BRIEFINGS_SEEN_KEY) || "{}"); } catch { return {}; }
}
function setBriefingsSeen(seen: Record<string, number>) {
  localStorage.setItem(BRIEFINGS_SEEN_KEY, JSON.stringify(seen));
}
function getDismissed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(BRIEFINGS_DISMISSED_KEY) || "{}"); } catch { return {}; }
}
function setDismissed(d: Record<string, number>) {
  localStorage.setItem(BRIEFINGS_DISMISSED_KEY, JSON.stringify(d));
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  const days = Math.floor(hrs / 24);
  return days + "d ago";
}

function statusGlyph(status: string): string {
  if (status === "running") return ">>";
  if (status === "completed") return "=";
  if (status === "error") return "x";
  return ".";
}

function extractFirstLine(output: string): string {
  const lines = output.trim().split("\n").filter(l => l.trim());
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 5 && !trimmed.startsWith("---") && !trimmed.startsWith("===")) return trimmed;
  }
  return lines[0]?.trim() || "";
}

function extractMetricLine(output: string, metric?: string): string {
  if (metric) return metric;
  const m = output.match(/(?:found|matches|results|hits|stories|alerts?|new)[\s:]*(\d+)/i);
  return m ? m[1] + " found" : "";
}

interface BriefingProgram {
  name: string;
  status: string;
  lastRun: string | null;
  lastOutput: string | null;
  error: string | null;
  metric?: string;
  iteration: number;
}

class BriefingsErrorBoundary extends React.Component<{children: React.ReactNode}, {error: string | null}> {
  state = { error: null as string | null };
  static getDerivedStateFromError(error: Error) { return { error: error.message }; }
  render() {
    if (this.state.error) return <div className="text-xs text-red-400 px-2">[briefings error: {this.state.error}]</div>;
    return this.props.children;
  }
}

function BriefingsSectionInner() {
  const { data: runtimeData } = useRuntimeState();
  const dailyCapture = useDailyCapture();
  const journalAdd = useJournalAdd();
  const [expandedProgram, setExpandedProgram] = useState<string | null>(null);
  const [dismissed, setDismissedState] = useState<Record<string, number>>(getDismissed);
  const [seen, setSeenState] = useState<Record<string, number>>(getBriefingsSeen);
  const [briefingsOpen, setBriefingsOpen] = useState(true);

  const programs: BriefingProgram[] = useMemo(() => {
    if (!runtimeData?.programs) return [];
    return Object.entries(runtimeData.programs as Record<string, any>)
      .filter(([_, p]) => {
        if (!p.lastOutput && !p.error) return false;
        return true;
      })
      .map(([name, p]) => ({
        name,
        status: p.status,
        lastRun: p.lastRun,
        lastOutput: p.lastOutput,
        error: p.error,
        metric: p.metric,
        iteration: p.iteration || 0,
      }))
      .sort((a, b) => {
        const ta = a.lastRun ? new Date(a.lastRun).getTime() : 0;
        const tb = b.lastRun ? new Date(b.lastRun).getTime() : 0;
        return tb - ta;
      });
  }, [runtimeData]);

  const visiblePrograms = useMemo(() => {
    return programs.filter(p => {
      const dismissedAt = dismissed[p.name];
      if (!dismissedAt || !p.lastRun) return true;
      return new Date(p.lastRun).getTime() > dismissedAt;
    });
  }, [programs, dismissed]);

  const newCount = useMemo(() => {
    return visiblePrograms.filter(p => {
      const seenAt = seen[p.name];
      if (!seenAt || !p.lastRun) return !!p.lastRun;
      return new Date(p.lastRun).getTime() > seenAt;
    }).length;
  }, [visiblePrograms, seen]);

  useEffect(() => {
    if (briefingsOpen && visiblePrograms.length > 0) {
      const updated = { ...seen };
      for (const p of visiblePrograms) {
        if (p.lastRun) {
          const runTime = new Date(p.lastRun).getTime();
          if (!updated[p.name] || updated[p.name] < runTime) {
            updated[p.name] = runTime;
          }
        }
      }
      setSeenState(updated);
      setBriefingsSeen(updated);
    }
  }, [briefingsOpen, visiblePrograms]);

  const handleDismiss = (name: string) => {
    const updated = { ...dismissed, [name]: Date.now() };
    setDismissedState(updated);
    setDismissed(updated);
    if (expandedProgram === name) setExpandedProgram(null);
  };

  const handleCaptureTask = (p: BriefingProgram) => {
    const firstLine = extractFirstLine(p.lastOutput || p.error || "");
    const taskText = "t " + p.name + ": " + firstLine.slice(0, 120);
    dailyCapture.mutate({ content: taskText });
  };

  const handleCaptureNote = (p: BriefingProgram) => {
    const output = (p.lastOutput || p.error || "").slice(0, 500);
    journalAdd.mutate({ text: "[" + p.name + "] " + output });
  };

  if (visiblePrograms.length === 0) {
    return (
      <div className="mb-2 px-2 py-1">
        <span className="text-muted-foreground/40 text-xs uppercase tracking-wider font-bold">briefings</span>
        <span className="text-muted-foreground/30 text-xs ml-2">-- no recent results --</span>
      </div>
    );
  }

  return (
    <div className="mb-2">
      <button
        onClick={() => setBriefingsOpen(prev => !prev)}
        className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground transition-colors px-2 py-1 w-full"
        data-testid="toggle-briefings-section"
      >
        <span>{briefingsOpen ? "▾" : "▸"}</span>
        <span className="uppercase tracking-wider font-bold">briefings</span>
        {newCount > 0 && (
          <span className="text-foreground font-bold">({newCount} new)</span>
        )}
        {newCount === 0 && (
          <span className="opacity-60">({visiblePrograms.length})</span>
        )}
      </button>

      {briefingsOpen && (
        <div className="space-y-0.5 mt-1">
          {visiblePrograms.map(p => {
            const isNew = !seen[p.name] || (p.lastRun && new Date(p.lastRun).getTime() > (seen[p.name] || 0));
            const isExpanded = expandedProgram === p.name;
            const isError = p.status === "error";
            const isRunning = p.status === "running";
            const metricText = p.lastOutput ? extractMetricLine(p.lastOutput, p.metric) : "";

            return (
              <div key={p.name} className="group" data-testid={`briefing-program-${p.name}`}>
                <div
                  className={cn(
                    "flex items-center gap-2 px-2 py-1 text-xs cursor-pointer hover:bg-foreground/5 transition-colors",
                    isNew && "border-l-2 border-foreground/40",
                    !isNew && "border-l-2 border-transparent",
                  )}
                  onClick={() => setExpandedProgram(isExpanded ? null : p.name)}
                >
                  <span className={cn(
                    "font-mono w-5 text-center flex-shrink-0",
                    isError && "text-red-400",
                    isRunning && "text-yellow-400",
                    !isError && !isRunning && "text-muted-foreground",
                  )}>
                    [{statusGlyph(p.status)}]
                  </span>
                  <span className={cn(
                    "font-bold truncate",
                    isNew ? "text-foreground phosphor-glow" : "text-muted-foreground"
                  )}>
                    {p.name}
                  </span>
                  <span className="text-muted-foreground/60 flex-shrink-0">
                    {p.lastRun ? relativeTime(p.lastRun) : ""}
                  </span>
                  {metricText && (
                    <span className="text-foreground/70 flex-shrink-0 ml-auto font-mono">
                      {metricText}
                    </span>
                  )}
                </div>

                {isExpanded && (
                  <div className="ml-7 mr-2 mt-1 mb-2">
                    <div className="flex gap-1 mb-1.5">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCaptureTask(p); }}
                        className="text-xs px-1.5 py-0.5 border border-border hover:bg-foreground/10 hover:text-foreground text-muted-foreground transition-colors font-mono"
                        title="Capture as task"
                        data-testid={`briefing-capture-task-${p.name}`}
                      >
                        [t]
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleCaptureNote(p); }}
                        className="text-xs px-1.5 py-0.5 border border-border hover:bg-foreground/10 hover:text-foreground text-muted-foreground transition-colors font-mono"
                        title="Save as journal note"
                        data-testid={`briefing-capture-note-${p.name}`}
                      >
                        [n]
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDismiss(p.name); }}
                        className="text-xs px-1.5 py-0.5 border border-border hover:bg-foreground/10 hover:text-muted-foreground/40 text-muted-foreground transition-colors font-mono"
                        title="Dismiss until next run"
                        data-testid={`briefing-dismiss-${p.name}`}
                      >
                        [x]
                      </button>
                    </div>
                    <pre className={cn(
                      "text-xs whitespace-pre-wrap break-words leading-relaxed max-h-64 overflow-y-auto",
                      "font-mono",
                      isError ? "text-red-400/80" : "text-foreground/70 phosphor-glow-dim"
                    )}>
                      {(isError ? p.error : p.lastOutput)?.slice(0, 2000) || "(no output)"}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BriefingsSection() {
  return (
    <BriefingsErrorBoundary>
      <BriefingsSectionInner />
    </BriefingsErrorBoundary>
  );
}

function daysOverdue(scheduledDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const scheduled = new Date(scheduledDate + "T00:00:00");
  const diff = Math.floor((today.getTime() - scheduled.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

function AgendaItemRow({ item, overdueDays, onToggle, onReschedule, onEditTitle, onDelete, onNavigateFile, isCursored }: {
  item: OrgHeading;
  overdueDays: number;
  onToggle: (item: OrgHeading) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
  onNavigateFile?: (file: string) => void;
  isCursored?: boolean;
}) {
  const isDone = item.status === "DONE";
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.title);
  const [rescheduling, setRescheduling] = useState(false);
  const [rescheduleDate, setRescheduleDate] = useState(new Date().toISOString().split("T")[0]);
  const editRef = useRef<HTMLInputElement>(null);
  const dateRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editing]);

  useEffect(() => {
    if (rescheduling && dateRef.current) {
      dateRef.current.focus();
    }
  }, [rescheduling]);

  const handleEditSubmit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== item.title) {
      onEditTitle(item, trimmed);
    }
    setEditing(false);
  };

  const handleRescheduleSubmit = () => {
    if (rescheduleDate) {
      onReschedule(item, rescheduleDate);
    }
    setRescheduling(false);
  };

  return (
    <div className={cn("group flex items-start gap-2 py-1 px-2 transition-colors", isCursored ? "bg-muted/20 ring-1 ring-foreground/20" : "hover:bg-muted/20")} data-testid={`agenda-item-${item.lineNumber}`}>
      <button
        onClick={() => onToggle(item)}
        className="mt-0.5 flex-shrink-0 font-mono"
        data-testid={`toggle-status-${item.lineNumber}`}
      >
        {isDone ? (
          <span className="text-muted-foreground">[x]</span>
        ) : (
          <span className="text-foreground">[ ]</span>
        )}
      </button>

      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={editRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleEditSubmit();
              if (e.key === "Escape") { setEditing(false); setEditValue(item.title); }
            }}
            onBlur={handleEditSubmit}
            className="w-full bg-transparent text-foreground outline-none border-b border-foreground/30 phosphor-glow"
            data-testid={`edit-title-${item.lineNumber}`}
          />
        ) : (
          <div
            onClick={() => { setEditing(true); setEditValue(item.title); }}
            className={cn(
              "leading-snug cursor-text",
              isDone ? "text-muted-foreground line-through phosphor-glow-dim" : "text-foreground phosphor-glow"
            )}
            data-testid={`title-${item.lineNumber}`}
          >
            {overdueDays > 0 && (
              <span className="text-muted-foreground mr-1">Sched. {overdueDays}x:</span>
            )}
            {item.title}
          </div>
        )}

        {rescheduling ? (
          <div className="flex items-center gap-2 mt-1">
            <input
              ref={dateRef}
              type="date"
              value={rescheduleDate}
              onChange={(e) => setRescheduleDate(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRescheduleSubmit();
                if (e.key === "Escape") setRescheduling(false);
              }}
              className="bg-background text-foreground border border-border px-1 py-0.5 text-xs outline-none focus:border-foreground/50"
              data-testid={`reschedule-date-${item.lineNumber}`}
            />
            <button
              onClick={handleRescheduleSubmit}
              className="text-foreground text-xs hover:phosphor-glow"
              data-testid={`reschedule-confirm-${item.lineNumber}`}
            >
              [ok]
            </button>
            <button
              onClick={() => setRescheduling(false)}
              className="text-muted-foreground text-xs hover:text-foreground"
            >
              [x]
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-muted-foreground text-xs">
            <button
              onClick={() => onNavigateFile?.(item.sourceFile)}
              className="hover:text-foreground transition-colors flex items-center gap-0.5 truncate max-w-[140px]"
              data-testid={`navigate-${item.sourceFile}`}
            >
              <span>§</span>
              {item.sourceFile}
            </button>
            {item.tags.length > 0 && (
              <div className="flex items-center gap-1">
                {item.tags.map((tag) => (
                  <span key={tag}>:{tag}:</span>
                ))}
              </div>
            )}
            {item.scheduledDate && (
              <span>{item.scheduledDate}</span>
            )}
            <span className="hidden group-hover:inline-flex items-center gap-1 ml-auto">
              <button
                onClick={() => setRescheduling(true)}
                className="hover:text-foreground transition-colors"
                title="Reschedule"
                data-testid={`reschedule-${item.lineNumber}`}
              >
                [s]
              </button>
              <button
                onClick={() => onDelete(item)}
                className="hover:text-foreground transition-colors"
                title="Delete"
                data-testid={`delete-${item.lineNumber}`}
              >
                [d]
              </button>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function JournalEntryRow({ item, onToggle, onNavigateFile, isCursored }: {
  item: OrgHeading;
  onToggle: (item: OrgHeading) => void;
  onNavigateFile: (file: string) => void;
  isCursored: boolean;
}) {
  const bodyLines = item.body ? item.body.split("\n").filter(l => l.trim()) : [];
  const refMatch = bodyLines.length > 0 ? bodyLines[0].match(/(?:Referenced from|Captured to) \[\[file:(.+?)\]\]/) : null;
  const refFile = refMatch ? refMatch[1] : null;
  const isRef = !!refMatch;

  return (
    <div
      className={cn(
        "group flex items-start gap-2 py-1 px-2 transition-colors",
        isCursored && "bg-foreground/10 border-l-2 border-foreground",
        !isCursored && "border-l-2 border-transparent"
      )}
      data-testid={`journal-entry-${item.lineNumber}`}
    >
      {item.status ? (
        <button
          onClick={() => onToggle(item)}
          className="flex-shrink-0 mt-0.5 text-foreground/80 hover:text-foreground"
          data-testid={`journal-toggle-${item.lineNumber}`}
        >
          {item.status === "DONE" ? "[x]" : "[ ]"}
        </button>
      ) : (
        <span className="flex-shrink-0 mt-0.5 text-muted-foreground/50">--</span>
      )}
      <div className="flex-1 min-w-0">
        <span className={cn(
          "phosphor-glow",
          item.status === "DONE" && "line-through text-muted-foreground/60"
        )}>
          {item.title}
        </span>
        {isRef && refFile && (
          <button
            onClick={() => onNavigateFile(refFile)}
            className="ml-2 text-muted-foreground/50 hover:text-foreground text-xs phosphor-glow-dim"
            data-testid={`journal-ref-${item.lineNumber}`}
          >
            {"§ " + refFile.replace(".org", "")}
          </button>
        )}
        {!isRef && bodyLines.length > 0 && (
          <div className="text-muted-foreground/50 text-xs mt-0.5 phosphor-glow-dim">
            {bodyLines[0]}
          </div>
        )}
      </div>
    </div>
  );
}

function TodayTab({ agenda, onToggle, onReschedule, onEditTitle, onDelete, onNavigateFile, cursorIndex }: {
  agenda: { overdue: AgendaDay[]; today: AgendaDay; upcoming: AgendaDay[] } | undefined;
  onToggle: (item: OrgHeading) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
  onNavigateFile: (file: string) => void;
  cursorIndex: number;
}) {
  const todayStr = new Date().toISOString().split("T")[0];
  const { data: journalEntries = [] } = useJournalDaily(todayStr);
  const [capturedOpen, setCapturedOpen] = useState(false);

  if (!agenda) return null;

  const overdueItems: (OrgHeading & { _overdueDays: number })[] = [];
  for (const day of agenda.overdue) {
    for (const item of day.items) {
      const days = item.scheduledDate ? daysOverdue(item.scheduledDate) : 1;
      overdueItems.push({ ...item, _overdueDays: days });
    }
  }
  overdueItems.sort((a, b) => b._overdueDays - a._overdueDays);

  const todayItems = agenda.today.items
    .map(item => ({ ...item, _overdueDays: 0 }));
  const scheduledItems = [...overdueItems, ...todayItems];

  const capturedEntries = journalEntries.filter(e => {
    const body = e.body || "";
    return /(?:Referenced from|Captured to) \[\[file:/.test(body);
  });
  const nonCapturedEntries = journalEntries.filter(e => {
    const body = e.body || "";
    return !/(?:Referenced from|Captured to) \[\[file:/.test(body);
  });

  const scheduledCount = scheduledItems.length;
  const journalCursorOffset = scheduledCount;
  const visibleJournalCount = nonCapturedEntries.length + (capturedOpen ? capturedEntries.length : 0);
  const hasScheduled = scheduledItems.length > 0;
  const hasJournal = nonCapturedEntries.length > 0;
  const hasCaptured = capturedEntries.length > 0;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 mb-2">
        <span className="font-bold text-foreground uppercase tracking-wider phosphor-glow">
          {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
        </span>
      </div>

      <DailyInput />

      <BriefingsSection />

      {hasScheduled && (
        <div className="space-y-1">
          {scheduledItems.map((item, i) => (
            <div key={`sched-${item.sourceFile}-${item.lineNumber}`} data-cursor-index={i}>
              <AgendaItemRow
                item={item}
                overdueDays={item._overdueDays}
                onToggle={onToggle}
                onReschedule={onReschedule}
                onEditTitle={onEditTitle}
                onDelete={onDelete}
                onNavigateFile={onNavigateFile}
                isCursored={cursorIndex === i}
              />
            </div>
          ))}
        </div>
      )}

      {hasScheduled && (hasJournal || hasCaptured) && (
        <div className="my-2 border-t border-border/20" />
      )}

      {hasJournal && (
        <div className="space-y-0.5">
          {nonCapturedEntries.map((item, i) => (
            <div key={`jrnl-${item.lineNumber}`} data-cursor-index={journalCursorOffset + i}>
              <JournalEntryRow
                item={item}
                onToggle={onToggle}
                onNavigateFile={onNavigateFile}
                isCursored={cursorIndex === journalCursorOffset + i}
              />
            </div>
          ))}
        </div>
      )}

      {hasCaptured && (
        <div className="mt-2">
          <button
            onClick={() => setCapturedOpen(prev => !prev)}
            className="flex items-center gap-1 text-muted-foreground text-xs hover:text-foreground transition-colors px-2 py-1"
            data-testid="toggle-captured-section"
          >
            <span>{capturedOpen ? "▾" : "▸"}</span>
            <span className="uppercase tracking-wider font-bold">captured</span>
            <span className="opacity-60">({capturedEntries.length})</span>
          </button>
          {capturedOpen && (
            <div className="space-y-0.5 mt-1">
              {capturedEntries.map((item, i) => {
                const idx = journalCursorOffset + nonCapturedEntries.length + i;
                return (
                  <div key={`cap-${item.lineNumber}`} data-cursor-index={idx}>
                    <JournalEntryRow
                      item={item}
                      onToggle={onToggle}
                      onNavigateFile={onNavigateFile}
                      isCursored={cursorIndex === idx}
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {!hasScheduled && !hasJournal && !hasCaptured && (
        <div className="text-muted-foreground/40 italic py-4 pl-6 phosphor-glow-dim text-xs">
          Empty day. Use the input above to capture tasks or notes.
        </div>
      )}
    </div>
  );
}

function WeekTab({ agenda, onToggle, onReschedule, onEditTitle, onDelete, onNavigateFile, cursorIndex }: {
  agenda: { overdue: AgendaDay[]; today: AgendaDay; upcoming: AgendaDay[] } | undefined;
  onToggle: (item: OrgHeading) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
  onNavigateFile: (file: string) => void;
  cursorIndex: number;
}) {
  if (!agenda) return null;

  const today = agenda.today;
  const upcoming = agenda.upcoming.filter(d => d.items.length > 0);

  const dayStartIndices = useMemo(() => {
    const indices: number[] = [];
    let idx = today.items.length > 0 ? today.items.length : 0;
    for (const day of upcoming) {
      indices.push(idx);
      idx += day.items.length;
    }
    return indices;
  }, [today, upcoming]);

  return (
    <div className="space-y-4">
      {today.items.length > 0 && (
        <DaySection day={today} variant="today" onToggle={onToggle} onReschedule={onReschedule} onEditTitle={onEditTitle} onDelete={onDelete} onNavigateFile={onNavigateFile} cursorIndex={cursorIndex} startIndex={0} />
      )}
      {upcoming.map((day, di) => (
        <DaySection key={day.date} day={day} variant="upcoming" onToggle={onToggle} onReschedule={onReschedule} onEditTitle={onEditTitle} onDelete={onDelete} onNavigateFile={onNavigateFile} cursorIndex={cursorIndex} startIndex={dayStartIndices[di]} />
      ))}
      {upcoming.length === 0 && today.items.length === 0 && (
        <div className="text-center py-8 text-muted-foreground phosphor-glow-dim">
          No upcoming items scheduled.
        </div>
      )}
    </div>
  );
}

function DaySection({ day, variant, onToggle, onReschedule, onEditTitle, onDelete, onNavigateFile, cursorIndex, startIndex }: {
  day: AgendaDay;
  variant: "overdue" | "today" | "upcoming";
  onToggle: (item: OrgHeading) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
  onNavigateFile: (file: string) => void;
  cursorIndex: number;
  startIndex: number;
}) {
  if (day.items.length === 0) return null;

  return (
    <div className="border-l-2 border-border pl-4 mb-4">
      <div className={cn(
        "font-bold uppercase tracking-wider mb-2 phosphor-glow-dim",
        variant === "overdue" ? "text-foreground phosphor-glow-bright" : "text-muted-foreground"
      )}>
        {day.label} <span className="opacity-50 ml-1">{day.date}</span>
      </div>
      <div className="space-y-1">
        {day.items.map((item, i) => (
          <div key={`${item.sourceFile}-${item.lineNumber}`} data-cursor-index={startIndex + i}>
            <AgendaItemRow item={item} overdueDays={0} onToggle={onToggle} onReschedule={onReschedule} onEditTitle={onEditTitle} onDelete={onDelete} onNavigateFile={onNavigateFile} isCursored={cursorIndex === startIndex + i} />
          </div>
        ))}
      </div>
    </div>
  );
}

function FlatItemList({ items, onToggle, onReschedule, onEditTitle, onDelete, onNavigateFile, cursorIndex }: {
  items: OrgHeading[];
  onToggle: (item: OrgHeading) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
  onNavigateFile: (file: string) => void;
  cursorIndex: number;
}) {
  if (items.length === 0) {
    return <div className="text-center py-8 text-muted-foreground phosphor-glow-dim">No items found.</div>;
  }

  return (
    <div className="space-y-1">
      {items.map((item, i) => (
        <div key={`${item.sourceFile}-${item.lineNumber}`} data-cursor-index={i}>
          <AgendaItemRow item={item} overdueDays={0} onToggle={onToggle} onReschedule={onReschedule} onEditTitle={onEditTitle} onDelete={onDelete} onNavigateFile={onNavigateFile} isCursored={cursorIndex === i} />
        </div>
      ))}
    </div>
  );
}

function BufferTabBar({ orgFiles, selectedFile, onSelect, showHints }: {
  orgFiles: { id: number; name: string }[];
  selectedFile: string;
  onSelect: (name: string) => void;
  showHints: boolean;
}) {
  if (orgFiles.length === 0) return null;

  return (
    <div className="flex items-center gap-0 px-2 py-0.5 border-b border-border/50 overflow-x-auto flex-shrink-0">
      {showHints && <span className="text-muted-foreground/40 text-xs mr-1 flex-shrink-0">[</span>}
      {orgFiles.map((f, i) => (
        <React.Fragment key={f.name}>
          {i > 0 && <span className="text-border mx-0.5">|</span>}
          <button
            onClick={() => onSelect(f.name)}
            className={cn(
              "px-1.5 py-0.5 text-xs transition-colors flex-shrink-0",
              selectedFile === f.name
                ? "text-foreground font-bold phosphor-glow"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid={`buffer-tab-${f.name}`}
          >
            {f.name.replace(".org", "")}
          </button>
        </React.Fragment>
      ))}
      {showHints && <span className="text-muted-foreground/40 text-xs ml-1 flex-shrink-0">]</span>}
    </div>
  );
}

function OutlinerWhichKey({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
      data-testid="which-key-overlay"
    >
      <div
        className="bg-card border border-border p-4 max-w-md w-full font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-foreground font-bold mb-3 phosphor-glow text-sm uppercase tracking-wider">
          Keybindings — Outliner
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-0">
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Global</div>
            {[["SPC", "Command palette"], ["Alt+C", "Org capture"], ["?", "Toggle this help"]].map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2 py-0.5 text-xs">
                <span className="text-foreground font-bold w-16 phosphor-glow">{key}</span>
                <span className="text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Outline</div>
            {[["j / k", "Navigate items"], ["o", "New heading below"], ["[ / ]", "Prev / next buffer"]].map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2 py-0.5 text-xs">
                <span className="text-foreground font-bold w-16 phosphor-glow">{key}</span>
                <span className="text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="text-muted-foreground text-xs mt-3 text-center phosphor-glow-dim">
          Press ? or Esc to close
        </div>
      </div>
    </div>
  );
}

function AgendaWhichKey({ tab, onClose }: { tab: string; onClose: () => void }) {
  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      onClick={onClose}
      data-testid="which-key-overlay"
    >
      <div
        className="bg-card border border-border p-4 max-w-md w-full font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-foreground font-bold mb-3 phosphor-glow text-sm uppercase tracking-wider">
          Keybindings — {tab.charAt(0).toUpperCase() + tab.slice(1)}
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-0">
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Global</div>
            {[["1-4", "Switch tabs"], ["SPC", "Command palette"], ["Alt+C", "Org capture"], ["?", "Toggle this help"]].map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2 py-0.5 text-xs">
                <span className="text-foreground font-bold w-16 phosphor-glow">{key}</span>
                <span className="text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Agenda</div>
            {[["j / k", "Navigate items"]].map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2 py-0.5 text-xs">
                <span className="text-foreground font-bold w-16 phosphor-glow">{key}</span>
                <span className="text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="text-muted-foreground text-xs mt-3 text-center phosphor-glow-dim">
          Press ? or Esc to close
        </div>
      </div>
    </div>
  );
}

export function OutlinerView({ initialFile }: { initialFile?: string }) {
  const { data: headings = [], isLoading } = useAllHeadings();
  const { data: orgFiles = [] } = useOrgFiles();
  const { data: backlinksData = [] } = useBacklinks();

  const toggleMutation = useToggleOrgStatus();
  const editTitleMutation = useEditHeadingTitle();
  const deleteMutation = useDeleteHeading();
  const editTagsMutation = useEditTags();
  const insertHeadingMutation = useInsertHeading();
  const moveMutation = useMoveHeading();
  const reorderBodyMutation = useReorderBodyLine();
  const editPropertyMutation = useEditProperty();
  const deletePropertyMutation = useDeleteProperty();
  const acceptProposalMutation = useAcceptProposal();
  const rejectProposalMutation = useRejectProposal();

  const [selectedFile, setSelectedFile] = useState<string>(initialFile || "");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [pendingInsertLine, setPendingInsertLine] = useState<number | null>(null);
  const [showHints, setShowHints] = useState(() => {
    try { return localStorage.getItem("orgcloud-show-hints") !== "false"; } catch { return true; }
  });
  const [whichKeyOpen, setWhichKeyOpen] = useState(false);
  const dragItem = useRef<OutlineHeading | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialFile) setSelectedFile(initialFile);
  }, [initialFile]);

  useEffect(() => {
    if (orgFiles.length > 0 && !selectedFile) {
      setSelectedFile(orgFiles[0].name);
    }
  }, [orgFiles, selectedFile]);

  useEffect(() => {
    try { localStorage.setItem("orgcloud-show-hints", String(showHints)); } catch {}
  }, [showHints]);

  useEffect(() => {
    const handler = () => setShowHints(prev => !prev);
    window.addEventListener("toggle-hints", handler);
    return () => window.removeEventListener("toggle-hints", handler);
  }, []);

  const backlinksMap = useMemo(() => {
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

  const handleEditTags = useCallback((h: OutlineHeading, tags: string[]) => {
    editTagsMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, tags });
  }, [editTagsMutation]);

  const handleInsertHeading = useCallback((h: OutlineHeading) => {
    insertHeadingMutation.mutate(
      { fileName: h.sourceFile, afterLine: h.lineNumber, level: h.level },
      {
        onSuccess: (data: { newLineNumber: number }) => {
          setPendingInsertLine(data.newLineNumber);
          setTimeout(() => setPendingInsertLine(null), 2000);
        },
      }
    );
  }, [insertHeadingMutation]);

  const handleEditProperty = useCallback((h: OutlineHeading, key: string, value: string) => {
    editPropertyMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, key, value });
  }, [editPropertyMutation]);

  const handleDeleteProperty = useCallback((h: OutlineHeading, key: string) => {
    deletePropertyMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, key });
  }, [deletePropertyMutation]);

  const handleAcceptProposal = useCallback((id: number) => {
    acceptProposalMutation.mutate(id);
  }, [acceptProposalMutation]);

  const handleRejectProposal = useCallback((id: number) => {
    rejectProposalMutation.mutate(id);
  }, [rejectProposalMutation]);

  const handleReorderBody = useCallback((h: OutlineHeading, fromIndex: number, toIndex: number) => {
    reorderBodyMutation.mutate({ fileName: h.sourceFile, headingLine: h.lineNumber, fromIndex, toIndex });
  }, [reorderBodyMutation]);

  const getSubtreeEnd = useCallback((h: OutlineHeading): number => {
    const fileHeadings = headings.filter(x => x.sourceFile === h.sourceFile);
    const idx = fileHeadings.findIndex(x => x.lineNumber === h.lineNumber);
    if (idx === -1) return h.lineNumber;
    for (let i = idx + 1; i < fileHeadings.length; i++) {
      if (fileHeadings[i].level <= h.level) return fileHeadings[i].lineNumber;
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

  const filteredTopLevel = useMemo(() => {
    return headings.filter(h => h.level === 1 && h.sourceFile === selectedFile);
  }, [headings, selectedFile]);

  const filteredHeadings = useMemo(() => {
    return headings.filter(h => h.sourceFile === selectedFile);
  }, [headings, selectedFile]);

  const fileTitle = useMemo(() => {
    const file = orgFiles.find(f => f.name === selectedFile);
    if (!file) return selectedFile;
    const match = (file as any).content?.match(/^#\+TITLE:\s*(.+)$/m);
    return match ? match[1].trim() : selectedFile.replace(".org", "");
  }, [orgFiles, selectedFile]);

  const isOpenClaw = selectedFile === "openclaw.org";
  const { data: clawStatus } = useOpenClawStatus();
  const { data: proposals = [] } = useOpenClawProposals();
  const { data: runtimeData } = useRuntimeState();

  const topLevelProposals = useMemo(() => {
    if (!isOpenClaw || proposals.length === 0) return [];
    return proposals.map(p => ({
      id: p.id,
      section: p.section,
      targetName: p.targetName,
      reason: p.reason,
      currentContent: p.currentContent,
      proposedContent: p.proposedContent,
    }));
  }, [isOpenClaw, proposals]);

  const currentItemCount = filteredTopLevel.length;

  useEffect(() => {
    setCursorIndex(0);
  }, [selectedFile]);

  useEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-cursor-index="${cursorIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [cursorIndex]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (isInput) return;

      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setWhichKeyOpen(prev => !prev);
        return;
      }

      if (whichKeyOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setWhichKeyOpen(false);
        }
        return;
      }

      if (e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const idx = orgFiles.findIndex(f => f.name === selectedFile);
        if (idx > 0) setSelectedFile(orgFiles[idx - 1].name);
        else if (orgFiles.length > 0) setSelectedFile(orgFiles[orgFiles.length - 1].name);
        return;
      }
      if (e.key === "]" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const idx = orgFiles.findIndex(f => f.name === selectedFile);
        if (idx < orgFiles.length - 1) setSelectedFile(orgFiles[idx + 1].name);
        else if (orgFiles.length > 0) setSelectedFile(orgFiles[0].name);
        return;
      }

      if (e.key === "j" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setCursorIndex(prev => currentItemCount > 0 ? Math.min(prev + 1, currentItemCount - 1) : 0);
        return;
      }
      if (e.key === "k" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setCursorIndex(prev => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "o" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const cursoredHeading = filteredTopLevel[cursorIndex];
        if (cursoredHeading) {
          handleInsertHeading(cursoredHeading);
        }
        return;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [whichKeyOpen, selectedFile, orgFiles, currentItemCount, filteredTopLevel, cursorIndex, handleInsertHeading]);

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background relative" data-testid="outliner-view">
      <div className="flex items-center border-b border-border bg-card px-2 py-1 gap-1 overflow-x-auto flex-shrink-0">
        <span className="text-foreground">{"{*}"}</span>
        <span className="text-foreground font-bold mr-2 phosphor-glow">Outliner</span>
      </div>

      <BufferTabBar orgFiles={orgFiles} selectedFile={selectedFile} onSelect={(f) => { setSelectedFile(f); setCursorIndex(0); }} showHints={showHints} />

      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="w-full p-1 sm:p-2 pb-32">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 phosphor-glow-dim">Loading...</div>
          ) : (
            <>
              {selectedFile && (
                <div className="px-1 py-2 mb-2 border-b border-border/30">
                  <div>
                    <span className="text-foreground font-bold phosphor-glow text-sm">{fileTitle}</span>
                    <span className="text-muted-foreground text-xs ml-2">{selectedFile}</span>
                  </div>
                  {isOpenClaw && clawStatus?.exists && (
                    <div
                      className={cn(
                        "text-xs mt-1 cursor-pointer hover:underline",
                        clawStatus.errorCount && clawStatus.errorCount > 0
                          ? "text-foreground font-bold phosphor-glow"
                          : "text-muted-foreground phosphor-glow-dim"
                      )}
                      data-testid="openclaw-status-line"
                    >
                      {clawStatus.errorCount && clawStatus.errorCount > 0 ? (
                        <span>[{clawStatus.errorCount} error{clawStatus.errorCount > 1 ? "s" : ""}] {clawStatus.errors?.slice(0, 2).join(", ")}</span>
                      ) : (
                        <span>[ok] {clawStatus.skillCount} skill{clawStatus.skillCount !== 1 ? "s" : ""} · {clawStatus.programCount} program{clawStatus.programCount !== 1 ? "s" : ""}{clawStatus.activeProgramCount ? ` (${clawStatus.activeProgramCount} active)` : ""}{clawStatus.pendingProposalCount ? ` · ${clawStatus.pendingProposalCount} pending` : ""}</span>
                      )}
                    </div>
                  )}
                  {isOpenClaw && runtimeData && (
                    <div className="text-xs mt-0.5 text-muted-foreground" data-testid="runtime-status-line">
                      {(() => {
                        const progs = runtimeData.programs ? Object.entries(runtimeData.programs) : [];
                        const progCount = progs.length;
                        const running = progs.filter(([, s]: [string, any]) => s.status === "running").length;
                        if (!runtimeData.active) return <span>[runtime: paused]</span>;
                        let nextMs = Infinity;
                        progs.forEach(([, s]: [string, any]) => {
                          if (s.nextRun) {
                            const ms = new Date(s.nextRun).getTime() - Date.now();
                            if (ms > 0 && ms < nextMs) nextMs = ms;
                          }
                        });
                        const nextStr = nextMs < Infinity
                          ? nextMs < 60000 ? `${Math.floor(nextMs / 1000)}s` : `${Math.floor(nextMs / 60000)}m`
                          : "?";
                        return <span>[runtime: active · {progCount} program{progCount !== 1 ? "s" : ""}{running > 0 ? ` · ${running} running` : ""} · next {nextStr}]</span>;
                      })()}
                    </div>
                  )}
                </div>
              )}
              {filteredTopLevel.length === 0 ? (
                <div className="text-muted-foreground text-xs px-1 py-8 italic text-center">
                  Empty document. Use Alt+C to capture items.
                </div>
              ) : (
                filteredTopLevel.map((h, i) => {
                  const sectionProposals = isOpenClaw
                    ? topLevelProposals.filter(p => p.section.toUpperCase() === h.title.toUpperCase() || p.targetName?.toLowerCase() === h.title.toLowerCase())
                    : [];
                  return (
                    <div key={`${h.sourceFile}:${h.lineNumber}`} data-cursor-index={i}>
                      <OutlineItem
                        heading={h}
                        children={getChildren(h, filteredHeadings)}
                        allHeadings={filteredHeadings}
                        depth={0}
                        expandedKey={expandedKey}
                        onToggleExpand={toggleExpand}
                        onToggleStatus={handleToggleStatus}
                        onEditTitle={handleEditTitle}
                        onDelete={handleDelete}
                        onEditTags={handleEditTags}
                        onInsertHeading={handleInsertHeading}
                        onEditProperty={handleEditProperty}
                        onDeleteProperty={handleDeleteProperty}
                        onAcceptProposal={handleAcceptProposal}
                        onRejectProposal={handleRejectProposal}
                        dragItem={dragItem}
                        onDrop={handleDrop}
                        onReorderBody={handleReorderBody}
                        backlinksMap={backlinksMap}
                        proposals={sectionProposals.length > 0 ? sectionProposals : undefined}
                        isCursored={cursorIndex === i}
                        pendingInsertLine={pendingInsertLine}
                      />
                    </div>
                  );
                })
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {showHints && !isLoading && (
        <div className="flex items-center justify-center gap-3 px-2 py-0.5 border-t border-border/30 text-muted-foreground/40 text-xs flex-shrink-0">
          <span>j/k navigate</span>
          <span>o new heading</span>
          <span>Enter open</span>
          <span>[ ] buffers</span>
          <span>? help</span>
        </div>
      )}

      {whichKeyOpen && <OutlinerWhichKey onClose={() => setWhichKeyOpen(false)} />}
    </div>
  );
}

export function AgendaView({ onNavigateToFile }: { onNavigateToFile?: (file: string) => void }) {
  const { data: agenda, isLoading: agendaLoading } = useOrgAgenda();
  const { data: allTodos = [], isLoading: todosLoading } = useOrgTodos();
  const { data: allDone = [], isLoading: doneLoading } = useOrgDone();
  const todayDateStr = useMemo(() => new Date().toISOString().split("T")[0], []);
  const { data: journalEntries = [] } = useJournalDaily(todayDateStr);

  const toggleMutation = useToggleOrgStatus();
  const editTitleMutation = useEditHeadingTitle();
  const deleteMutation = useDeleteHeading();
  const rescheduleMutation = useRescheduleHeading();

  const [tab, setTab] = useState<AgendaTabMode>("today");
  const [cursorIndex, setCursorIndex] = useState(0);
  const [showHints, setShowHints] = useState(() => {
    try { return localStorage.getItem("orgcloud-show-hints") !== "false"; } catch { return true; }
  });
  const [whichKeyOpen, setWhichKeyOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { localStorage.setItem("orgcloud-show-hints", String(showHints)); } catch {}
  }, [showHints]);

  useEffect(() => {
    const handler = () => setShowHints(prev => !prev);
    window.addEventListener("toggle-hints", handler);
    return () => window.removeEventListener("toggle-hints", handler);
  }, []);

  const handleToggleStatus = useCallback((h: OrgHeading) => {
    toggleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber });
  }, [toggleMutation]);

  const handleEditTitle = useCallback((h: OrgHeading, newTitle: string) => {
    editTitleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, newTitle });
  }, [editTitleMutation]);

  const handleDelete = useCallback((h: OrgHeading) => {
    deleteMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber });
  }, [deleteMutation]);

  const handleReschedule = useCallback((h: OrgHeading, newDate: string) => {
    rescheduleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, newDate });
  }, [rescheduleMutation]);

  const handleNavigateFile = useCallback((file: string) => {
    if (onNavigateToFile) onNavigateToFile(file);
  }, [onNavigateToFile]);

  const todoCount = allTodos.length;

  const todayCount = useMemo(() => {
    if (!agenda) return 0;
    let count = 0;
    for (const day of agenda.overdue) count += day.items.length;
    count += agenda.today.items.length;
    count += journalEntries.length;
    return count;
  }, [agenda, journalEntries]);

  const weekCount = useMemo(() => {
    if (!agenda) return 0;
    return agenda.today.items.length + agenda.upcoming.reduce((s, d) => s + d.items.length, 0);
  }, [agenda]);

  const doneCount = allDone.length;

  const currentItemCount = useMemo(() => {
    if (tab === "today") return todayCount;
    if (tab === "week") return weekCount;
    if (tab === "todos") return todoCount;
    if (tab === "done") return doneCount;
    return 0;
  }, [tab, todayCount, weekCount, todoCount, doneCount]);

  const isLoading = agendaLoading || todosLoading || doneLoading;

  const tabs: { key: AgendaTabMode; label: string; count: number; hint: string }[] = [
    { key: "today", label: "Today", count: todayCount, hint: "1" },
    { key: "week", label: "Week", count: weekCount, hint: "2" },
    { key: "todos", label: "TODOs", count: todoCount, hint: "3" },
    { key: "done", label: "Done", count: doneCount, hint: "4" },
  ];

  useEffect(() => {
    setCursorIndex(0);
  }, [tab]);

  useEffect(() => {
    const el = scrollRef.current?.querySelector(`[data-cursor-index="${cursorIndex}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [cursorIndex]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
      if (isInput) return;

      if (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setWhichKeyOpen(prev => !prev);
        return;
      }

      if (whichKeyOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setWhichKeyOpen(false);
        }
        return;
      }

      const tabKeys: Record<string, AgendaTabMode> = { "1": "today", "2": "week", "3": "todos", "4": "done" };
      if (tabKeys[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setTab(tabKeys[e.key]);
        return;
      }

      if (e.key === "j" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setCursorIndex(prev => currentItemCount > 0 ? Math.min(prev + 1, currentItemCount - 1) : 0);
        return;
      }
      if (e.key === "k" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setCursorIndex(prev => Math.max(prev - 1, 0));
        return;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [whichKeyOpen, tab, currentItemCount]);

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background relative" data-testid="agenda-view">
      <div className="flex items-center border-b border-border bg-card px-2 py-1 gap-1 overflow-x-auto flex-shrink-0">
        <span className="text-foreground">☰</span>
        <span className="text-foreground font-bold mr-2 phosphor-glow">Agenda</span>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "px-1.5 py-0.5 text-xs transition-colors",
              tab === t.key
                ? "text-foreground font-bold phosphor-glow"
                : "text-muted-foreground hover:text-foreground"
            )}
            data-testid={`tab-${t.key}`}
          >
            {showHints && <span className="text-muted-foreground/40 mr-0.5">{t.hint}</span>}
            {t.label}
            {t.count > 0 && (
              <span className="ml-1 opacity-70">({t.count})</span>
            )}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="w-full p-1 sm:p-2 pb-32">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 phosphor-glow-dim">Loading...</div>
          ) : tab === "today" ? (
            <TodayTab agenda={agenda} onToggle={handleToggleStatus} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} onNavigateFile={handleNavigateFile} cursorIndex={cursorIndex} />
          ) : tab === "week" ? (
            <WeekTab agenda={agenda} onToggle={handleToggleStatus} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} onNavigateFile={handleNavigateFile} cursorIndex={cursorIndex} />
          ) : tab === "todos" ? (
            <FlatItemList items={allTodos} onToggle={handleToggleStatus} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} onNavigateFile={handleNavigateFile} cursorIndex={cursorIndex} />
          ) : (
            <FlatItemList items={allDone} onToggle={handleToggleStatus} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} onNavigateFile={handleNavigateFile} cursorIndex={cursorIndex} />
          )}
        </div>
      </ScrollArea>

      {showHints && !isLoading && (
        <div className="flex items-center justify-center gap-3 px-2 py-0.5 border-t border-border/30 text-muted-foreground/40 text-xs flex-shrink-0">
          <span>j/k navigate</span>
          <span>? help</span>
        </div>
      )}

      {whichKeyOpen && <AgendaWhichKey tab={tab} onClose={() => setWhichKeyOpen(false)} />}
    </div>
  );
}

export default AgendaView;
