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
  type OutlineHeading,
  type OrgHeading,
  type AgendaDay,
} from "@/hooks/use-org-data";
import { useQuery } from "@tanstack/react-query";

type TabMode = "outline" | "today" | "week" | "todos" | "done";

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
  dragItem: React.MutableRefObject<OutlineHeading | null>;
  onDrop: (target: OutlineHeading, position: "before" | "after" | "child") => void;
  onReorderBody: (heading: OutlineHeading, fromIndex: number, toIndex: number) => void;
  backlinksMap: Map<string, BacklinkRef[]>;
  isCursored?: boolean;
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
  dragItem,
  onDrop,
  onReorderBody,
  backlinksMap,
  isCursored,
}: OutlineItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(heading.title);
  const [dropZone, setDropZone] = useState<"before" | "after" | "child" | null>(null);
  const [bodyDropTarget, setBodyDropTarget] = useState<number | null>(null);
  const [bodyDragSource, setBodyDragSource] = useState<number | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
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

          {directChildren.map((child) => (
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
              dragItem={dragItem}
              onDrop={onDrop}
              onReorderBody={onReorderBody}
              backlinksMap={backlinksMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function QuickAdd() {
  const [value, setValue] = useState("");
  const captureMutation = useOrgCapture();
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: orgFiles = [] } = useOrgFiles();
  const defaultFile = orgFiles.find(f => f.name === "dad.org")?.name || orgFiles[0]?.name;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim() || !defaultFile) return;
    const today = new Date().toISOString().split("T")[0];
    captureMutation.mutate(
      { fileName: defaultFile, title: value.trim(), scheduledDate: today },
      { onSuccess: () => setValue("") }
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 mb-4">
      <div className="flex-1 flex items-center bg-card border border-border overflow-hidden focus-within:border-foreground transition-colors">
        <span className="text-muted-foreground ml-2.5 flex-shrink-0">+</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add task to today..."
          className="flex-1 bg-transparent text-foreground p-2 outline-none phosphor-glow"
          data-testid="quick-add-input"
        />
      </div>
      {value.trim() && (
        <button
          type="submit"
          disabled={captureMutation.isPending}
          className="px-3 py-1 bg-foreground text-background font-bold hover:brightness-110 transition-all"
          data-testid="quick-add-submit"
        >
          Add
        </button>
      )}
    </form>
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

function TodayTab({ agenda, onToggle, onReschedule, onEditTitle, onDelete, onNavigateFile, cursorIndex }: {
  agenda: { overdue: AgendaDay[]; today: AgendaDay; upcoming: AgendaDay[] } | undefined;
  onToggle: (item: OrgHeading) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
  onNavigateFile: (file: string) => void;
  cursorIndex: number;
}) {
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
  const allItems = [...overdueItems, ...todayItems];

  return (
    <div className="space-y-4">
      <QuickAdd />
      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="font-bold text-foreground uppercase tracking-wider phosphor-glow">
            Today — {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </span>
        </div>
        {allItems.length > 0 ? (
          <div className="space-y-1">
            {allItems.map((item, i) => (
              <div key={`${item.sourceFile}-${item.lineNumber}`} data-cursor-index={i}>
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
        ) : (
          <div className="text-muted-foreground italic py-4 pl-6 phosphor-glow-dim">
            No items scheduled for today. Type in the box above to add one.
          </div>
        )}
      </div>
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

function WhichKeyOverlay({ tab, onClose }: { tab: TabMode; onClose: () => void }) {
  const globalBindings = [
    ["1-5", "Switch tabs"],
    ["SPC", "Command palette"],
    ["Alt+C", "Org capture"],
    ["?", "Toggle this help"],
  ];

  const outlineBindings = [
    ["j / k", "Navigate items"],
    ["[ / ]", "Prev / next buffer"],
  ];

  const agendaBindings = [
    ["j / k", "Navigate items"],
  ];

  const bindings = tab === "outline" ? outlineBindings : agendaBindings;

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
          Keybindings — {tab === "outline" ? "Outline" : tab.charAt(0).toUpperCase() + tab.slice(1)}
        </div>
        <div className="grid grid-cols-2 gap-x-8 gap-y-0">
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">Global</div>
            {globalBindings.map(([key, desc]) => (
              <div key={key} className="flex items-center gap-2 py-0.5 text-xs">
                <span className="text-foreground font-bold w-16 phosphor-glow">{key}</span>
                <span className="text-muted-foreground">{desc}</span>
              </div>
            ))}
          </div>
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wider mb-1">
              {tab === "outline" ? "Outline" : "Agenda"}
            </div>
            {bindings.map(([key, desc]) => (
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

export default function OrgView() {
  const { data: headings = [], isLoading: headingsLoading } = useAllHeadings();
  const { data: orgFiles = [] } = useOrgFiles();
  const { data: backlinksData = [] } = useBacklinks();
  const { data: agenda, isLoading: agendaLoading } = useOrgAgenda();
  const { data: allTodos = [], isLoading: todosLoading } = useOrgTodos();
  const { data: allDone = [], isLoading: doneLoading } = useOrgDone();

  const toggleMutation = useToggleOrgStatus();
  const editTitleMutation = useEditHeadingTitle();
  const deleteMutation = useDeleteHeading();
  const moveMutation = useMoveHeading();
  const reorderBodyMutation = useReorderBodyLine();
  const rescheduleMutation = useRescheduleHeading();

  const [tab, setTab] = useState<TabMode>("outline");
  const [selectedFile, setSelectedFile] = useState<string>("");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [cursorIndex, setCursorIndex] = useState(0);
  const [showHints, setShowHints] = useState(() => {
    try { return localStorage.getItem("orgcloud-show-hints") !== "false"; } catch { return true; }
  });
  const [whichKeyOpen, setWhichKeyOpen] = useState(false);
  const dragItem = useRef<OutlineHeading | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const handleToggleStatus = useCallback((h: OutlineHeading | OrgHeading) => {
    toggleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber });
  }, [toggleMutation]);

  const handleEditTitle = useCallback((h: OutlineHeading | OrgHeading, newTitle: string) => {
    editTitleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, newTitle });
  }, [editTitleMutation]);

  const handleDelete = useCallback((h: OutlineHeading | OrgHeading) => {
    deleteMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber });
  }, [deleteMutation]);

  const handleReschedule = useCallback((h: OrgHeading, newDate: string) => {
    rescheduleMutation.mutate({ fileName: h.sourceFile, lineNumber: h.lineNumber, newDate });
  }, [rescheduleMutation]);

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

  const handleNavigateFile = useCallback((file: string) => {
    setSelectedFile(file);
    setTab("outline");
    setCursorIndex(0);
  }, []);

  const filteredTopLevel = useMemo(() => {
    return headings.filter(h => h.level === 1 && h.sourceFile === selectedFile);
  }, [headings, selectedFile]);

  const filteredHeadings = useMemo(() => {
    return headings.filter(h => h.sourceFile === selectedFile);
  }, [headings, selectedFile]);

  const todoCount = allTodos.length;

  const todayCount = useMemo(() => {
    if (!agenda) return 0;
    let count = 0;
    for (const day of agenda.overdue) count += day.items.length;
    count += agenda.today.items.length;
    return count;
  }, [agenda]);

  const weekCount = useMemo(() => {
    if (!agenda) return 0;
    return agenda.today.items.length + agenda.upcoming.reduce((s, d) => s + d.items.length, 0);
  }, [agenda]);

  const doneCount = allDone.length;

  const fileTitle = useMemo(() => {
    const file = orgFiles.find(f => f.name === selectedFile);
    if (!file) return selectedFile;
    const match = file.content.match(/^#\+TITLE:\s*(.+)$/m);
    return match ? match[1].trim() : selectedFile.replace(".org", "");
  }, [orgFiles, selectedFile]);

  const currentItemCount = useMemo(() => {
    if (tab === "outline") return filteredTopLevel.length;
    if (tab === "today") return todayCount;
    if (tab === "week") return weekCount;
    if (tab === "todos") return todoCount;
    if (tab === "done") return doneCount;
    return 0;
  }, [tab, filteredTopLevel.length, todayCount, weekCount, todoCount, doneCount]);

  const isLoading = headingsLoading || agendaLoading || todosLoading || doneLoading;

  const tabs: { key: TabMode; label: string; count: number; hint: string }[] = [
    { key: "outline", label: "Outline", count: 0, hint: "1" },
    { key: "today", label: "Today", count: todayCount, hint: "2" },
    { key: "week", label: "Week", count: weekCount, hint: "3" },
    { key: "todos", label: "TODOs", count: todoCount, hint: "4" },
    { key: "done", label: "Done", count: doneCount, hint: "5" },
  ];

  useEffect(() => {
    setCursorIndex(0);
  }, [tab, selectedFile]);

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

      const tabKeys: Record<string, TabMode> = { "1": "outline", "2": "today", "3": "week", "4": "todos", "5": "done" };
      if (tabKeys[e.key] && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setTab(tabKeys[e.key]);
        return;
      }

      if (e.key === "[" && !e.ctrlKey && !e.metaKey && !e.altKey && tab === "outline") {
        e.preventDefault();
        const idx = orgFiles.findIndex(f => f.name === selectedFile);
        if (idx > 0) setSelectedFile(orgFiles[idx - 1].name);
        else if (orgFiles.length > 0) setSelectedFile(orgFiles[orgFiles.length - 1].name);
        return;
      }
      if (e.key === "]" && !e.ctrlKey && !e.metaKey && !e.altKey && tab === "outline") {
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
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [whichKeyOpen, tab, selectedFile, orgFiles, currentItemCount]);

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background relative" data-testid="org-view">
      <div className="flex items-center border-b border-border bg-card px-2 py-1 gap-1 overflow-x-auto flex-shrink-0">
        <span className="text-foreground">{"{*}"}</span>
        <span className="text-foreground font-bold mr-2 phosphor-glow">Org</span>
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

      {tab === "outline" && (
        <BufferTabBar orgFiles={orgFiles} selectedFile={selectedFile} onSelect={(f) => { setSelectedFile(f); setCursorIndex(0); }} showHints={showHints} />
      )}

      <ScrollArea className="flex-1">
        <div ref={scrollRef} className="w-full p-1 sm:p-2 pb-32">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 phosphor-glow-dim">Loading...</div>
          ) : tab === "outline" ? (
            <>
              {selectedFile && (
                <div className="px-1 py-2 mb-2 border-b border-border/30">
                  <span className="text-foreground font-bold phosphor-glow text-sm">{fileTitle}</span>
                  <span className="text-muted-foreground text-xs ml-2">{selectedFile}</span>
                </div>
              )}
              {filteredTopLevel.length === 0 ? (
                <div className="text-muted-foreground text-xs px-1 py-8 italic text-center">
                  Empty document. Use Alt+C to capture items.
                </div>
              ) : (
                filteredTopLevel.map((h, i) => (
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
                      dragItem={dragItem}
                      onDrop={handleDrop}
                      onReorderBody={handleReorderBody}
                      backlinksMap={backlinksMap}
                      isCursored={cursorIndex === i}
                    />
                  </div>
                ))
              )}
            </>
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
          <span>Enter open</span>
          {tab === "outline" && <span>[ ] buffers</span>}
          <span>? help</span>
        </div>
      )}

      {whichKeyOpen && <WhichKeyOverlay tab={tab} onClose={() => setWhichKeyOpen(false)} />}
    </div>
  );
}
