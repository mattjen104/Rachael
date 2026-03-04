import React, { useState, useEffect } from "react";
import { ClipboardList, Copy, Trash2, CheckCircle2 } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

interface ClipboardItem {
  id: string;
  content: string;
  timestamp: Date;
  type: "text" | "link" | "code";
}

// Mock initial data
const initialClipboard: ClipboardItem[] = [
  {
    id: "1",
    content: "https://github.com/hlissner/doom-emacs",
    timestamp: new Date(Date.now() - 1000 * 60 * 5),
    type: "link",
  },
  {
    id: "2",
    content: "const [mode, setMode] = useState<'NORMAL' | 'INSERT'>('NORMAL');",
    timestamp: new Date(Date.now() - 1000 * 60 * 30),
    type: "code",
  },
  {
    id: "3",
    content: "Remember to pick up groceries after work",
    timestamp: new Date(Date.now() - 1000 * 60 * 60 * 2),
    type: "text",
  },
];

export default function ClipboardManager() {
  const [items, setItems] = useState<ClipboardItem[]>(initialClipboard);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // In a real app, this would poll or listen to navigator.clipboard
  // For the mockup, we just show the static list

  const handleCopy = (id: string, content: string) => {
    navigator.clipboard.writeText(content).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = (id: string) => {
    setItems(items.filter(item => item.id !== id));
  };

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="flex flex-col h-full bg-[#21242b] border-l border-border w-80 flex-shrink-0 font-mono">
      <div className="p-3 border-b border-border flex items-center justify-between bg-[#1c1f24]">
        <div className="flex items-center gap-2 font-semibold text-secondary">
          <ClipboardList className="w-4 h-4" />
          <span className="text-sm">Clipboard History</span>
        </div>
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-2">
          {items.length === 0 ? (
            <div className="text-center p-4 text-muted-foreground text-xs italic">
              Clipboard is empty
            </div>
          ) : (
            items.map((item) => (
              <div 
                key={item.id} 
                className="group flex flex-col bg-[#282c34] border border-border rounded-sm p-2 hover:border-secondary/50 transition-colors"
              >
                <div className="flex justify-between items-center mb-1">
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {item.type} • {formatTime(item.timestamp)}
                  </span>
                  <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button 
                      onClick={() => handleCopy(item.id, item.content)}
                      className="p-1 hover:bg-secondary/20 hover:text-secondary rounded text-muted-foreground transition-colors"
                      title="Copy to clipboard"
                    >
                      {copiedId === item.id ? <CheckCircle2 className="w-3 h-3 text-secondary" /> : <Copy className="w-3 h-3" />}
                    </button>
                    <button 
                      onClick={() => handleDelete(item.id)}
                      className="p-1 hover:bg-destructive/20 hover:text-destructive rounded text-muted-foreground transition-colors"
                      title="Remove from history"
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
        Monitoring system clipboard...
      </div>
    </div>
  );
}
