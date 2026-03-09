import React, { useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useOrgFiles, useOrgCapture } from "@/hooks/use-org-data";

export interface CaptureContext {
  url?: string;
  title?: string;
  selection?: string;
}

interface OrgCaptureProps {
  open: boolean;
  onClose: () => void;
  defaultFile?: string;
  prefill?: CaptureContext | null;
}

type Template = "todo" | "note" | "link";

export default function OrgCapture({ open, onClose, defaultFile = "dad.org", prefill }: OrgCaptureProps) {
  const [template, setTemplate] = useState<Template>("todo");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState(defaultFile);
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().split("T")[0]);
  const [tagsInput, setTagsInput] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: orgFiles = [] } = useOrgFiles();
  const captureMutation = useOrgCapture();

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    if (open) {
      setTagsInput("");
      setScheduledDate(new Date().toISOString().split("T")[0]);
      setFileName(defaultFile);

      if (prefill) {
        if (prefill.url) {
          setTemplate("link");
          setTitle(prefill.title || prefill.url);
          setBody(prefill.selection ? `${prefill.selection}\n\n${prefill.url}` : prefill.url);
        } else if (prefill.selection) {
          setTemplate("note");
          setTitle(prefill.title || "");
          setBody(prefill.selection);
        } else {
          setTemplate("todo");
          setTitle(prefill.title || "");
          setBody("");
        }
      } else {
        setTemplate("todo");
        setTitle("");
        setBody("");
      }
    }
  }, [open, defaultFile, prefill]);

  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const tags = tagsInput.split(",").map(t => t.trim()).filter(Boolean);

    captureMutation.mutate(
      {
        fileName,
        title: title.trim(),
        template,
        body: body.trim() || undefined,
        scheduledDate: template === "todo" ? scheduledDate : undefined,
        tags: tags.length > 0 ? tags : undefined,
      },
      { onSuccess: () => onClose() }
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh] sm:pt-[20vh] px-1" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-card border border-border shadow-2xl w-full max-w-lg font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <div className="flex items-center gap-2 text-foreground font-bold phosphor-glow">
            <span>[+]</span>
            Org Capture
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors font-mono">
            [×]
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-3 space-y-3">
          <div className="flex flex-wrap items-center gap-1.5 mb-2">
            {(["todo", "note", "link"] as Template[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTemplate(t)}
                className={cn(
                  "px-1.5 py-0.5 text-xs font-mono border transition-colors",
                  template === t
                    ? "border-foreground text-foreground phosphor-glow"
                    : "border-border text-muted-foreground hover:text-foreground"
                )}
                data-testid={`capture-template-${t}`}
              >
                [{t === "todo" ? "t" : t === "note" ? "n" : "l"}] {t}
              </button>
            ))}
          </div>

          <div>
            <label className="text-muted-foreground uppercase tracking-wider block mb-1">
              {template === "todo" ? "Task" : template === "link" ? "Link Title" : "Note Title"}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={template === "todo" ? "What needs to be done?" : template === "link" ? "Link description" : "Note title"}
              className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors phosphor-glow"
              data-testid="capture-title"
            />
          </div>

          <div>
            <label className="text-muted-foreground uppercase tracking-wider block mb-1">Body</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Additional content (optional)"
              rows={3}
              className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors resize-none"
              data-testid="capture-body"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <div className="flex-1 min-w-[120px]">
              <label className="text-muted-foreground uppercase tracking-wider block mb-1">File</label>
              <select
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors text-xs"
                data-testid="capture-file"
              >
                {orgFiles.map((f) => (
                  <option key={f.id} value={f.name}>{f.name}</option>
                ))}
              </select>
            </div>
            {template === "todo" && (
              <div className="flex-1 min-w-[120px]">
                <label className="text-muted-foreground uppercase tracking-wider block mb-1">Scheduled</label>
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors text-xs"
                  data-testid="capture-date"
                />
              </div>
            )}
          </div>

          <div>
            <label className="text-muted-foreground uppercase tracking-wider block mb-1">Tags (comma separated)</label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. work, urgent"
              className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors"
              data-testid="capture-tags"
            />
          </div>

          <div className="flex items-center justify-between pt-2 gap-2">
            <span className="text-muted-foreground text-xs truncate">
              <kbd className="bg-muted px-1 py-0.5">Esc</kbd> cancel
            </span>
            <button
              type="submit"
              disabled={!title.trim() || captureMutation.isPending}
              className={cn(
                "px-3 py-1 font-bold transition-colors flex-shrink-0",
                title.trim()
                  ? "bg-foreground text-background hover:brightness-110 phosphor-glow-bright"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
              data-testid="capture-submit"
            >
              {captureMutation.isPending ? "Saving..." : "Capture"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
