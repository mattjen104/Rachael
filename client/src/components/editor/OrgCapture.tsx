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

type Template = "todo" | "note" | "link" | "skill" | "program" | "channel";

const openclawTemplates: Template[] = ["skill", "program", "channel"];
const baseTemplates: Template[] = ["todo", "note", "link"];

export default function OrgCapture({ open, onClose, defaultFile = "dad.org", prefill }: OrgCaptureProps) {
  const [template, setTemplate] = useState<Template>("todo");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [fileName, setFileName] = useState(defaultFile);
  const [scheduledDate, setScheduledDate] = useState(new Date().toISOString().split("T")[0]);
  const [tagsInput, setTagsInput] = useState("");
  const [description, setDescription] = useState("");
  const [metric, setMetric] = useState("");
  const [channelType, setChannelType] = useState("webhook");
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: orgFiles = [] } = useOrgFiles();
  const captureMutation = useOrgCapture();

  const isOpenClaw = fileName === "openclaw.org";
  const visibleTemplates = isOpenClaw ? [...baseTemplates, ...openclawTemplates] : baseTemplates;

  useEffect(() => {
    if (open && inputRef.current) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
    if (open) {
      setTagsInput("");
      setScheduledDate(new Date().toISOString().split("T")[0]);
      setFileName(defaultFile);
      setDescription("");
      setMetric("");
      setChannelType("webhook");

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
    if (!isOpenClaw && openclawTemplates.includes(template)) {
      setTemplate("todo");
    }
  }, [fileName, template, isOpenClaw]);

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

    const extra: Record<string, any> = {};
    if (template === "skill") {
      extra.description = description.trim() || undefined;
    } else if (template === "program") {
      extra.metric = metric.trim() || undefined;
      extra.scheduledDate = scheduledDate;
    } else if (template === "channel") {
      extra.channelType = channelType;
    }

    captureMutation.mutate(
      {
        fileName,
        title: title.trim(),
        template: template as any,
        body: body.trim() || undefined,
        scheduledDate: (template === "todo" || template === "program") ? scheduledDate : undefined,
        tags: tags.length > 0 ? tags : undefined,
        ...extra,
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
            {visibleTemplates.map((t) => {
              const labels: Record<Template, [string, string]> = {
                todo: ["t", "todo"],
                note: ["n", "note"],
                link: ["l", "link"],
                skill: ["s", "skill"],
                program: ["p", "program"],
                channel: ["ch", "channel"],
              };
              const [shortcut, label] = labels[t];
              const isOC = openclawTemplates.includes(t);
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTemplate(t)}
                  className={cn(
                    "px-1.5 py-0.5 text-xs font-mono border transition-colors",
                    template === t
                      ? "border-foreground text-foreground phosphor-glow"
                      : isOC
                      ? "border-border text-foreground/60 hover:text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground"
                  )}
                  data-testid={`capture-template-${t}`}
                >
                  [{shortcut}] {label}
                </button>
              );
            })}
          </div>

          <div>
            <label className="text-muted-foreground uppercase tracking-wider block mb-1">
              {template === "todo" ? "Task" : template === "link" ? "Link Title" : template === "skill" ? "Skill Name" : template === "program" ? "Program Name" : template === "channel" ? "Channel Name" : "Note Title"}
            </label>
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={template === "todo" ? "What needs to be done?" : template === "link" ? "Link description" : template === "skill" ? "e.g. web-search" : template === "program" ? "e.g. autoresearch" : template === "channel" ? "e.g. slack-general" : "Note title"}
              className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors phosphor-glow"
              data-testid="capture-title"
            />
          </div>

          {template === "skill" && (
            <div>
              <label className="text-muted-foreground uppercase tracking-wider block mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this skill do?"
                className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors"
                data-testid="capture-description"
              />
            </div>
          )}

          {template === "program" && (
            <div>
              <label className="text-muted-foreground uppercase tracking-wider block mb-1">Metric</label>
              <input
                type="text"
                value={metric}
                onChange={(e) => setMetric(e.target.value)}
                placeholder="e.g. findings_quality"
                className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors"
                data-testid="capture-metric"
              />
            </div>
          )}

          {template === "channel" && (
            <div>
              <label className="text-muted-foreground uppercase tracking-wider block mb-1">Type</label>
              <select
                value={channelType}
                onChange={(e) => setChannelType(e.target.value)}
                className="w-full bg-background text-foreground p-2 border border-border outline-none focus:border-foreground/50 transition-colors text-xs"
                data-testid="capture-channel-type"
              >
                <option value="webhook">webhook</option>
                <option value="slack">slack</option>
                <option value="email">email</option>
                <option value="discord">discord</option>
                <option value="custom">custom</option>
              </select>
            </div>
          )}

          <div>
            <label className="text-muted-foreground uppercase tracking-wider block mb-1">
              {template === "skill" ? "Instructions" : template === "program" ? "Instructions" : "Body"}
            </label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={template === "skill" ? "Skill instructions and usage..." : template === "program" ? "What should the agent do each iteration?" : "Additional content (optional)"}
              rows={template === "skill" || template === "program" ? 5 : 3}
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
            {(template === "todo" || template === "program") && (
              <div className="flex-1 min-w-[120px]">
                <label className="text-muted-foreground uppercase tracking-wider block mb-1">
                  {template === "program" ? "Start Date" : "Scheduled"}
                </label>
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

          {!openclawTemplates.includes(template) && (
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
          )}

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
