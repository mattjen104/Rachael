import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTreeData, useToggleTask, useBridgeStatus, useMailInbox, useTeamsChats } from "@/hooks/use-org-data";

interface TreeViewProps {
  onNavigate?: (view: string, id?: number) => void;
  onRunCommand?: (cmd: string) => void;
}

type TreeNode = {
  type: "section";
  label: string;
  key: string;
  count: number;
} | {
  type: "task";
  id: number;
  title: string;
  status: string;
  tags: string[];
} | {
  type: "program";
  id: number;
  name: string;
  enabled: boolean;
  costTier: string;
} | {
  type: "skill";
  id: number;
  name: string;
} | {
  type: "note";
  id: number;
  title: string;
} | {
  type: "capture";
  id: number;
  content: string;
} | {
  type: "reader";
  id: number;
  title: string;
  domain: string | null;
} | {
  type: "bridge-info";
  label: string;
  actionCmd?: string;
} | {
  type: "mail";
  index: number;
  from: string;
  subject: string;
  unread: boolean;
  date: string;
} | {
  type: "chat";
  index: number;
  name: string;
  lastMessage: string;
  unread: boolean;
};

export default function TreeView({ onNavigate, onRunCommand }: TreeViewProps) {
  const { data, isLoading } = useTreeData();
  const toggleTask = useToggleTask();
  const { data: bridgeStatus } = useBridgeStatus();
  const mailInbox = useMailInbox();
  const teamsChats = useTeamsChats();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["tasks", "programs"]));
  const containerRef = useRef<HTMLDivElement>(null);
  const [mailFetched, setMailFetched] = useState(false);
  const [chatFetched, setChatFetched] = useState(false);

  const nodes: TreeNode[] = [];

  if (data) {
    nodes.push({ type: "section", label: "TASKS", key: "tasks", count: data.tasks.length });
    if (expanded.has("tasks")) {
      for (const t of data.tasks) {
        nodes.push({ type: "task", id: t.id, title: t.title, status: t.status, tags: t.tags || [] });
      }
    }

    nodes.push({ type: "section", label: "PROGRAMS", key: "programs", count: data.programs.length });
    if (expanded.has("programs")) {
      for (const p of data.programs) {
        nodes.push({ type: "program", id: p.id, name: p.name, enabled: p.enabled, costTier: p.costTier });
      }
    }

    nodes.push({ type: "section", label: "SKILLS", key: "skills", count: data.skills.length });
    if (expanded.has("skills")) {
      for (const s of data.skills) {
        nodes.push({ type: "skill", id: s.id, name: s.name });
      }
    }

    const isWiki = (n: any) => n.tags?.some((t: string) => t.toLowerCase() === "wiki");
    const wikiNotes = data.notes.filter(isWiki);
    const regularNotes = data.notes.filter((n: any) => !isWiki(n));

    if (wikiNotes.length > 0) {
      nodes.push({ type: "section", label: "WIKI", key: "wiki", count: wikiNotes.length });
      if (expanded.has("wiki")) {
        for (const n of wikiNotes) {
          nodes.push({ type: "note", id: n.id, title: n.title.replace(/^\[Wiki\]\s*/i, "") });
        }
      }
    }

    nodes.push({ type: "section", label: "NOTES", key: "notes", count: regularNotes.length });
    if (expanded.has("notes")) {
      for (const n of regularNotes) {
        nodes.push({ type: "note", id: n.id, title: n.title });
      }
    }

    if (data.captures.length > 0) {
      nodes.push({ type: "section", label: "INBOX", key: "captures", count: data.captures.length });
      if (expanded.has("captures")) {
        for (const c of data.captures) {
          nodes.push({ type: "capture", id: c.id, content: c.content });
        }
      }
    }

    if (data.reader.length > 0) {
      nodes.push({ type: "section", label: "READER", key: "reader", count: data.reader.length });
      if (expanded.has("reader")) {
        for (const r of data.reader) {
          nodes.push({ type: "reader", id: r.id, title: r.title, domain: r.domain });
        }
      }
    }

    const bridgeConnected = bridgeStatus?.extension?.connected || false;
    const emails = mailInbox.data || [];
    const chats = teamsChats.data || [];
    const bridgeHint = bridgeConnected
      ? "Enter: fetch"
      : "Not connected — check extension options";

    nodes.push({ type: "section", label: "MAIL (Outlook)", key: "mail", count: emails.length || (bridgeConnected ? -1 : 0) });
    if (expanded.has("mail")) {
      if (emails.length > 0) {
        for (const e of emails.slice(0, 15)) {
          nodes.push({ type: "mail", index: e.index || 0, from: e.from, subject: e.subject, unread: e.unread, date: e.date || "" });
        }
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter or run :outlook" : bridgeHint, actionCmd: bridgeConnected ? "outlook" : "bridge-status" });
      }
    }

    nodes.push({ type: "section", label: "CHAT (Teams)", key: "chat", count: chats.length || (bridgeConnected ? -1 : 0) });
    if (expanded.has("chat")) {
      if (chats.length > 0) {
        for (const c of chats.slice(0, 15)) {
          nodes.push({ type: "chat", index: c.index || 0, name: c.name, lastMessage: c.lastMessage, unread: c.unread });
        }
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter or run :teams" : bridgeHint, actionCmd: bridgeConnected ? "teams" : "bridge-status" });
      }
    }
  }

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    const tag = (document.activeElement as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;

    switch (e.key) {
      case "j":
        e.preventDefault();
        setSelectedIdx(i => Math.min(i + 1, nodes.length - 1));
        break;
      case "k":
        e.preventDefault();
        setSelectedIdx(i => Math.max(i - 1, 0));
        break;
      case "g":
        e.preventDefault();
        setSelectedIdx(0);
        break;
      case "G":
        e.preventDefault();
        setSelectedIdx(nodes.length - 1);
        break;
      case "c": {
        const cNode = nodes[selectedIdx];
        if (cNode?.type === "mail" && onRunCommand) {
          e.preventDefault();
          onRunCommand(`capture mail ${cNode.index + 1}`);
        }
        break;
      }
      case "Tab":
        e.preventDefault();
        const cur = nodes[selectedIdx];
        if (cur?.type === "section") {
          setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(cur.key)) next.delete(cur.key);
            else next.add(cur.key);
            return next;
          });
        }
        break;
      case "Enter":
        e.preventDefault();
        const node = nodes[selectedIdx];
        if (node?.type === "section") {
          setExpanded(prev => {
            const next = new Set(prev);
            if (next.has(node.key)) next.delete(node.key);
            else next.add(node.key);
            return next;
          });
          if (node.key === "mail" && !mailFetched) {
            mailInbox.refetch(); setMailFetched(true);
          } else if (node.key === "chat" && !chatFetched) {
            teamsChats.refetch(); setChatFetched(true);
          }
        }
        else if (node?.type === "task") toggleTask.mutate(node.id);
        else if (node?.type === "program") onNavigate?.("programs", node.id);
        else if (node?.type === "reader") onNavigate?.("reader", node.id);
        else if (node?.type === "note") onNavigate?.("tree", node.id);
        else if (node?.type === "bridge-info" && node.actionCmd && onRunCommand) {
          onRunCommand(node.actionCmd);
        }
        else if (node?.type === "mail" && onRunCommand) {
          onRunCommand(`outlook read ${node.index + 1}`);
        }
        else if (node?.type === "chat") {
        }
        break;
    }
  }, [nodes, selectedIdx, toggleTask, onNavigate, onRunCommand, expanded, mailInbox, teamsChats, mailFetched, chatFetched]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (isLoading) return <div className="p-2 text-muted-foreground" data-testid="loading-tree">Loading...</div>;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="tree-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between">
        <span>TREE -- All Data</span>
        <span className="text-[10px]">Enter:open  c:capture  j/k:nav</span>
      </div>
      {nodes.map((node, idx) => {
        const sel = idx === selectedIdx;
        if (node.type === "section") {
          const isExp = expanded.has(node.key);
          return (
            <div
              key={`s-${node.key}`}
              data-idx={idx}
              data-testid={`tree-section-${node.key}`}
              className={`px-2 py-1 cursor-pointer select-none font-bold ${sel ? "bg-primary/20 text-primary" : "text-muted-foreground"}`}
              onClick={() => {
                setSelectedIdx(idx);
                setExpanded(prev => {
                  const next = new Set(prev);
                  if (next.has(node.key)) next.delete(node.key);
                  else next.add(node.key);
                  return next;
                });
              }}
            >
              <span className="mr-1">{isExp ? "▼" : "▶"}</span>
              {node.label} {node.count >= 0 ? `(${node.count})` : ""}
            </div>
          );
        }

        let icon = "·";
        let label = "";
        let extra = "";

        if (node.type === "task") {
          icon = node.status === "DONE" ? "✓" : "□";
          label = node.title;
          extra = node.tags.length > 0 ? `:${node.tags.join(":")}:` : "";
        } else if (node.type === "program") {
          icon = node.enabled ? "●" : "○";
          label = node.name;
          extra = `[${node.costTier}]`;
        } else if (node.type === "skill") {
          icon = "⚡";
          label = node.name;
        } else if (node.type === "note") {
          icon = "📝";
          label = node.title;
        } else if (node.type === "capture") {
          icon = "📥";
          label = node.content.slice(0, 60);
        } else if (node.type === "reader") {
          icon = "📖";
          label = node.title.slice(0, 50);
          extra = node.domain || "";
        } else if (node.type === "bridge-info") {
          icon = "ℹ";
          label = node.label;
        } else if (node.type === "mail") {
          icon = node.unread ? ">" : " ";
          label = `${node.from.slice(0, 18).padEnd(18)}  ${node.subject.slice(0, 40)}`;
          extra = node.date;
        } else if (node.type === "chat") {
          icon = node.unread ? ">" : " ";
          label = `${node.name.slice(0, 20).padEnd(20)}  ${node.lastMessage.slice(0, 35)}`;
        }

        return (
          <div
            key={`${node.type}-${"id" in node ? node.id : idx}`}
            data-idx={idx}
            data-testid={`tree-item-${node.type}-${"id" in node ? node.id : idx}`}
            className={`px-2 py-0.5 pl-4 cursor-pointer select-none flex items-center gap-1 ${
              sel ? "bg-primary/20" : ""
            } ${node.type === "task" && node.status === "DONE" ? "text-muted-foreground line-through" : ""}`}
            onClick={() => {
              setSelectedIdx(idx);
              if (node.type === "bridge-info" && node.actionCmd && onRunCommand) {
                onRunCommand(node.actionCmd);
              } else if (node.type === "mail" && onRunCommand) {
                onRunCommand(`outlook read ${node.index + 1}`);
              }
            }}
          >
            <span className="w-4 shrink-0 text-center">{icon}</span>
            <span className="truncate flex-1">{label}</span>
            {extra && <span className="text-muted-foreground shrink-0 text-[10px]">{extra}</span>}
          </div>
        );
      })}
    </div>
  );
}
