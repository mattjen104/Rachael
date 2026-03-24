import React, { useState, useEffect, useRef, useCallback } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Task, Note } from "@shared/schema";

interface InlineEditorProps {
  item: { type: "task"; data: Task } | { type: "note"; data: Note };
  onClose: () => void;
}

interface Backlink {
  type: string;
  id: number;
  title: string;
}

export default function InlineEditor({ item, onClose }: InlineEditorProps) {
  const isTask = item.type === "task";
  const data = item.data;

  const [title, setTitle] = useState(data.title);
  const [body, setBody] = useState(data.body || "");
  const [tags, setTags] = useState((data.tags || []).join(", "));
  const [priority, setPriority] = useState(isTask ? ((data as Task).priority || "") : "");
  const [scheduledDate, setScheduledDate] = useState(isTask ? ((data as Task).scheduledDate || "") : "");
  const [deadlineDate, setDeadlineDate] = useState(isTask ? ((data as Task).deadlineDate || "") : "");
  const [repeat, setRepeat] = useState(isTask ? ((data as Task).repeat || "") : "");
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  useEffect(() => {
    apiRequest("GET", `/api/backlinks/${item.type}/${data.id}`)
      .then(res => res.json())
      .then(setBacklinks)
      .catch(() => {});
  }, [item.type, data.id]);

  const save = useCallback(async () => {
    setSaving(true);
    const parsedTags = tags.split(",").map(t => t.trim()).filter(Boolean);
    try {
      if (isTask) {
        await apiRequest("PATCH", `/api/tasks/${data.id}`, {
          title,
          body,
          tags: parsedTags,
          priority: priority || null,
          scheduledDate: scheduledDate || null,
          deadlineDate: deadlineDate || null,
          repeat: repeat || null,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
      } else {
        await apiRequest("PATCH", `/api/notes/${data.id}`, {
          title,
          body,
          tags: parsedTags,
        });
        queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
      }
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    } catch (e) {
      console.error("Save failed:", e);
    } finally {
      setSaving(false);
    }
  }, [title, body, tags, priority, scheduledDate, deadlineDate, repeat, data.id, isTask]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      save().then(onClose);
    }
    if (e.key === "s" && e.ctrlKey) {
      e.preventDefault();
      save();
    }
  }, [save, onClose]);

  const imageUrl = data.imageUrl;

  const handleBlur = useCallback((e: React.FocusEvent<HTMLDivElement>) => {
    const relatedTarget = e.relatedTarget as HTMLElement | null;
    if (relatedTarget && e.currentTarget.contains(relatedTarget)) return;
    save().then(onClose);
  }, [save, onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[10%]"
      onClick={(e) => { if (e.target === e.currentTarget) { save().then(onClose); } }}
      data-testid="inline-editor"
    >
      <div className="w-full max-w-[420px] bg-background border border-border rounded shadow-lg font-mono text-xs p-3 space-y-2" onKeyDown={handleKeyDown} onBlur={handleBlur}>
        <div className="flex items-center justify-between border-b border-border pb-1">
          <span className="text-muted-foreground">{isTask ? "EDIT TASK" : "EDIT NOTE"} #{data.id}</span>
          <span className="text-muted-foreground text-[10px]">{saving ? "saving..." : "Ctrl+S save · Esc close"}</span>
        </div>

        <div>
          <label className="text-muted-foreground text-[10px]">Title</label>
          <input
            ref={titleRef}
            data-testid="editor-title"
            className="w-full bg-transparent border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary"
            value={title}
            onChange={e => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label className="text-muted-foreground text-[10px]">Body (markdown)</label>
          <textarea
            data-testid="editor-body"
            className="w-full bg-transparent border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary min-h-[80px] resize-y"
            value={body}
            onChange={e => setBody(e.target.value)}
          />
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label className="text-muted-foreground text-[10px]">Tags (comma separated)</label>
            <input
              data-testid="editor-tags"
              className="w-full bg-transparent border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary"
              value={tags}
              onChange={e => setTags(e.target.value)}
            />
          </div>
          {isTask && (
            <div className="w-16">
              <label className="text-muted-foreground text-[10px]">Priority</label>
              <select
                data-testid="editor-priority"
                className="w-full bg-background border border-border rounded px-1 py-1 text-foreground outline-none"
                value={priority}
                onChange={e => setPriority(e.target.value)}
              >
                <option value="">—</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            </div>
          )}
        </div>

        {isTask && (
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-muted-foreground text-[10px]">Scheduled</label>
              <input
                data-testid="editor-scheduled"
                type="date"
                className="w-full bg-transparent border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary"
                value={scheduledDate}
                onChange={e => setScheduledDate(e.target.value)}
              />
            </div>
            <div className="flex-1">
              <label className="text-muted-foreground text-[10px]">Deadline</label>
              <input
                data-testid="editor-deadline"
                type="date"
                className="w-full bg-transparent border border-border rounded px-2 py-1 text-foreground outline-none focus:border-primary"
                value={deadlineDate}
                onChange={e => setDeadlineDate(e.target.value)}
              />
            </div>
            <div className="w-20">
              <label className="text-muted-foreground text-[10px]">Repeat</label>
              <select
                data-testid="editor-repeat"
                className="w-full bg-background border border-border rounded px-1 py-1 text-foreground outline-none"
                value={repeat}
                onChange={e => setRepeat(e.target.value)}
              >
                <option value="">—</option>
                <option value="+1d">Daily</option>
                <option value="+1w">Weekly</option>
                <option value="+1m">Monthly</option>
              </select>
            </div>
          </div>
        )}

        {imageUrl && (
          <div>
            <label className="text-muted-foreground text-[10px]">Attached Image</label>
            <img
              src={imageUrl}
              alt="attachment"
              className="max-h-32 rounded border border-border mt-1"
              data-testid="editor-image"
            />
          </div>
        )}

        {backlinks.length > 0 && (
          <div className="border-t border-border pt-1">
            <label className="text-muted-foreground text-[10px]">Referenced by</label>
            {backlinks.map(bl => (
              <div key={`${bl.type}-${bl.id}`} className="text-foreground pl-2" data-testid={`backlink-${bl.type}-${bl.id}`}>
                <span className="text-muted-foreground">[{bl.type}]</span> {bl.title}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
