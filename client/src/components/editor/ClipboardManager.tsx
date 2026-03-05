import React, { useState } from "react";
import { ClipboardList, Copy, Trash2, CheckCircle2, ArrowRightToLine } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useClipboardItems, useDeleteClipboardItem, useAppendClipboardToOrg, useAddClipboardItem } from "@/hooks/use-org-data";

interface ClipboardManagerProps {
  activeOrgFile: string;
}

export default function ClipboardManager({ activeOrgFile }: ClipboardManagerProps) {
  const { data: items = [], isLoading } = useClipboardItems();
  const deleteMutation = useDeleteClipboardItem();
  const appendMutation = useAppendClipboardToOrg();
  const addMutation = useAddClipboardItem();
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [newContent, setNewContent] = useState("");
  const { toast } = useToast();

  const handleCopy = (id: number, content: string) => {
    navigator.clipboard.writeText(content).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleAppend = (id: number) => {
    appendMutation.mutate(
      { clipId: id, orgFileName: activeOrgFile },
      {
        onSuccess: () => {
          toast({
            title: "Appended to Workspace",
            description: `Added snippet to the INBOX section of ${activeOrgFile}`,
            className: "bg-[#21242b] border-[#51afef] text-[#bbc2cf]",
          });
        },
      }
    );
  };

  const handleDelete = (id: number) => {
    deleteMutation.mutate(id);
  };

  const handleAddManual = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newContent.trim()) return;

    let type = "text";
    if (newContent.startsWith("http")) type = "link";
    else if (newContent.includes("{") || newContent.includes("(") || newContent.includes("const ") || newContent.includes("function ")) type = "code";

    addMutation.mutate(
      { content: newContent, type },
      { onSuccess: () => setNewContent("") }
    );
  };

  const formatTime = (date: string | Date) => {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full bg-[#21242b] border-l border-border w-80 flex-shrink-0 font-mono z-20">
      <div className="p-3 border-b border-border flex items-center justify-between bg-[#1c1f24]">
        <div className="flex items-center gap-2 font-semibold text-secondary">
          <ClipboardList className="w-4 h-4" />
          <span className="text-sm">Clipboard History</span>
        </div>
      </div>

      <form onSubmit={handleAddManual} className="p-2 border-b border-border">
        <input
          type="text"
          value={newContent}
          onChange={(e) => setNewContent(e.target.value)}
          placeholder="Paste or type to capture..."
          className="w-full bg-[#282c34] text-[#bbc2cf] text-xs p-2 rounded-sm border border-border outline-none focus:border-secondary transition-colors"
          data-testid="clipboard-input"
        />
      </form>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-2">
          {isLoading ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic">
              Loading...
            </div>
          ) : items.length === 0 ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic">
              Clipboard is empty
            </div>
          ) : (
            items.map((item) => (
              <div
                key={item.id}
                className="group flex flex-col bg-[#282c34] border border-border rounded-sm p-2 hover:border-secondary/50 transition-colors"
                data-testid={`clipboard-item-${item.id}`}
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {item.type} • {formatTime(item.capturedAt)}
                  </span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleAppend(item.id)}
                      className="p-1 hover:bg-[#51afef]/20 hover:text-[#51afef] rounded text-muted-foreground transition-colors"
                      title={`Append to ${activeOrgFile} INBOX`}
                      data-testid={`append-btn-${item.id}`}
                    >
                      <ArrowRightToLine className="w-3 h-3" />
                    </button>
                    <button
                      onClick={() => handleCopy(item.id, item.content)}
                      className="p-1 hover:bg-secondary/20 hover:text-secondary rounded text-muted-foreground transition-colors"
                      title="Copy to clipboard"
                      data-testid={`copy-btn-${item.id}`}
                    >
                      {copiedId === item.id ? <CheckCircle2 className="w-3 h-3 text-secondary" /> : <Copy className="w-3 h-3" />}
                    </button>
                    <button
                      onClick={() => handleDelete(item.id)}
                      className="p-1 hover:bg-destructive/20 hover:text-destructive rounded text-muted-foreground transition-colors"
                      title="Remove from history"
                      data-testid={`delete-btn-${item.id}`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
                <div className={cn(
                  "text-xs line-clamp-3 text-[#bbc2cf]",
                  item.type === "code" && "text-[#98be65]",
                  item.type === "link" && "text-[#51afef] underline underline-offset-2"
                )}>
                  {item.content}
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>

      <div className="p-3 border-t border-border bg-[#1c1f24] text-[10px] text-muted-foreground text-center">
        {items.length} items captured
      </div>
    </div>
  );
}
