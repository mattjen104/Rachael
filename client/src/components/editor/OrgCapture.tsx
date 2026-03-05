import React, { useState, useEffect, useRef } from "react";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useOrgFiles, useOrgCapture } from "@/hooks/use-org-data";

interface OrgCaptureProps {
  open: boolean;
  onClose: () => void;
  defaultFile?: string;
}

export default function OrgCapture({ open, onClose, defaultFile = "dad.org" }: OrgCaptureProps) {
  const [title, setTitle] = useState("");
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
      setTitle("");
      setTagsInput("");
      setScheduledDate(new Date().toISOString().split("T")[0]);
      setFileName(defaultFile);
    }
  }, [open, defaultFile]);

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
      { fileName, title: title.trim(), scheduledDate, tags: tags.length > 0 ? tags : undefined },
      { onSuccess: () => onClose() }
    );
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[20vh]" onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div
        className="relative bg-[#21242b] border border-border rounded-md shadow-2xl w-full max-w-lg font-mono"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-2 border-b border-border">
          <div className="flex items-center gap-2 text-org-todo font-bold text-sm">
            <Plus className="w-4 h-4" />
            Org Capture
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-4 space-y-3">
          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Task</label>
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs to be done?"
              className="w-full bg-[#282c34] text-foreground text-sm p-2.5 rounded-sm border border-border outline-none focus:border-org-todo transition-colors"
              data-testid="capture-title"
            />
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">File</label>
              <select
                value={fileName}
                onChange={(e) => setFileName(e.target.value)}
                className="w-full bg-[#282c34] text-foreground text-sm p-2.5 rounded-sm border border-border outline-none focus:border-primary transition-colors"
                data-testid="capture-file"
              >
                {orgFiles.map((f) => (
                  <option key={f.id} value={f.name}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Scheduled</label>
              <input
                type="date"
                value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                className="w-full bg-[#282c34] text-foreground text-sm p-2.5 rounded-sm border border-border outline-none focus:border-primary transition-colors"
                data-testid="capture-date"
              />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Tags (comma separated)</label>
            <input
              type="text"
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="e.g. work, urgent"
              className="w-full bg-[#282c34] text-foreground text-sm p-2.5 rounded-sm border border-border outline-none focus:border-primary transition-colors"
              data-testid="capture-tags"
            />
          </div>

          <div className="flex items-center justify-between pt-2">
            <span className="text-[10px] text-muted-foreground">
              Press <kbd className="bg-muted px-1 py-0.5 rounded text-[9px] mx-0.5">Esc</kbd> to cancel
            </span>
            <button
              type="submit"
              disabled={!title.trim() || captureMutation.isPending}
              className={cn(
                "px-4 py-1.5 rounded-sm text-sm font-bold transition-colors",
                title.trim()
                  ? "bg-org-todo text-[#282c34] hover:brightness-110"
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
