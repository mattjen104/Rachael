import React, { useState, useRef, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOrgAgenda, useOrgTodos, useOrgDone, useToggleOrgStatus, useOrgCapture, useOrgFiles, useRescheduleHeading, useEditHeadingTitle, useDeleteHeading, type OrgHeading, type AgendaDay } from "@/hooks/use-org-data";

type FilterMode = "today" | "week" | "todos" | "done";

interface AgendaViewProps {
  onNavigateToFile: (fileName: string) => void;
}

export default function AgendaView({ onNavigateToFile }: AgendaViewProps) {
  const [filter, setFilter] = useState<FilterMode>("today");
  const { data: agenda, isLoading: agendaLoading } = useOrgAgenda();
  const { data: allTodos = [], isLoading: todosLoading } = useOrgTodos();
  const { data: allDone = [], isLoading: doneLoading } = useOrgDone();
  const toggleMutation = useToggleOrgStatus();
  const rescheduleMutation = useRescheduleHeading();
  const editTitleMutation = useEditHeadingTitle();
  const deleteMutation = useDeleteHeading();

  const handleToggle = (item: OrgHeading) => {
    toggleMutation.mutate({ fileName: item.sourceFile, lineNumber: item.lineNumber });
  };

  const handleReschedule = (item: OrgHeading, newDate: string) => {
    rescheduleMutation.mutate({ fileName: item.sourceFile, lineNumber: item.lineNumber, newDate });
  };

  const handleEditTitle = (item: OrgHeading, newTitle: string) => {
    editTitleMutation.mutate({ fileName: item.sourceFile, lineNumber: item.lineNumber, newTitle });
  };

  const handleDelete = (item: OrgHeading) => {
    deleteMutation.mutate({ fileName: item.sourceFile, lineNumber: item.lineNumber });
  };

  const filters: { key: FilterMode; label: string; count?: number }[] = [
    { key: "today", label: "Today", count: agenda ? (agenda.overdue.reduce((s, d) => s + d.items.length, 0) + agenda.today.items.length) : 0 },
    { key: "week", label: "Week", count: agenda ? agenda.upcoming.reduce((s, d) => s + d.items.length, 0) : 0 },
    { key: "todos", label: "All TODOs", count: allTodos.length },
    { key: "done", label: "Done", count: allDone.length },
  ];

  const isLoading = agendaLoading || todosLoading || doneLoading;

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono bg-background" data-testid="agenda-view">
      <div className="flex items-center border-b border-border bg-card px-2 py-1 gap-1 overflow-x-auto">
        <span className="text-foreground mr-2">[#]</span>
        <span className="text-foreground font-bold mr-4 phosphor-glow">Agenda</span>
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`filter-${f.key}`}
            className={cn(
              "px-3 py-1 transition-colors",
              filter === f.key
                ? "text-foreground phosphor-glow font-bold"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {f.label}
            {f.count !== undefined && f.count > 0 && (
              <span className="ml-1 opacity-70">({f.count})</span>
            )}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div className="w-full p-2 sm:p-4 pb-32">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 phosphor-glow-dim">Loading agenda...</div>
          ) : filter === "today" ? (
            <TodayView agenda={agenda} onToggle={handleToggle} onNavigate={onNavigateToFile} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} />
          ) : filter === "week" ? (
            <WeekView agenda={agenda} onToggle={handleToggle} onNavigate={onNavigateToFile} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} />
          ) : filter === "todos" ? (
            <ItemList items={allTodos} onToggle={handleToggle} onNavigate={onNavigateToFile} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} />
          ) : (
            <ItemList items={allDone} onToggle={handleToggle} onNavigate={onNavigateToFile} onReschedule={handleReschedule} onEditTitle={handleEditTitle} onDelete={handleDelete} />
          )}
        </div>
      </ScrollArea>
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

interface AgendaActions {
  onToggle: (item: OrgHeading) => void;
  onNavigate: (file: string) => void;
  onReschedule: (item: OrgHeading, newDate: string) => void;
  onEditTitle: (item: OrgHeading, newTitle: string) => void;
  onDelete: (item: OrgHeading) => void;
}

function daysOverdue(scheduledDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const scheduled = new Date(scheduledDate + "T00:00:00");
  const diff = Math.floor((today.getTime() - scheduled.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(0, diff);
}

function TodayView({ agenda, ...actions }: { agenda: ReturnType<typeof useOrgAgenda>["data"] } & AgendaActions) {
  if (!agenda) return null;

  const overdueItems: (OrgHeading & { _overdueDays: number })[] = [];
  for (const day of agenda.overdue) {
    for (const item of day.items) {
      const days = item.scheduledDate ? daysOverdue(item.scheduledDate) : 1;
      overdueItems.push({ ...item, _overdueDays: days });
    }
  }
  overdueItems.sort((a, b) => b._overdueDays - a._overdueDays);

  const todayItems = agenda.today.items.map(item => ({ ...item, _overdueDays: 0 }));
  const allItems = [...overdueItems, ...todayItems];

  return (
    <div className="space-y-4">
      <QuickAdd />

      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-foreground">[#]</span>
          <span className="font-bold text-foreground uppercase tracking-wider phosphor-glow">
            Today — {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </span>
        </div>
        {allItems.length > 0 ? (
          <div className="space-y-1">
            {allItems.map((item) => (
              <AgendaItemRow
                key={`${item.sourceFile}-${item.lineNumber}`}
                item={item}
                overdueDays={item._overdueDays}
                {...actions}
              />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground italic py-4 pl-6 phosphor-glow-dim">
            No items scheduled for today. Type in the box above to add one.
          </div>
        )}
      </div>

      {allItems.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <div className="mb-3 opacity-40">[#]</div>
          <p className="phosphor-glow-dim">Your agenda is clear.</p>
          <p className="mt-1 opacity-60">Type in the quick-add box above, or use the Capture modal.</p>
        </div>
      )}
    </div>
  );
}

function WeekView({ agenda, ...actions }: { agenda: ReturnType<typeof useOrgAgenda>["data"] } & AgendaActions) {
  if (!agenda) return null;

  return (
    <div className="space-y-4">
      <DaySection day={agenda.today} {...actions} variant="today" />
      {agenda.upcoming.map((day) => (
        <DaySection key={day.date} day={day} {...actions} variant="upcoming" />
      ))}
      {agenda.upcoming.length === 0 && agenda.today.items.length === 0 && (
        <div className="text-center py-8 text-muted-foreground phosphor-glow-dim">
          No upcoming items scheduled.
        </div>
      )}
    </div>
  );
}

function DaySection({ day, variant, ...actions }: { day: AgendaDay; variant: "overdue" | "today" | "upcoming" } & AgendaActions) {
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
        {day.items.map((item) => (
          <AgendaItemRow key={`${item.sourceFile}-${item.lineNumber}`} item={item} overdueDays={0} {...actions} />
        ))}
      </div>
    </div>
  );
}

function AgendaItemRow({ item, overdueDays, onToggle, onNavigate, onReschedule, onEditTitle, onDelete }: {
  item: OrgHeading;
  overdueDays: number;
} & AgendaActions) {
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
    <div className="group flex items-start gap-2 py-1 px-2 hover:bg-muted/20 transition-colors" data-testid={`agenda-item-${item.lineNumber}`}>
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
              [×]
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5 text-muted-foreground text-xs">
            <button
              onClick={() => onNavigate(item.sourceFile)}
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

function ItemList({ items, ...actions }: { items: OrgHeading[] } & AgendaActions) {
  if (items.length === 0) {
    return <div className="text-center py-8 text-muted-foreground phosphor-glow-dim">No items found.</div>;
  }

  const byFile = new Map<string, OrgHeading[]>();
  for (const item of items) {
    if (!byFile.has(item.sourceFile)) byFile.set(item.sourceFile, []);
    byFile.get(item.sourceFile)!.push(item);
  }

  return (
    <div className="space-y-4">
      {Array.from(byFile.entries()).map(([file, fileItems]) => (
        <div key={file}>
          <div className="font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1 phosphor-glow-dim">
            <span>§</span>
            {file}
          </div>
          <div className="space-y-1 border-l-2 border-border pl-4">
            {fileItems.map((item) => (
              <AgendaItemRow key={`${item.sourceFile}-${item.lineNumber}`} item={item} overdueDays={0} {...actions} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
