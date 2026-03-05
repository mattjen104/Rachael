import React, { useState, useRef } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOrgAgenda, useOrgTodos, useOrgDone, useToggleOrgStatus, useOrgCapture, useOrgFiles, type OrgHeading, type AgendaDay } from "@/hooks/use-org-data";

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

  const handleToggle = (item: OrgHeading) => {
    toggleMutation.mutate({ fileName: item.sourceFile, lineNumber: item.lineNumber });
  };

  const filters: { key: FilterMode; label: string; count?: number }[] = [
    { key: "today", label: "Today", count: agenda ? (agenda.overdue.reduce((s, d) => s + d.items.length, 0) + agenda.today.items.length) : 0 },
    { key: "week", label: "Week", count: agenda ? agenda.upcoming.reduce((s, d) => s + d.items.length, 0) : 0 },
    { key: "todos", label: "All TODOs", count: allTodos.length },
    { key: "done", label: "Done", count: allDone.length },
  ];

  const isLoading = agendaLoading || todosLoading || doneLoading;

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono text-sm bg-background" data-testid="agenda-view">
      <div className="flex items-center border-b border-border bg-card px-4 py-2 gap-1">
        <span className="text-primary mr-2">[#]</span>
        <span className="text-primary font-bold mr-4 phosphor-glow">Agenda</span>
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            data-testid={`filter-${f.key}`}
            className={cn(
              "px-3 py-1 text-xs transition-colors",
              filter === f.key
                ? "bg-primary/20 text-primary phosphor-glow"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/30"
            )}
          >
            {f.label}
            {f.count !== undefined && f.count > 0 && (
              <span className="ml-1.5 text-[10px] opacity-70">({f.count})</span>
            )}
          </button>
        ))}
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto p-4 pb-32">
          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 phosphor-glow-dim">Loading agenda...</div>
          ) : filter === "today" ? (
            <TodayView agenda={agenda} onToggle={handleToggle} onNavigate={onNavigateToFile} />
          ) : filter === "week" ? (
            <WeekView agenda={agenda} onToggle={handleToggle} onNavigate={onNavigateToFile} />
          ) : filter === "todos" ? (
            <ItemList items={allTodos} onToggle={handleToggle} onNavigate={onNavigateToFile} />
          ) : (
            <ItemList items={allDone} onToggle={handleToggle} onNavigate={onNavigateToFile} />
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
      <div className="flex-1 flex items-center bg-card border border-border overflow-hidden focus-within:border-primary transition-colors crt-border-glow">
        <span className="text-muted-foreground ml-2.5 text-xs flex-shrink-0">+</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Add task to today..."
          className="flex-1 bg-transparent text-foreground text-sm p-2 outline-none phosphor-glow"
          data-testid="quick-add-input"
        />
      </div>
      {value.trim() && (
        <button
          type="submit"
          disabled={captureMutation.isPending}
          className="px-3 py-1.5 bg-primary text-primary-foreground text-xs font-bold hover:brightness-110 transition-all phosphor-glow-bright"
          data-testid="quick-add-submit"
        >
          Add
        </button>
      )}
    </form>
  );
}

function TodayView({ agenda, onToggle, onNavigate }: {
  agenda: ReturnType<typeof useOrgAgenda>["data"];
  onToggle: (item: OrgHeading) => void;
  onNavigate: (file: string) => void;
}) {
  if (!agenda) return null;

  const hasOverdue = agenda.overdue.length > 0;
  const hasTodayItems = agenda.today.items.length > 0;

  return (
    <div className="space-y-6">
      <QuickAdd />

      {hasOverdue && (
        <div>
          <div className="flex items-center gap-2 mb-3 text-destructive phosphor-glow">
            <span>/!\</span>
            <span className="font-bold text-xs uppercase tracking-wider">Carried Over</span>
          </div>
          {agenda.overdue.map((day) => (
            <DaySection key={day.date} day={day} onToggle={onToggle} onNavigate={onNavigate} variant="overdue" />
          ))}
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-primary">[#]</span>
          <span className="font-bold text-primary text-xs uppercase tracking-wider phosphor-glow">
            Today — {new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
          </span>
        </div>
        {hasTodayItems ? (
          <div className="space-y-1">
            {agenda.today.items.map((item, i) => (
              <AgendaItemRow key={`${item.sourceFile}-${item.lineNumber}`} item={item} onToggle={onToggle} onNavigate={onNavigate} />
            ))}
          </div>
        ) : (
          <div className="text-muted-foreground text-xs italic py-4 pl-6 phosphor-glow-dim">
            No items scheduled for today. Type in the box above to add one.
          </div>
        )}
      </div>

      {!hasOverdue && !hasTodayItems && (
        <div className="text-center py-12 text-muted-foreground">
          <div className="text-2xl mb-3 opacity-40">[#]</div>
          <p className="text-sm phosphor-glow-dim">Your agenda is clear.</p>
          <p className="text-xs mt-1 opacity-60">Type in the quick-add box above, or use the Capture modal.</p>
        </div>
      )}
    </div>
  );
}

function WeekView({ agenda, onToggle, onNavigate }: {
  agenda: ReturnType<typeof useOrgAgenda>["data"];
  onToggle: (item: OrgHeading) => void;
  onNavigate: (file: string) => void;
}) {
  if (!agenda) return null;

  return (
    <div className="space-y-4">
      <DaySection day={agenda.today} onToggle={onToggle} onNavigate={onNavigate} variant="today" />
      {agenda.upcoming.map((day) => (
        <DaySection key={day.date} day={day} onToggle={onToggle} onNavigate={onNavigate} variant="upcoming" />
      ))}
      {agenda.upcoming.length === 0 && agenda.today.items.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-xs phosphor-glow-dim">
          No upcoming items scheduled.
        </div>
      )}
    </div>
  );
}

function DaySection({ day, onToggle, onNavigate, variant }: {
  day: AgendaDay;
  onToggle: (item: OrgHeading) => void;
  onNavigate: (file: string) => void;
  variant: "overdue" | "today" | "upcoming";
}) {
  if (day.items.length === 0) return null;

  const borderColor = variant === "overdue" ? "border-destructive/30" : variant === "today" ? "border-primary/30" : "border-border";

  return (
    <div className={cn("border-l-2 pl-4 mb-4", borderColor)}>
      <div className={cn(
        "text-[11px] font-bold uppercase tracking-wider mb-2 phosphor-glow-dim",
        variant === "overdue" ? "text-destructive" : variant === "today" ? "text-primary" : "text-muted-foreground"
      )}>
        {day.label} <span className="opacity-50 ml-1">{day.date}</span>
      </div>
      <div className="space-y-1">
        {day.items.map((item) => (
          <AgendaItemRow key={`${item.sourceFile}-${item.lineNumber}`} item={item} onToggle={onToggle} onNavigate={onNavigate} />
        ))}
      </div>
    </div>
  );
}

function AgendaItemRow({ item, onToggle, onNavigate }: {
  item: OrgHeading;
  onToggle: (item: OrgHeading) => void;
  onNavigate: (file: string) => void;
}) {
  const isDone = item.status === "DONE";

  return (
    <div className="group flex items-start gap-2 py-1.5 px-2 hover:bg-muted/20 transition-colors" data-testid={`agenda-item-${item.lineNumber}`}>
      <button
        onClick={() => onToggle(item)}
        className="mt-0.5 flex-shrink-0 font-mono text-xs"
        data-testid={`toggle-status-${item.lineNumber}`}
      >
        {isDone ? (
          <span className="text-org-done">[x]</span>
        ) : (
          <span className="text-primary">[ ]</span>
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className={cn(
          "text-sm leading-snug",
          isDone ? "text-muted-foreground line-through phosphor-glow-dim" : "text-foreground phosphor-glow"
        )}>
          {item.title}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <button
            onClick={() => onNavigate(item.sourceFile)}
            className="text-[10px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5"
            data-testid={`navigate-${item.sourceFile}`}
          >
            <span>§</span>
            {item.sourceFile}
          </button>
          {item.tags.length > 0 && (
            <div className="flex items-center gap-1">
              {item.tags.map((tag) => (
                <span key={tag} className="text-[10px] text-org-date bg-muted px-1">
                  :{tag}:
                </span>
              ))}
            </div>
          )}
          {item.scheduledDate && (
            <span className="text-[10px] text-muted-foreground">
              {item.scheduledDate}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ItemList({ items, onToggle, onNavigate }: {
  items: OrgHeading[];
  onToggle: (item: OrgHeading) => void;
  onNavigate: (file: string) => void;
}) {
  if (items.length === 0) {
    return <div className="text-center py-8 text-muted-foreground text-xs phosphor-glow-dim">No items found.</div>;
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
          <div className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1 phosphor-glow-dim">
            <span>§</span>
            {file}
          </div>
          <div className="space-y-1 border-l-2 border-border pl-4">
            {fileItems.map((item) => (
              <AgendaItemRow key={`${item.sourceFile}-${item.lineNumber}`} item={item} onToggle={onToggle} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
