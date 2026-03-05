import React, { useState, useRef, useEffect } from "react";
import { ClipboardList, Trash2, CheckCircle2, Calendar, FileText, Link, Code, Image, Type, Pencil } from "lucide-react";
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
} from "@/hooks/use-org-data";
import { queryClient } from "@/lib/queryClient";

interface ClipboardManagerProps {
  activeOrgFile: string;
}

function detectPrefix(content: string): { type: "task" | "appointment" | "note" | "plain"; label: string } | null {
  const trimmed = content.trim().toLowerCase();
  if (trimmed.startsWith("t ")) return { type: "task", label: "task" };
  if (trimmed.startsWith("a ")) return { type: "appointment", label: "appt" };
  if (trimmed.startsWith("n ")) return { type: "note", label: "note" };
  return null;
}

function getTypeIcon(type: string) {
  switch (type) {
    case "url": return <Link className="w-3 h-3" />;
    case "gif": case "image": return <Image className="w-3 h-3" />;
    case "code": return <Code className="w-3 h-3" />;
    default: return <Type className="w-3 h-3" />;
  }
}

function getTypeBadgeColor(type: string) {
  switch (type) {
    case "url": return "text-[#51afef] bg-[#51afef]/10";
    case "gif": case "image": return "text-[#c678dd] bg-[#c678dd]/10";
    case "code": return "text-[#98be65] bg-[#98be65]/10";
    default: return "text-muted-foreground bg-muted/30";
  }
}

function getPrefixBadgeColor(type: string) {
  switch (type) {
    case "task": return "text-[#ECBE7B] bg-[#ECBE7B]/15";
    case "appointment": return "text-[#c678dd] bg-[#c678dd]/15";
    case "note": return "text-[#98be65] bg-[#98be65]/15";
    default: return "";
  }
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
  const inputRef = useRef<HTMLInputElement>(null);
  const updateMutation = useUpdateClipboardItem();
  const smartCaptureMutation = useSmartCapture();
  const { toast } = useToast();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.setSelectionRange(editValue.length, editValue.length);
    }
  }, [editing]);

  const prefix = detectPrefix(editValue);
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
    const detected = detectPrefix(editValue);

    if (detected) {
      smartCaptureMutation.mutate(
        { content: editValue.trim(), orgFileName: activeOrgFile, clipboardId: item.id },
        {
          onSuccess: (data) => {
            setEditing(false);
            setShowSuccess(true);
            const typeLabel = detected.type === "task" ? "Task" : detected.type === "appointment" ? "Appointment" : "Note";
            toast({
              title: `${typeLabel} captured`,
              description: `Added to ${activeOrgFile}${data.parsed?.scheduledDate ? ` — ${data.parsed.scheduledDate}` : ""}`,
              className: "bg-[#21242b] border-[#98be65] text-[#bbc2cf]",
            });
            setTimeout(() => setShowSuccess(false), 1500);
          },
          onError: () => {
            setEditing(false);
            toast({
              title: "Capture failed",
              description: "Could not parse the entry. Check your prefix.",
              className: "bg-[#21242b] border-destructive text-[#bbc2cf]",
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
      <div className="flex items-center gap-2 bg-[#98be65]/10 border border-[#98be65]/30 rounded-sm p-2.5 text-[#98be65] text-xs animate-in fade-in">
        <CheckCircle2 className="w-4 h-4" />
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
        "group flex flex-col border rounded-sm transition-colors",
        editing
          ? "bg-[#1c1f24] border-[#ECBE7B]/50"
          : "bg-[#282c34] border-border hover:border-secondary/50"
      )}
      data-testid={`clipboard-item-${item.id}`}
    >
      <div className="flex justify-between items-center px-2 pt-1.5 pb-0.5">
        <div className="flex items-center gap-1.5">
          <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase", getTypeBadgeColor(displayType))}>
            {getTypeIcon(displayType)}
            {displayType}
          </span>
          {prefix && (
            <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase", getPrefixBadgeColor(prefix.type))}>
              {prefix.type === "task" && <Calendar className="w-2.5 h-2.5" />}
              {prefix.type === "appointment" && <Calendar className="w-2.5 h-2.5" />}
              {prefix.type === "note" && <FileText className="w-2.5 h-2.5" />}
              {prefix.label}
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
              className="p-1 hover:bg-[#ECBE7B]/20 hover:text-[#ECBE7B] rounded text-muted-foreground transition-colors"
              title="Edit"
              data-testid={`edit-btn-${item.id}`}
            >
              <Pencil className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => onDelete(item.id)}
            className="p-1 hover:bg-destructive/20 hover:text-destructive rounded text-muted-foreground transition-colors"
            title="Remove"
            data-testid={`delete-btn-${item.id}`}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>

      {editing ? (
        <div className="px-2 pb-2 pt-1">
          <input
            ref={inputRef}
            type="text"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); handleSubmit(); }
              if (e.key === "Escape") handleCancel();
            }}
            className="w-full bg-[#282c34] text-[#bbc2cf] text-xs p-2 rounded-sm border border-border outline-none focus:border-[#ECBE7B] transition-colors font-mono"
            data-testid={`edit-input-${item.id}`}
          />
          <div className="flex items-center justify-between mt-1.5">
            <span className="text-[9px] text-muted-foreground">
              {prefix ? (
                <span className={cn("font-bold", prefix.type === "task" ? "text-[#ECBE7B]" : prefix.type === "appointment" ? "text-[#c678dd]" : "text-[#98be65]")}>
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
            <div className="text-[10px] text-[#51afef] font-semibold mb-0.5 truncate" data-testid={`url-title-${item.id}`}>
              {item.urlTitle}
            </div>
          )}
          {item.urlDomain && (
            <div className="text-[9px] text-muted-foreground mb-0.5">{item.urlDomain}</div>
          )}
          <div className={cn(
            "text-xs line-clamp-3",
            displayType === "code" ? "text-[#98be65] font-mono" : "text-[#bbc2cf]",
            displayType === "url" || displayType === "gif" || displayType === "image" ? "text-[#51afef] underline underline-offset-2" : ""
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
              className="mt-1.5 rounded-sm max-h-24 object-cover border border-border"
              data-testid={`preview-img-${item.id}`}
            />
          )}
          {(displayType === "gif" || displayType === "image") && !item.urlImage && item.content.match(/^https?:\/\//) && (
            <img
              src={item.content.trim()}
              alt="Preview"
              className="mt-1.5 rounded-sm max-h-24 object-cover border border-border"
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
  const updateMutation = useUpdateClipboardItem();
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

  const newPrefix = detectPrefix(newContent);

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    const detected = detectPrefix(newContent);
    if (detected) {
      smartCaptureMutation.mutate(
        { content: newContent.trim(), orgFileName: activeOrgFile },
        {
          onSuccess: (data) => {
            const typeLabel = detected.type === "task" ? "Task" : detected.type === "appointment" ? "Appointment" : "Note";
            toast({
              title: `${typeLabel} captured`,
              description: `Added to ${activeOrgFile}${data.parsed?.scheduledDate ? ` — ${data.parsed.scheduledDate}` : ""}`,
              className: "bg-[#21242b] border-[#98be65] text-[#bbc2cf]",
            });
            setNewContent("");
          },
          onError: () => {
            toast({
              title: "Capture failed",
              description: "Could not process the entry.",
              className: "bg-[#21242b] border-destructive text-[#bbc2cf]",
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
    <div className="flex flex-col h-full bg-[#21242b] border-l border-border w-80 flex-shrink-0 font-mono z-20">
      <div className="p-3 border-b border-border flex items-center justify-between bg-[#1c1f24]">
        <div className="flex items-center gap-2 font-semibold text-secondary">
          <ClipboardList className="w-4 h-4" />
          <span className="text-sm">Clipboard</span>
        </div>
        <span className="text-[9px] text-muted-foreground">{items.length} items</span>
      </div>

      <form onSubmit={handleAddManual} className="p-2 border-b border-border">
        <div className="relative">
          <input
            type="text"
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="t task · a appt · n note"
            className={cn(
              "w-full bg-[#282c34] text-[#bbc2cf] text-xs p-2 rounded-sm border outline-none transition-colors",
              newPrefix ? "border-[#ECBE7B] focus:border-[#ECBE7B]" : "border-border focus:border-secondary"
            )}
            data-testid="clipboard-input"
          />
          {newPrefix && (
            <span className={cn(
              "absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded",
              getPrefixBadgeColor(newPrefix.type)
            )}>
              {newPrefix.label} → org
            </span>
          )}
        </div>
      </form>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic">Loading...</div>
          ) : items.length === 0 ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic">
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
