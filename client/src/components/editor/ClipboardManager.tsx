import React, { useState, useRef, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  useClipboardItems,
  useDeleteClipboardItem,
  useAddClipboardItem,
  useUpdateClipboardItem,
  useSmartCapture,
  useEnrichClipboard,
  useHeadingsSearch,
} from "@/hooks/use-org-data";
import { queryClient } from "@/lib/queryClient";

interface ClipboardManagerProps {
  activeOrgFile: string;
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

function getTypeLabel(type: string): string {
  switch (type) {
    case "url": return "~>";
    case "gif": case "image": return "▦";
    case "code": return "{}";
    default: return "Aa";
  }
}

interface BacklinkDropdownProps {
  query: string;
  onSelect: (link: string) => void;
  onClose: () => void;
  visible: boolean;
  selectedIdx: number;
  onSelectedIdxChange: (idx: number) => void;
}

function BacklinkDropdown({ query, onSelect, onClose, visible, selectedIdx, onSelectedIdxChange }: BacklinkDropdownProps) {
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
    <div ref={dropdownRef} className="absolute left-0 right-0 top-full mt-1 bg-card border border-border shadow-xl z-50 max-h-40 overflow-y-auto crt-border-glow" data-testid="backlink-dropdown">
      {headings.map((h, i) => (
        <button
          key={`${h.sourceFile}-${h.lineNumber}`}
          className={cn(
            "w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors",
            i === selectedIdx ? "bg-primary/20 text-primary phosphor-glow" : "text-foreground hover:bg-muted"
          )}
          onClick={() => onSelect(`[[file:${h.sourceFile}::*${h.title}]]`)}
          onMouseEnter={() => onSelectedIdxChange(i)}
          data-testid={`backlink-option-${i}`}
        >
          <span className="text-muted-foreground text-[9px]">{"*".repeat(h.level)}</span>
          <span className="flex-1 truncate">{h.title}</span>
          <span className="text-[9px] text-muted-foreground">{h.sourceFile}</span>
        </button>
      ))}
    </div>
  );
}

function useBacklinkHeadingsCount(query: string) {
  const { data: headings = [] } = useHeadingsSearch(query);
  return headings;
}

interface SmartInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  testId?: string;
}

function SmartInput({ value, onChange, onSubmit, onCancel, placeholder, className, autoFocus, testId }: SmartInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [backlinkQuery, setBacklinkQuery] = useState("");
  const [showBacklinks, setShowBacklinks] = useState(false);
  const [backlinkStart, setBacklinkStart] = useState(-1);
  const [dropdownIdx, setDropdownIdx] = useState(0);
  const headings = useBacklinkHeadingsCount(backlinkQuery);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(value.length, value.length);
    }
  }, [autoFocus]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newVal = e.target.value;
    onChange(newVal);

    const cursorPos = e.target.selectionStart || 0;
    const before = newVal.slice(0, cursorPos);
    const bracketIdx = before.lastIndexOf("[[");

    if (bracketIdx !== -1 && !before.slice(bracketIdx).includes("]]")) {
      const query = before.slice(bracketIdx + 2);
      setBacklinkQuery(query);
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
    const afterBracket = value.slice(cursorPos);
    const cleaned = afterBracket.replace(/^\]*/, "");
    const newVal = before + link + (cleaned ? " " + cleaned : "");
    onChange(newVal);
    setShowBacklinks(false);
    setBacklinkQuery("");
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (showBacklinks && headings.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setDropdownIdx(i => Math.min(i + 1, headings.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setDropdownIdx(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const h = headings[dropdownIdx];
        if (h) handleBacklinkSelect(`[[file:${h.sourceFile}::*${h.title}]]`);
        return;
      }
    }
    if (e.key === "Enter") { e.preventDefault(); onSubmit(); }
    if (e.key === "Escape") {
      if (showBacklinks) { setShowBacklinks(false); }
      else if (onCancel) { onCancel(); }
    }
  };

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
        data-testid={testId}
      />
      <BacklinkDropdown
        query={backlinkQuery}
        onSelect={handleBacklinkSelect}
        onClose={() => setShowBacklinks(false)}
        visible={showBacklinks}
        selectedIdx={dropdownIdx}
        onSelectedIdxChange={setDropdownIdx}
      />
    </div>
  );
}

interface EditableItemProps {
  item: {
    id: number;
    content: string;
    type: string;
    capturedAt: string | Date;
    detectedType?: string | null;
    urlTitle?: string | null;
    urlDescription?: string | null;
    urlImage?: string | null;
    urlDomain?: string | null;
  };
  activeOrgFile: string;
  onDelete: (id: number) => void;
}

function EditableItem({ item, activeOrgFile, onDelete }: EditableItemProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.content);
  const [showSuccess, setShowSuccess] = useState(false);
  const updateMutation = useUpdateClipboardItem();
  const smartCaptureMutation = useSmartCapture();
  const { toast } = useToast();

  const syntax = parseCaptureSyntax(editValue);
  const displayType = item.detectedType || item.type;

  const handleStartEdit = () => {
    setEditValue(item.content);
    setEditing(true);
  };

  const handleCancel = () => {
    setEditValue(item.content);
    setEditing(false);
  };

  const handleSubmit = () => {
    if (!editValue.trim()) return;
    const parsed = parseCaptureSyntax(editValue);

    if (parsed.hasTask || parsed.nestingLevel > 0) {
      smartCaptureMutation.mutate(
        {
          content: editValue.trim(),
          orgFileName: activeOrgFile,
          clipboardId: item.id,
          originalContent: item.content !== editValue.trim() ? item.content : undefined,
        },
        {
          onSuccess: (data) => {
            setEditing(false);
            setShowSuccess(true);
            const label = parsed.hasTask ? "Task" : "Note";
            toast({
              title: `${label} captured`,
              description: `Added to ${activeOrgFile}${data.parsed?.scheduledDate ? ` — ${data.parsed.scheduledDate}` : ""}`,
              className: "bg-card border-secondary text-foreground",
            });
            setTimeout(() => setShowSuccess(false), 1500);
          },
          onError: () => {
            setEditing(false);
            toast({
              title: "Capture failed",
              description: "Could not process the entry.",
              className: "bg-card border-destructive text-foreground",
            });
          },
        }
      );
    } else {
      updateMutation.mutate(
        { id: item.id, content: editValue.trim() },
        { onSuccess: () => setEditing(false) }
      );
    }
  };

  if (showSuccess) {
    return (
      <div className="flex items-center gap-2 bg-secondary/10 border border-secondary/30 p-2.5 text-secondary text-xs animate-in fade-in phosphor-glow">
        <span>[✓]</span>
        Captured to {activeOrgFile}
      </div>
    );
  }

  const formatTime = (date: string | Date) => {
    return new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <div
      className={cn(
        "group flex flex-col border transition-colors",
        editing
          ? "bg-muted border-primary/50"
          : "bg-background border-border hover:border-secondary/50"
      )}
      data-testid={`clipboard-item-${item.id}`}
    >
      <div className="flex justify-between items-center px-2 pt-1.5 pb-0.5">
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase text-muted-foreground bg-muted/30">
            <span>{getTypeLabel(displayType)}</span>
            {displayType}
          </span>
          {syntax.label && (
            <span className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-bold uppercase",
              syntax.hasTask ? "text-primary bg-primary/15 phosphor-glow" : "text-muted-foreground bg-muted/30"
            )}>
              {syntax.hasTask && <span>[#]</span>}
              {!syntax.hasTask && syntax.nestingLevel > 0 && <span>▸</span>}
              {syntax.label}
            </span>
          )}
          <span className="text-[9px] text-muted-foreground">
            {formatTime(item.capturedAt)}
          </span>
        </div>
        <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {!editing && (
            <button
              onClick={handleStartEdit}
              className="p-1 hover:bg-primary/20 hover:text-primary text-muted-foreground transition-colors text-xs"
              title="Edit"
              data-testid={`edit-btn-${item.id}`}
            >
              [✎]
            </button>
          )}
          <button
            onClick={() => onDelete(item.id)}
            className="p-1 hover:bg-destructive/20 hover:text-destructive text-muted-foreground transition-colors text-xs"
            title="Remove"
            data-testid={`delete-btn-${item.id}`}
          >
            [×]
          </button>
        </div>
      </div>

      {editing ? (
        <div className="px-2 pb-2 pt-1">
          <SmartInput
            value={editValue}
            onChange={setEditValue}
            onSubmit={handleSubmit}
            onCancel={handleCancel}
            autoFocus
            className="w-full bg-background text-foreground text-xs p-2 border border-border outline-none focus:border-primary transition-colors font-mono phosphor-glow"
            testId={`edit-input-${item.id}`}
          />
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[9px] text-muted-foreground">
              {syntax.hasTask || syntax.nestingLevel > 0 ? (
                <span className="font-bold text-primary phosphor-glow">
                  Enter → send to {activeOrgFile}
                </span>
              ) : (
                "Enter to save · Esc to cancel"
              )}
            </span>
          </div>
        </div>
      ) : (
        <div className="px-2 pb-2 pt-0.5 cursor-pointer" onClick={handleStartEdit}>
          {item.urlTitle && (
            <div className="text-[10px] text-primary font-semibold mb-0.5 truncate phosphor-glow" data-testid={`url-title-${item.id}`}>
              {item.urlTitle}
            </div>
          )}
          {item.urlDomain && (
            <div className="text-[9px] text-muted-foreground mb-0.5">{item.urlDomain}</div>
          )}
          <div className={cn(
            "text-xs line-clamp-3 phosphor-glow-dim",
            displayType === "code" ? "text-secondary font-mono" : "text-foreground",
            displayType === "url" || displayType === "gif" || displayType === "image" ? "text-primary underline underline-offset-2" : ""
          )}>
            {item.content}
          </div>
          {item.urlDescription && (
            <div className="text-[9px] text-muted-foreground mt-1 line-clamp-2">{item.urlDescription}</div>
          )}
          {(displayType === "gif" || displayType === "image") && item.urlImage && (
            <img
              src={item.urlImage}
              alt="Preview"
              className="mt-1.5 max-h-24 object-cover border border-border"
              data-testid={`preview-img-${item.id}`}
            />
          )}
          {(displayType === "gif" || displayType === "image") && !item.urlImage && item.content.match(/^https?:\/\//) && (
            <img
              src={item.content.trim()}
              alt="Preview"
              className="mt-1.5 max-h-24 object-cover border border-border"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              data-testid={`preview-img-${item.id}`}
            />
          )}
        </div>
      )}
    </div>
  );
}

export default function ClipboardManager({ activeOrgFile }: ClipboardManagerProps) {
  const { data: items = [], isLoading } = useClipboardItems();
  const deleteMutation = useDeleteClipboardItem();
  const addMutation = useAddClipboardItem();
  const smartCaptureMutation = useSmartCapture();
  const enrichMutation = useEnrichClipboard();
  const [newContent, setNewContent] = useState("");
  const { toast } = useToast();

  const updateAfterEnrich = (id: number, enriched: any) => {
    const updates: Record<string, string> = {};
    if (enriched.detection?.type) updates.detectedType = enriched.detection.type;
    if (enriched.detection?.domain) updates.urlDomain = enriched.detection.domain;
    if (enriched.metadata?.title) updates.urlTitle = enriched.metadata.title;
    if (enriched.metadata?.description) updates.urlDescription = enriched.metadata.description;
    if (enriched.metadata?.image) updates.urlImage = enriched.metadata.image;
    if (Object.keys(updates).length > 0) {
      fetch(`/api/clipboard/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
      });
    }
  };

  const syntax = parseCaptureSyntax(newContent);
  const showCaptureHint = syntax.hasTask || syntax.nestingLevel > 0;

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    const parsed = parseCaptureSyntax(newContent);
    if (parsed.hasTask || parsed.nestingLevel > 0) {
      smartCaptureMutation.mutate(
        { content: newContent.trim(), orgFileName: activeOrgFile },
        {
          onSuccess: (data) => {
            const label = parsed.hasTask ? "Task" : "Note";
            toast({
              title: `${label} captured`,
              description: `Added to ${activeOrgFile}${data.parsed?.scheduledDate ? ` — ${data.parsed.scheduledDate}` : ""}`,
              className: "bg-card border-secondary text-foreground",
            });
            setNewContent("");
          },
          onError: () => {
            toast({
              title: "Capture failed",
              description: "Could not process the entry.",
              className: "bg-card border-destructive text-foreground",
            });
          },
        }
      );
      return;
    }

    let type = "text";
    if (newContent.startsWith("http")) type = "link";
    else if (newContent.includes("{") || newContent.includes("function ")) type = "code";

    addMutation.mutate(
      { content: newContent, type },
      {
        onSuccess: (created) => {
          setNewContent("");
          if (newContent.startsWith("http")) {
            enrichMutation.mutate(newContent, {
              onSuccess: (enriched) => {
                if (enriched.detection || enriched.metadata) {
                  updateAfterEnrich(created.id, enriched);
                }
              },
            });
          }
        },
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id);
  };

  return (
    <div className="flex flex-col h-full bg-card border-l border-border w-80 flex-shrink-0 font-mono z-20">
      <div className="p-3 border-b border-border flex items-center justify-between bg-card">
        <div className="flex items-center gap-2 font-semibold text-secondary phosphor-glow">
          <span>⎘</span>
          <span className="text-sm">Clipboard</span>
        </div>
        <span className="text-[9px] text-muted-foreground">[{items.length}]</span>
      </div>

      <div className="p-2 border-b border-border">
        <SmartInput
          value={newContent}
          onChange={setNewContent}
          onSubmit={() => {
            if (!newContent.trim()) return;
            handleAddManual({ preventDefault: () => {} } as React.FormEvent);
          }}
          placeholder="t todo · > nest · [[ link"
          className={cn(
            "w-full bg-background text-foreground text-xs p-2 border outline-none transition-colors phosphor-glow",
            showCaptureHint ? "border-primary focus:border-primary" : "border-border focus:border-secondary"
          )}
          testId="clipboard-input"
        />
        {showCaptureHint && (
          <div className="mt-1 text-[9px] text-primary font-bold phosphor-glow">
            {syntax.label} → {activeOrgFile}
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic phosphor-glow-dim">Loading...</div>
          ) : items.length === 0 ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic phosphor-glow-dim">
              Clipboard is empty. Type above to capture.
            </div>
          ) : (
            items.map((item) => (
              <EditableItem
                key={item.id}
                item={item}
                activeOrgFile={activeOrgFile}
                onDelete={handleDelete}
              />
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
