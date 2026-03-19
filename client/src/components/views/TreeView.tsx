import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTreeData, useToggleTask, useBridgeStatus, useMailInbox, useTeamsChats, useSnowRecords } from "@/hooks/use-org-data";
import { apiRequest } from "@/lib/queryClient";

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
} | {
  type: "appLink";
  id: number;
  name: string;
  href: string;
} | {
  type: "snow-item";
  number: string;
  shortDescription: string;
  state: string;
  priority: string;
  recordType: "incident" | "change" | "request";
  slaBreached: boolean;
  url?: string;
} | {
  type: "epicActivity";
  name: string;
  env: string;
  category: string;
};

export default function TreeView({ onNavigate, onRunCommand }: TreeViewProps) {
  const { data, isLoading } = useTreeData();
  const toggleTask = useToggleTask();
  const { data: bridgeStatus } = useBridgeStatus();
  const bridgeConnected = bridgeStatus?.extension?.connected || false;
  const mailInbox = useMailInbox(bridgeConnected);
  const teamsChats = useTeamsChats();
  const snowRecords = useSnowRecords();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(["tasks", "programs"]));
  const containerRef = useRef<HTMLDivElement>(null);
  const [mailFetched, setMailFetched] = useState(false);
  const [chatFetched, setChatFetched] = useState(false);
  const [launchingApp, setLaunchingApp] = useState<string | null>(null);

  const launchCitrixApp = useCallback(async (appName: string) => {
    setLaunchingApp(appName);
    try {
      const res = await apiRequest("POST", "/api/cli/run", { command: `citrix launch ${appName}` });
      const data: { output: string } = await res.json();
      setLaunchingApp(null);
      return data.output;
    } catch (e: any) {
      setLaunchingApp(null);
      return `[error] ${e.message || "Launch failed"}`;
    }
  }, []);

  useEffect(() => {
    if (bridgeConnected && !expanded.has("mail")) {
      setExpanded(prev => new Set([...prev, "mail"]));
    }
  }, [bridgeConnected]);

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

    const CITRIX_JUNK = new Set(["open", "restart", "request", "cancel request", "add to favorites", "remove from favorites", "install", "more", "less"]);
    const CITRIX_CAT_HEADER = /^\[App\]\s*(Epic Non-Production|Epic Production|Epic Training|Epic Utilities|MyChart|Troubleshooting|Uncategorized)\s*\(\d+\)$/i;
    const isApp = (n: any) => n.tags?.some((t: string) => t.toLowerCase() === "apps");
    const allAppNotes = data.notes.filter(isApp);
    const appNotes = allAppNotes.filter(n => {
      const name = n.title.replace(/^\[App\]\s*/i, "").trim().toLowerCase();
      if (CITRIX_JUNK.has(name)) return false;
      if (CITRIX_CAT_HEADER.test(n.title)) return false;
      return true;
    });
    const regularNotes = data.notes.filter((n: any) => !isApp(n));

    const parseAppLink = (n: any): { name: string; href: string; category: string } => {
      const linkMatch = (n.body || "").match(/\[([^\]]+)\]\(([^)]+)\)/);
      const rawName = linkMatch ? linkMatch[1] : n.title.replace(/^\[App\]\s*/i, "");
      const href = linkMatch ? linkMatch[2] : ((n.body || "").match(/(https?:\/\/\S+)/)?.[1] || "");
      let category = "Apps";
      if (/Epic Production|^PRD |^SUP /i.test(rawName)) category = "Production";
      else if (/Epic Non-Production|^TST |^REL |^POC |^OLDTST |^PJX |^UAT |Staging/i.test(rawName)) category = "Non-Production";
      else if (/Epic Training|^ACE\d|^MST |^PLY |^PREP |^REF |^EXAM |^FSC /i.test(rawName)) category = "Training";
      else if (/MyChart/i.test(rawName)) category = "MyChart";
      else if (/Epic Utilities|System Pulse/i.test(rawName)) category = "Utilities";
      else if (/Troubleshoot|Tester|Testing/i.test(rawName)) category = "Troubleshooting";
      else if (/CTX|Remote Desktop|BCA|ClinApps|Edge|Hyland|OnBase|Tableau|Kuiper|DemoOCX|EDocument/i.test(rawName)) category = "Desktop Apps";
      return { name: rawName, href, category };
    };

    const categorized = new Map<string, Array<{ id: number; name: string; href: string }>>();
    const catOrder = ["Production", "Non-Production", "Training", "MyChart", "Desktop Apps", "Utilities", "Troubleshooting", "Apps"];
    for (const n of appNotes) {
      const app = parseAppLink(n);
      if (!categorized.has(app.category)) categorized.set(app.category, []);
      categorized.get(app.category)!.push({ id: n.id, name: app.name, href: app.href });
    }

    nodes.push({ type: "section", label: "APPS (Citrix)", key: "apps", count: appNotes.length || (bridgeConnected ? -1 : 0) });
    if (expanded.has("apps")) {
      if (appNotes.length > 0) {
        for (const cat of catOrder) {
          const items = categorized.get(cat);
          if (!items || items.length === 0) continue;
          nodes.push({ type: "section", label: `  ${cat}`, key: `apps-${cat}`, count: items.length });
          if (expanded.has(`apps-${cat}`)) {
            for (const app of items) {
              nodes.push({ type: "appLink", id: app.id, name: app.name, href: app.href });
            }
          }
        }
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter to scrape CWP" : "Bridge not connected", actionCmd: bridgeConnected ? "citrix --save" : "bridge-status" });
      }
    }

    const epicActs = (data as any).epicActivities || {};
    const epicEnvs = Object.keys(epicActs);
    if (epicEnvs.length > 0) {
      const totalActs = epicEnvs.reduce((sum, env) => sum + (epicActs[env]?.length || 0), 0);
      nodes.push({ type: "section", label: "EPIC (Activities)", key: "epic", count: totalActs });
      if (expanded.has("epic")) {
        for (const env of epicEnvs) {
          const acts: any[] = epicActs[env] || [];
          nodes.push({ type: "section", label: `  ${env}`, key: `epic-${env}`, count: acts.length });
          if (expanded.has(`epic-${env}`)) {
            const cats = new Map<string, any[]>();
            for (const a of acts) {
              const cat = a.parent || a.category || "General";
              if (!cats.has(cat)) cats.set(cat, []);
              cats.get(cat)!.push(a);
            }
            for (const [cat, items] of cats) {
              nodes.push({ type: "section", label: `    ${cat}`, key: `epic-${env}-${cat}`, count: items.length });
              if (expanded.has(`epic-${env}-${cat}`)) {
                for (const item of items) {
                  nodes.push({ type: "epicActivity", name: item.name, actType: item.type || "activity", env, category: cat });
                }
              }
            }
          }
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

    const emails = mailInbox.data || [];
    const chats = teamsChats.data || [];
    const bridgeHint = bridgeConnected
      ? (mailInbox.isFetching ? "Loading inbox..." : "Enter: fetch")
      : "Not connected — check extension options";

    const mailLabel = mailInbox.isFetching ? "MAIL (loading...)" : "MAIL (Outlook)";
    nodes.push({ type: "section", label: mailLabel, key: "mail", count: emails.length || (bridgeConnected ? -1 : 0) });
    if (expanded.has("mail")) {
      if (emails.length > 0) {
        for (const e of emails.slice(0, 10)) {
          nodes.push({ type: "mail", index: e.index || 0, from: e.from, subject: e.subject, unread: e.unread, date: e.date || "" });
        }
      } else if (mailInbox.isFetching) {
        nodes.push({ type: "bridge-info", label: "Scraping inbox via bridge...", actionCmd: "" });
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter to fetch" : bridgeHint, actionCmd: bridgeConnected ? "outlook" : "bridge-status" });
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

    const snowData = snowRecords.data?.records || [];
    const snowIncidents = snowData.filter(r => r.type === "incident");
    const snowChanges = snowData.filter(r => r.type === "change");
    const snowRequests = snowData.filter(r => r.type === "request");
    const snowTotal = snowData.length;

    nodes.push({ type: "section", label: "SNOW (ServiceNow)", key: "snow", count: snowTotal || (bridgeConnected ? -1 : 0) });
    if (expanded.has("snow")) {
      if (snowTotal > 0) {
        if (snowIncidents.length > 0) {
          nodes.push({ type: "section", label: "  Incidents", key: "snow-incidents", count: snowIncidents.length });
          if (expanded.has("snow-incidents")) {
            for (const r of snowIncidents.slice(0, 15)) {
              nodes.push({ type: "snow-item", number: r.number, shortDescription: r.shortDescription, state: r.state, priority: r.priority, recordType: r.type, slaBreached: r.slaBreached, url: r.url });
            }
          }
        }
        if (snowChanges.length > 0) {
          nodes.push({ type: "section", label: "  Changes", key: "snow-changes", count: snowChanges.length });
          if (expanded.has("snow-changes")) {
            for (const r of snowChanges.slice(0, 15)) {
              nodes.push({ type: "snow-item", number: r.number, shortDescription: r.shortDescription, state: r.state, priority: r.priority, recordType: r.type, slaBreached: r.slaBreached, url: r.url });
            }
          }
        }
        if (snowRequests.length > 0) {
          nodes.push({ type: "section", label: "  Requests", key: "snow-requests", count: snowRequests.length });
          if (expanded.has("snow-requests")) {
            for (const r of snowRequests.slice(0, 15)) {
              nodes.push({ type: "snow-item", number: r.number, shortDescription: r.shortDescription, state: r.state, priority: r.priority, recordType: r.type, slaBreached: r.slaBreached, url: r.url });
            }
          }
        }
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter or run :snow refresh" : "Bridge not connected", actionCmd: bridgeConnected ? "snow refresh" : "bridge-status" });
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
          if (node.key === "mail") {
            mailInbox.refetch(); setMailFetched(true);
          } else if (node.key === "chat" && !chatFetched) {
            teamsChats.refetch(); setChatFetched(true);
          } else if (node.key === "snow") {
            if (onRunCommand && (!snowRecords.data?.records?.length)) {
              onRunCommand("snow refresh");
            }
            snowRecords.refetch();
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
        else if (node?.type === "appLink") {
          const href = node.href && node.href !== "#" ? node.href : "";
          if (href && href.startsWith("http")) {
            window.open(href, "_blank");
          } else {
            launchCitrixApp(node.name);
          }
        }
        else if (node?.type === "chat") {
        }
        else if (node?.type === "snow-item" && node.url) {
          window.open(node.url, "_blank");
        }
        else if (node?.type === "snow-item" && onRunCommand) {
          onRunCommand(`snow detail ${node.number}`);
        }
        else if (node?.type === "epicActivity" && onRunCommand) {
          onRunCommand(`epic navigate ${node.env} ${node.name}`);
        }
        break;
    }
  }, [nodes, selectedIdx, toggleTask, onNavigate, onRunCommand, expanded, mailInbox, teamsChats, mailFetched, chatFetched, launchCitrixApp]);

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
              data-selected={sel}
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
        } else if (node.type === "appLink") {
          const isLaunching = launchingApp === node.name;
          icon = isLaunching ? "~" : "→";
          label = isLaunching ? `${node.name} [launching...]` : node.name;
          extra = node.href ? "↗" : "";
        } else if (node.type === "epicActivity") {
          icon = "·";
          label = node.name;
          extra = node.actType || "";
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
        } else if (node.type === "snow-item") {
          icon = node.slaBreached ? "!" : "·";
          label = `${node.number.padEnd(15)} ${node.shortDescription.slice(0, 40)}`;
          extra = `${node.state}${node.priority ? ` ${node.priority}` : ""}`;
        }

        return (
          <div
            key={`${node.type}-${"id" in node ? node.id : "number" in node ? node.number : idx}`}
            data-idx={idx}
            data-selected={sel}
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
              } else if (node.type === "appLink") {
                const href = node.href && node.href !== "#" ? node.href : "";
                if (href && href.startsWith("http")) {
                  window.open(href, "_blank");
                } else {
                  launchCitrixApp(node.name);
                }
              } else if (node.type === "epicActivity" && onRunCommand) {
                onRunCommand(`epic navigate ${node.env} ${node.name}`);
              } else if (node.type === "snow-item") {
                if (node.url) {
                  window.open(node.url, "_blank");
                } else if (onRunCommand) {
                  onRunCommand(`snow detail ${node.number}`);
                }
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
