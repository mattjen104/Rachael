import React, { useState, useCallback, useEffect, useRef } from "react";
import { useTreeData, useToggleTask, useBridgeStatus, useMailInbox, useTeamsChats, useSnowRecords } from "@/hooks/use-org-data";
import { apiRequest, queryClient, apiUrl } from "@/lib/queryClient";
import type { Task, Note } from "@shared/schema";

interface TreeViewProps {
  onNavigate?: (view: string, id?: number) => void;
  onRunCommand?: (cmd: string) => void;
  onEditItem?: (item: { type: "task"; data: Task } | { type: "note"; data: Note }) => void;
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
  portalName?: string;
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
  actType?: string;
} | {
  type: "epicTreeNode";
  name: string;
  env: string;
  client: string;
  navPath: string;
  controlType: string;
  hasChildren: boolean;
} | {
  type: "pulseLink";
  name: string;
  url: string;
  category: string;
} | {
  type: "galaxyKb";
  id: number;
  title: string;
  url: string;
  verified: boolean;
  flagged: boolean;
  memoryCount: number;
  summary: string | null;
} | {
  type: "galaxyGuide";
  id: number;
  title: string;
  url: string;
} | {
  type: "epicWorkflow";
  name: string;
  key: string;
  env: string;
  stepCount: number;
} | {
  type: "uiaElement";
  hint: string;
  name: string;
  controlType: string;
  value: string;
  checked: boolean | null;
  enabled: boolean;
  windowTitle: string;
  parent: string;
  isStatic: boolean;
};

export default function TreeView({ onNavigate, onRunCommand, onEditItem }: TreeViewProps) {
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
  const [epicRecording, setEpicRecording] = useState<{ active: boolean; env: string; stepCount: number }>({ active: false, env: "SUP", stepCount: 0 });
  const [recReview, setRecReview] = useState<{ show: boolean; steps: Array<{ step: number; description: string; screen: string; timeDelta: number; excluded?: boolean }>; name: string } | null>(null);
  const [refilePanel, setRefilePanel] = useState<{ captureId: number; content: string; type: "task" | "note"; title: string; tags: string; priority: string; scheduledDate: string; deadlineDate: string; parentId: string } | null>(null);
  const [desktopFilter, setDesktopFilter] = useState("");
  const [desktopFilterActive, setDesktopFilterActive] = useState(false);
  const desktopFilterWasActiveRef = useRef(false);
  const [navActionPending, setNavActionPending] = useState<string | null>(null);
  const [navInlineInput, setNavInlineInput] = useState<{ hint: string; windowTitle: string } | null>(null);
  const desktopFilterRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const checkRecStatus = async () => {
      try {
        const resp = await fetch(apiUrl("/api/epic/record/status"));
        if (resp.ok) {
          const d = await resp.json();
          setEpicRecording({ active: d.active, env: d.env, stepCount: d.stepCount });
        }
      } catch {}
    };
    checkRecStatus();
    const interval = setInterval(checkRecStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const launchCitrixApp = useCallback(async (appName: string, portalName?: string) => {
    setLaunchingApp(appName);
    try {
      const cmd = portalName ? `citrix launch ${appName} --portal ${portalName}` : `citrix launch ${appName}`;
      const res = await apiRequest("POST", "/api/cli/run", { command: cmd });
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

    const portalAppsData = (data as any).citrixPortalApps || {};
    const portalsData: Array<{ name: string; url: string; appCount: number }> = (data as any).citrixPortals || [];
    const hasPortalApps = Object.keys(portalAppsData).some(k => portalAppsData[k]?.length > 0);
    const totalAppCount = appNotes.length + Object.values(portalAppsData).reduce((sum: number, arr: any) => sum + (arr?.length || 0), 0);

    nodes.push({ type: "section", label: "APPS (Citrix)", key: "apps", count: totalAppCount || (bridgeConnected ? -1 : 0) });
    if (expanded.has("apps")) {
      if (appNotes.length > 0 || hasPortalApps) {
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
        }

        for (let pi = 0; pi < portalsData.length; pi++) {
          const portal = portalsData[pi];
          const pApps = portalAppsData[portal.name];
          if (!pApps || pApps.length === 0) continue;
          const portalKey = `apps-portal-${portal.name}`;
          nodes.push({ type: "section", label: `  [${portal.name}]`, key: portalKey, count: pApps.length });
          if (expanded.has(portalKey)) {
            const portalCategorized = new Map<string, Array<{ name: string; href: string; stableId: number }>>();
            for (let ai = 0; ai < pApps.length; ai++) {
              const app = pApps[ai];
              const appName = app.name || "";
              let cat = "Apps";
              if (/^PRD |^SUP /i.test(appName)) cat = "Production";
              else if (/^TST |^REL |^POC |^OLDTST |^PJX |^UAT /i.test(appName)) cat = "Non-Production";
              else if (/^ACE\d|^MST |^PLY |^PREP |^REF |^EXAM |^FSC /i.test(appName)) cat = "Training";
              else if (/MyChart/i.test(appName)) cat = "MyChart";
              else if (/CTX|Remote Desktop|BCA|ClinApps|Hyland|OnBase|Tableau|Kuiper/i.test(appName)) cat = "Desktop Apps";
              if (!portalCategorized.has(cat)) portalCategorized.set(cat, []);
              portalCategorized.get(cat)!.push({ ...app, stableId: -(1000 + pi * 1000 + ai) });
            }
            const pCats = [...portalCategorized.keys()].sort();
            if (pCats.length === 1 && pCats[0] === "Apps") {
              for (let ai = 0; ai < pApps.length; ai++) {
                nodes.push({ type: "appLink", id: -(1000 + pi * 1000 + ai), name: pApps[ai].name, href: pApps[ai].href || "", portalName: portal.name });
              }
            } else {
              for (const cat of [...catOrder, ...pCats.filter(c => !catOrder.includes(c))]) {
                const items = portalCategorized.get(cat);
                if (!items || items.length === 0) continue;
                const catKey = `${portalKey}-${cat}`;
                nodes.push({ type: "section", label: `    ${cat}`, key: catKey, count: items.length });
                if (expanded.has(catKey)) {
                  for (const app of items) {
                    nodes.push({ type: "appLink", id: app.stableId, name: app.name, href: app.href || "", portalName: portal.name });
                  }
                }
              }
            }
          }
        }
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter to scrape CWP" : "Bridge not connected", actionCmd: bridgeConnected ? "citrix --save" : "bridge-status" });
      }
    }

    const dw = (data as any).desktopWindows;
    const dwWindowList = dw?.windowList?.windows || [];
    const dwScanned = dw?.scannedWindows || {};
    const dwScannedKeys = Object.keys(dwScanned);
    const dwTotalCount = dwWindowList.length || dwScannedKeys.length;

    {
      nodes.push({ type: "section", label: "DESKTOP", key: "desktop", count: dwTotalCount > 0 ? dwTotalCount : -1 });
      if (expanded.has("desktop")) {
        if (desktopFilterActive && desktopFilter) {
          const filterLower = desktopFilter.toLowerCase();
          for (const [winTitle, winData] of Object.entries(dwScanned) as [string, any][]) {
            const elements = (winData.elements || []).filter((e: any) =>
              (e.name || "").toLowerCase().includes(filterLower) ||
              (e.controlType || "").toLowerCase().includes(filterLower)
            );
            if (elements.length === 0) continue;
            nodes.push({ type: "section", label: `  ${winTitle.slice(0, 50)} (${elements.length} matches)`, key: `desktop-search-${winTitle}`, count: elements.length });
            if (expanded.has(`desktop-search-${winTitle}`)) {
              for (const el of elements) {
                nodes.push({
                  type: "uiaElement",
                  hint: el.hint || "",
                  name: el.name || `(${el.controlType})`,
                  controlType: el.controlType || "",
                  value: el.value || "",
                  checked: el.checked ?? null,
                  enabled: el.enabled !== false,
                  windowTitle: winTitle,
                  parent: el.parent || "",
                  isStatic: !!el.static,
                });
              }
            }
          }
        } else {
          const windowTitles = dwWindowList.length > 0
            ? dwWindowList.map((w: any) => w.title)
            : dwScannedKeys;

          if (windowTitles.length === 0) {
            nodes.push({ type: "bridge-info", label: "No windows cached. Run epic_agent.py then: nav", actionCmd: "nav" });
          }

          for (const title of windowTitles) {
            const scanned = dwScanned[title];
            const hasDetail = !!scanned;
            const winKey = `desktop-win-${title}`;
            const elCount = hasDetail ? (scanned.elements || []).length : 0;

            nodes.push({ type: "section", label: `  ${title.slice(0, 55)}`, key: winKey, count: hasDetail ? elCount : -1 });
            if (expanded.has(winKey)) {
              if (hasDetail && scanned.elements) {
                const elements: any[] = scanned.elements;
                const minDepth = elements.reduce((m: number, e: any) => Math.min(m, e.depth ?? 0), 99);
                let lastParent = "";
                let lastParentExpanded = false;
                for (const el of elements) {
                  const elDepth = (el.depth ?? 0) - minDepth;
                  if (el.parent !== lastParent) {
                    lastParent = el.parent || "";
                    if (lastParent) {
                      const groupKey = `${winKey}-g-${lastParent}`;
                      nodes.push({ type: "section", label: `    ${lastParent}`, key: groupKey, count: 0 });
                      lastParentExpanded = expanded.has(groupKey);
                    } else {
                      lastParentExpanded = true;
                    }
                  }
                  if (!lastParentExpanded) continue;
                  const indent = "  ".repeat(Math.max(0, elDepth));
                  nodes.push({
                    type: "uiaElement",
                    hint: el.hint || "",
                    name: `${indent}${el.name || `(${el.controlType})`}`,
                    controlType: el.controlType || "",
                    value: el.value || "",
                    checked: el.checked ?? null,
                    enabled: el.enabled !== false,
                    windowTitle: title,
                    parent: el.parent || "",
                    isStatic: !!el.static,
                  });
                }
                const ageS = scanned.ageMs ? Math.round(scanned.ageMs / 1000) : 0;
                if (ageS > 0) {
                  nodes.push({ type: "bridge-info", label: `scanned ${ageS}s ago  |  r:refresh  /:search`, actionCmd: "" });
                }
              } else {
                nodes.push({ type: "bridge-info", label: "Press Enter to scan this window", actionCmd: `nav ${title}` });
              }
            }
          }
        }
      }
    }

    const recordedSessions: any[] = (data as any).recordedSessions || [];
    const transitionGraph: any = (data as any).transitionGraph || {};
    const sessionDesktopTree: any = (data as any).sessionDesktopTree || { nodes: {}, edges: [] };
    const graphEdges = Object.values(transitionGraph) as any[];
    const treeNodes = Object.values(sessionDesktopTree.nodes || {}) as any[];
    const treeEdges = (sessionDesktopTree.edges || []) as any[];

    if (recordedSessions.length > 0 || graphEdges.length > 0 || treeNodes.length > 0) {
      const totalItems = recordedSessions.length + treeNodes.length;
      nodes.push({ type: "section", label: "SESSIONS", key: "sessions", count: totalItems });
      if (expanded.has("sessions")) {
        if (treeNodes.length > 0 || treeEdges.length > 0) {
          nodes.push({ type: "section", label: "  Discovered Screens", key: "sessions-screens", count: treeNodes.length });
          if (expanded.has("sessions-screens")) {
            const sortedNodes = [...treeNodes].sort((a: any, b: any) => (b.visitCount || 0) - (a.visitCount || 0));
            for (const node of sortedNodes.slice(0, 30)) {
              const displayTitle = (node.titles || []).length > 0 ? node.titles[0].slice(0, 35) : node.fingerprint?.slice(0, 12) || "?";
              const visits = node.visitCount || 0;
              const sessCount = (node.sessions || []).length;
              const nodeKey = `sessions-screen-${node.fingerprint || displayTitle}`;
              nodes.push({ type: "section", label: `    ${displayTitle}`, key: nodeKey, count: visits });
              if (expanded.has(nodeKey)) {
                nodes.push({ type: "bridge-info", label: `      fp:${(node.fingerprint || "?").slice(0, 16)}  ${visits} visits  ${sessCount} sessions`, actionCmd: "" });
                if ((node.titles || []).length > 1) {
                  nodes.push({ type: "bridge-info", label: `      titles: ${node.titles.slice(0, 3).join(", ")}`, actionCmd: "" });
                }
                const outEdges = treeEdges.filter((e: any) => e.from === node.fingerprint);
                const inEdges = treeEdges.filter((e: any) => e.to === node.fingerprint);
                for (const e of outEdges.slice(0, 5)) {
                  const toLabel = e.toTitle?.slice(0, 25) || e.to?.slice(0, 12) || "?";
                  const ms = e.avgTransitionMs ? ` ~${e.avgTransitionMs}ms` : "";
                  const keys = (e.triggerKeys || []).length > 0 ? ` [${e.triggerKeys.join(",")}]` : "";
                  const crops = (e.labelCrops || []).length > 0 ? " +crop" : "";
                  nodes.push({ type: "bridge-info", label: `      -> ${toLabel}  (${e.count}x${ms}${keys}${crops})`, actionCmd: "" });
                }
                for (const e of inEdges.slice(0, 5)) {
                  const fromLabel = e.fromTitle?.slice(0, 25) || e.from?.slice(0, 12) || "?";
                  nodes.push({ type: "bridge-info", label: `      <- ${fromLabel}  (${e.count}x)`, actionCmd: "" });
                }
              }
            }
          }
        }

        if (graphEdges.length > 0) {
          const sortedEdges = [...graphEdges].sort((a: any, b: any) => (b.count || 0) - (a.count || 0));
          nodes.push({ type: "section", label: "  Navigation Paths", key: "sessions-graph", count: sortedEdges.length });
          if (expanded.has("sessions-graph")) {
            for (const edge of sortedEdges.slice(0, 30)) {
              const fromShort = (edge.from || "?").slice(0, 25);
              const toShort = (edge.to || "?").slice(0, 25);
              nodes.push({
                type: "bridge-info",
                label: `  ${fromShort} -> ${toShort}  (${edge.count}x)`,
                actionCmd: "",
              });
            }
          }
        }

        nodes.push({ type: "section", label: "  Recordings", key: "sessions-list", count: recordedSessions.length });
        if (expanded.has("sessions-list")) {
          for (const sess of recordedSessions.slice(0, 20)) {
            const dur = sess.duration_s ? `${Math.floor(sess.duration_s / 60)}m${sess.duration_s % 60}s` : "";
            const winShort = (sess.window_title || "").slice(0, 30);
            const sessKey = `session-${sess.session_id}`;
            nodes.push({
              type: "section",
              label: `    ${winShort}  ${dur}  ${sess.event_count || 0}ev`,
              key: sessKey,
              count: sess.transition_count || 0,
            });
            if (expanded.has(sessKey)) {
              nodes.push({
                type: "bridge-info",
                label: `      ID: ${sess.session_id}`,
                actionCmd: `epic record-session analyze ${sess.session_id}`,
              });
              nodes.push({
                type: "bridge-info",
                label: `      ${sess.screenshot_count || 0} screenshots, ${sess.click_count || 0} clicks, ${sess.key_count || 0} keys`,
                actionCmd: "",
              });
              if (sess.transition_count > 0) {
                nodes.push({
                  type: "bridge-info",
                  label: `      ${sess.transition_count} screen transitions detected`,
                  actionCmd: "",
                });
              }
            }
          }
          if (recordedSessions.length > 20) {
            nodes.push({ type: "bridge-info", label: `    ... and ${recordedSessions.length - 20} more`, actionCmd: "" });
          }
        }
      }
    }

    const epicActs = (data as any).epicActivities || {};
    const epicTrees = (data as any).epicTrees || {};
    const epicEnvs = [...new Set([...Object.keys(epicActs), ...Object.keys(epicTrees)])].sort();

    function countTreeNodes(node: any): number {
      let c = 0;
      for (const child of (node.children || [])) {
        c += 1;
        c += countTreeNodes(child);
      }
      return c;
    }

    function addTreeChildren(children: any[], env: string, client: string, parentKey: string, indent: string) {
      for (const child of children) {
        const childKey = `${parentKey}-${child.name}`;
        const hasKids = (child.children || []).length > 0;
        if (hasKids) {
          nodes.push({ type: "section", label: `${indent}${child.name}`, key: childKey, count: child.children.length });
          if (expanded.has(childKey)) {
            addTreeChildren(child.children, env, client, childKey, indent + "  ");
          }
        } else {
          nodes.push({
            type: "epicTreeNode",
            name: child.name,
            env,
            client,
            navPath: child.path || child.name,
            controlType: child.controlType || "",
            hasChildren: false,
          });
        }
      }
    }

    if (epicEnvs.length > 0) {
      let totalItems = 0;
      for (const env of epicEnvs) {
        totalItems += (epicActs[env]?.length || 0);
        if (epicTrees[env]) {
          for (const client of Object.keys(epicTrees[env])) {
            totalItems += countTreeNodes(epicTrees[env][client]);
          }
        }
      }

      const epicWorkflows: any[] = (data as any).epicWorkflows || [];
      nodes.push({ type: "section", label: "EPIC", key: "epic", count: totalItems + epicWorkflows.length });
      if (expanded.has("epic")) {
        for (const env of epicEnvs) {
          const envTrees = epicTrees[env] || {};
          const envActs: any[] = epicActs[env] || [];
          const treeClients = Object.keys(envTrees);
          const envTotal = envActs.length + treeClients.reduce((s, c) => s + countTreeNodes(envTrees[c]), 0);

          if (envTotal === 0) continue;
          nodes.push({ type: "section", label: `  ${env}`, key: `epic-${env}`, count: envTotal });
          if (expanded.has(`epic-${env}`)) {
            for (const client of treeClients) {
              const tree = envTrees[client];
              const treeCount = countTreeNodes(tree);
              const clientLabel = client === "hyperspace" ? "Hyperspace" : "Text";
              nodes.push({ type: "section", label: `    ${clientLabel}`, key: `epic-${env}-${client}`, count: treeCount });
              if (expanded.has(`epic-${env}-${client}`)) {
                addTreeChildren(tree.children || [], env, client, `epic-${env}-${client}`, "      ");
              }
            }

            if (envActs.length > 0 && treeClients.length > 0) {
              nodes.push({ type: "section", label: `    Activities (flat)`, key: `epic-${env}-flat`, count: envActs.length });
              if (expanded.has(`epic-${env}-flat`)) {
                const cats = new Map<string, any[]>();
                for (const a of envActs) {
                  const cat = a.parent || a.category || "General";
                  if (!cats.has(cat)) cats.set(cat, []);
                  cats.get(cat)!.push(a);
                }
                for (const [cat, items] of Array.from(cats.entries())) {
                  nodes.push({ type: "section", label: `      ${cat}`, key: `epic-${env}-flat-${cat}`, count: items.length });
                  if (expanded.has(`epic-${env}-flat-${cat}`)) {
                    for (const item of items) {
                      nodes.push({ type: "epicActivity", name: item.name, actType: item.type || "activity", env, category: cat });
                    }
                  }
                }
              }
            } else if (envActs.length > 0) {
              const cats = new Map<string, any[]>();
              for (const a of envActs) {
                const cat = a.parent || a.category || "General";
                if (!cats.has(cat)) cats.set(cat, []);
                cats.get(cat)!.push(a);
              }
              for (const [cat, items] of Array.from(cats.entries())) {
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

        if (epicWorkflows.length > 0) {
          nodes.push({ type: "section", label: "  WORKFLOWS", key: "epic-workflows", count: epicWorkflows.length });
          if (expanded.has("epic-workflows")) {
            for (const wf of epicWorkflows) {
              nodes.push({ type: "epicWorkflow" as const, name: wf.name, key: wf.key, env: wf.env, stepCount: wf.stepCount });
            }
          }
        }
      }
    }

    const pulseLinks: any[] = (data as any).pulseLinks || [];
    if (pulseLinks.length > 0) {
      nodes.push({ type: "section", label: "PULSE (Intranet)", key: "pulse", count: pulseLinks.length });
      if (expanded.has("pulse")) {
        const pulseCats = new Map<string, any[]>();
        for (const l of pulseLinks) {
          const cat = l.category || "General";
          if (!pulseCats.has(cat)) pulseCats.set(cat, []);
          pulseCats.get(cat)!.push(l);
        }
        for (const [cat, items] of Array.from(pulseCats.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
          nodes.push({ type: "section", label: `  ${cat}`, key: `pulse-${cat}`, count: items.length });
          if (expanded.has(`pulse-${cat}`)) {
            for (const item of items) {
              nodes.push({ type: "pulseLink", name: item.name, url: item.url, category: cat });
            }
          }
        }
      }
    }

    const journalNotes = regularNotes.filter((n: any) => (n.tags || []).some((t: string) => t.toLowerCase() === "journal"));
    const nonJournalNotes = regularNotes.filter((n: any) => !(n.tags || []).some((t: string) => t.toLowerCase() === "journal"));

    if (journalNotes.length > 0) {
      nodes.push({ type: "section", label: "JOURNAL", key: "journal", count: journalNotes.length });
      if (expanded.has("journal")) {
        const byDate = new Map<string, typeof journalNotes>();
        for (const n of journalNotes) {
          const date = n.createdAt ? new Date(n.createdAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "Undated";
          if (!byDate.has(date)) byDate.set(date, []);
          byDate.get(date)!.push(n);
        }
        for (const [date, entries] of Array.from(byDate.entries())) {
          nodes.push({ type: "section", label: `  ${date}`, key: `journal-${date}`, count: entries.length });
          if (expanded.has(`journal-${date}`)) {
            for (const n of entries) {
              nodes.push({ type: "note", id: n.id, title: n.title });
            }
          }
        }
      }
    }

    nodes.push({ type: "section", label: "NOTES", key: "notes", count: nonJournalNotes.length });
    if (expanded.has("notes")) {
      for (const n of nonJournalNotes) {
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

    const galaxyKbEntries: any[] = (data as any).galaxyKb || [];
    const galaxyPages = (data.reader || []).filter((r: any) => r.domain === "galaxy.epic.com");
    const galaxyCats: Record<number, string> = (data as any).galaxyCategories || {};
    const totalGalaxy = galaxyKbEntries.length || galaxyPages.length;
    if (totalGalaxy > 0) {
      nodes.push({ type: "section", label: "GALAXY KB", key: "galaxy", count: totalGalaxy });
      if (expanded.has("galaxy")) {
        if (galaxyKbEntries.length > 0) {
          const catMap = new Map<string, any[]>();
          for (const e of galaxyKbEntries) {
            const cat = e.category || "General";
            if (!catMap.has(cat)) catMap.set(cat, []);
            catMap.get(cat)!.push(e);
          }
          for (const [cat, items] of Array.from(catMap.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
            nodes.push({ type: "section", label: `  ${cat}`, key: `galaxy-${cat}`, count: items.length });
            if (expanded.has(`galaxy-${cat}`)) {
              for (const e of items) {
                nodes.push({
                  type: "galaxyKb",
                  id: e.id,
                  title: e.title,
                  url: e.url,
                  verified: e.verified,
                  flagged: e.flagged,
                  memoryCount: e.memoryCount,
                  summary: e.summary,
                });
              }
            }
          }
        } else {
          for (const g of galaxyPages) {
            const cat = galaxyCats[g.id] || "General";
            nodes.push({ type: "galaxyGuide", id: g.id, title: g.title, url: g.url });
          }
        }
      }
    }

    const nonGalaxyReader = (data.reader || []).filter((r: any) => r.domain !== "galaxy.epic.com");
    if (nonGalaxyReader.length > 0) {
      nodes.push({ type: "section", label: "READER", key: "reader", count: nonGalaxyReader.length });
      if (expanded.has("reader")) {
        for (const r of nonGalaxyReader) {
          nodes.push({ type: "reader", id: r.id, title: r.title, domain: r.domain });
        }
      }
    }

    const emails = mailInbox.data || [];
    const chats = teamsChats.data || [];
    const persistedEmails = data?.persistedEmails || [];
    const persistedTickets = data?.persistedTickets || [];
    const bootStatus = data?.bootStatus || {};
    const bridgeHint = bridgeConnected
      ? (mailInbox.isFetching ? "Loading inbox..." : "Enter: fetch")
      : "Not connected — check extension options";

    const rawDisplayEmails = emails.length > 0 ? emails : persistedEmails.map((e, i) => ({
      index: i, from: e.from || "", subject: e.subject || "", unread: e.unread, date: e.date || "",
    }));
    const displayEmails = rawDisplayEmails.filter(e => e.unread);
    const mailLabel = mailInbox.isFetching ? "MAIL (loading...)" : `MAIL (Outlook)${emails.length === 0 && persistedEmails.length > 0 ? " [db]" : ""}`;
    nodes.push({ type: "section", label: mailLabel, key: "mail", count: displayEmails.length || (bridgeConnected ? -1 : 0) });
    if (expanded.has("mail")) {
      if (displayEmails.length > 0) {
        for (const e of displayEmails.slice(0, 15)) {
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
    const displaySnow = snowData.length > 0
      ? snowData.map(r => ({ ...r, source: "personal" }))
      : persistedTickets.map(t => ({
          number: t.number, shortDescription: t.shortDescription || "", state: t.state,
          priority: t.priority, type: t.type, slaBreached: t.slaBreached || false, url: "",
          source: t.source || "personal",
        }));
    const snowPersonal = displaySnow.filter(r => r.source === "personal");
    const snowTeam = displaySnow.filter(r => r.source !== "personal");
    const snowTotal = displaySnow.length;

    const renderSnowGroup = (items: typeof displaySnow, keyPrefix: string, labelPrefix: string) => {
      const incidents = items.filter(r => r.type === "incident");
      const changes = items.filter(r => r.type === "change");
      const requests = items.filter(r => r.type === "request");
      if (incidents.length > 0) {
        nodes.push({ type: "section", label: `${labelPrefix}Incidents`, key: `snow-${keyPrefix}-incidents`, count: incidents.length });
        if (expanded.has(`snow-${keyPrefix}-incidents`)) {
          for (const r of incidents.slice(0, 15)) {
            nodes.push({ type: "snow-item", number: r.number, shortDescription: r.shortDescription, state: r.state, priority: r.priority, recordType: r.type, slaBreached: r.slaBreached, url: r.url });
          }
        }
      }
      if (changes.length > 0) {
        nodes.push({ type: "section", label: `${labelPrefix}Changes`, key: `snow-${keyPrefix}-changes`, count: changes.length });
        if (expanded.has(`snow-${keyPrefix}-changes`)) {
          for (const r of changes.slice(0, 15)) {
            nodes.push({ type: "snow-item", number: r.number, shortDescription: r.shortDescription, state: r.state, priority: r.priority, recordType: r.type, slaBreached: r.slaBreached, url: r.url });
          }
        }
      }
      if (requests.length > 0) {
        nodes.push({ type: "section", label: `${labelPrefix}Requests`, key: `snow-${keyPrefix}-requests`, count: requests.length });
        if (expanded.has(`snow-${keyPrefix}-requests`)) {
          for (const r of requests.slice(0, 15)) {
            nodes.push({ type: "snow-item", number: r.number, shortDescription: r.shortDescription, state: r.state, priority: r.priority, recordType: r.type, slaBreached: r.slaBreached, url: r.url });
          }
        }
      }
    };

    const snowLabel = `SNOW (ServiceNow)${snowData.length === 0 && persistedTickets.length > 0 ? " [db]" : ""}`;
    nodes.push({ type: "section", label: snowLabel, key: "snow", count: snowTotal || (bridgeConnected ? -1 : 0) });
    if (expanded.has("snow")) {
      if (snowTotal > 0) {
        if (snowTeam.length > 0) {
          nodes.push({ type: "section", label: "  My Tickets", key: "snow-personal", count: snowPersonal.length });
          if (expanded.has("snow-personal")) {
            renderSnowGroup(snowPersonal, "personal", "    ");
          }
          nodes.push({ type: "section", label: "  Team Queue", key: "snow-team", count: snowTeam.length });
          if (expanded.has("snow-team")) {
            renderSnowGroup(snowTeam, "team", "    ");
          }
        } else {
          renderSnowGroup(snowPersonal, "all", "  ");
        }
      } else {
        nodes.push({ type: "bridge-info", label: bridgeConnected ? "Press Enter or run :snow refresh" : "Bridge not connected", actionCmd: bridgeConnected ? "snow refresh" : "bridge-status" });
      }
    }
  }

  const activateNode = useCallback((node: TreeNode) => {
    if (node.type === "task") toggleTask.mutate(node.id);
    else if (node.type === "program") onNavigate?.("programs", node.id);
    else if (node.type === "reader") onNavigate?.("reader", node.id);
    else if (node.type === "note") onNavigate?.("tree", node.id);
    else if (node.type === "bridge-info" && node.actionCmd && onRunCommand) {
      onRunCommand(node.actionCmd);
    }
    else if (node.type === "mail" && onRunCommand) {
      onRunCommand(`outlook read ${node.index + 1}`);
    }
    else if (node.type === "appLink") {
      const href = node.href && node.href !== "#" ? node.href : "";
      if (href && href.startsWith("http")) {
        window.open(href, "_blank");
      } else {
        launchCitrixApp(node.name, node.portalName);
      }
    }
    else if (node.type === "chat") {}
    else if (node.type === "snow-item" && node.url) {
      window.open(node.url, "_blank");
    }
    else if (node.type === "snow-item" && onRunCommand) {
      onRunCommand(`snow detail ${node.number}`);
    }
    else if (node.type === "epicActivity" && onRunCommand) {
      onRunCommand(`epic launch ${node.env} ${node.name}`);
    }
    else if (node.type === "epicTreeNode" && onRunCommand) {
      if (node.navPath) {
        onRunCommand(`epic go ${node.env} ${node.navPath}`);
      } else {
        onRunCommand(`epic launch ${node.env} ${node.name}`);
      }
    }
    else if (node.type === "epicWorkflow" && onRunCommand) {
      onRunCommand(`epic replay ${node.key}`);
    }
    else if (node.type === "pulseLink") {
      window.open(node.url, "_blank");
    }
    else if (node.type === "galaxyKb") {
      onNavigate?.("galaxy-kb", node.id);
    }
    else if (node.type === "galaxyGuide") {
      onNavigate?.("reader", node.id);
    }
    else if (node.type === "uiaElement" && !node.isStatic) {
      if (node.controlType === "Edit" || node.controlType === "ComboBox" || node.controlType === "Spinner") {
        setNavInlineInput({ hint: node.hint, windowTitle: node.windowTitle });
      } else if (node.hint) {
        setNavActionPending(node.hint);
        (async () => {
          try {
            const sendResp = await apiRequest("POST", "/api/epic/agent/send", { type: "nav_do", window: node.windowTitle, hint: node.hint });
            const sendData = await sendResp.json() as any;
            const cmdId = sendData.commandId;
            if (cmdId) {
              const maxWait = 30000;
              const pollInterval = 600;
              let elapsed = 0;
              while (elapsed < maxWait) {
                await new Promise(r => setTimeout(r, pollInterval));
                elapsed += pollInterval;
                try {
                  const pollResp = await fetch(apiUrl(`/api/epic/agent/result/${cmdId}`));
                  const pollData = await pollResp.json() as any;
                  if (pollData.status && pollData.status !== "pending") break;
                } catch {}
              }
            }
            await new Promise(r => setTimeout(r, 2000));
            queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
          } catch {}
          setNavActionPending(null);
        })();
      }
    }
  }, [toggleTask, onNavigate, onRunCommand, launchCitrixApp]);

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
      case "e": {
        e.preventDefault();
        const eNode = nodes[selectedIdx];
        if (eNode?.type === "task" && data && onEditItem) {
          const taskData = data.tasks.find(t => t.id === eNode.id);
          if (taskData) onEditItem({ type: "task", data: taskData });
        } else if (eNode?.type === "note" && data && onEditItem) {
          const noteData = data.notes.find(n => n.id === eNode.id);
          if (noteData) onEditItem({ type: "note", data: noteData });
        }
        break;
      }
      case "r": {
        e.preventDefault();
        const rNode = nodes[selectedIdx];
        if (rNode?.type === "capture") {
          setRefilePanel({ captureId: rNode.id, content: rNode.content, type: "task", title: rNode.content, tags: "", priority: "", scheduledDate: "", deadlineDate: "", parentId: "" });
        } else if (rNode?.type === "section" && rNode.key.startsWith("desktop-win-")) {
          const winTitle = rNode.key.replace("desktop-win-", "");
          (async () => {
            try {
              await apiRequest("POST", "/api/epic/agent/send", { type: "nav_view", window: winTitle });
              setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/tree"] }), 2000);
            } catch {}
          })();
        } else if (rNode?.type === "uiaElement") {
          (async () => {
            try {
              await apiRequest("POST", "/api/epic/agent/send", { type: "nav_view", window: rNode.windowTitle });
              setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/tree"] }), 2000);
            } catch {}
          })();
        }
        break;
      }
      case "/": {
        const slashNode = nodes[selectedIdx];
        const isInDesktop = slashNode?.type === "section" && (slashNode.key === "desktop" || slashNode.key.startsWith("desktop-"))
          || slashNode?.type === "uiaElement";
        if (isInDesktop) {
          e.preventDefault();
          setDesktopFilterActive(true);
          setDesktopFilter("");
          setTimeout(() => desktopFilterRef.current?.focus(), 50);
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
        } else if (node) {
          activateNode(node);
        }
        break;
    }
  }, [nodes, selectedIdx, activateNode, onRunCommand, expanded, mailInbox, teamsChats, mailFetched, chatFetched]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    if (!data) return;
    const dw = (data as any).desktopWindows;
    const scannedKeys = Object.keys(dw?.scannedWindows || {});
    if (scannedKeys.length === 0) return;

    const wasActive = desktopFilterWasActiveRef.current;
    desktopFilterWasActiveRef.current = desktopFilterActive;

    if (!desktopFilterActive) {
      if (!wasActive) return;
      const timer = setTimeout(async () => {
        for (const winTitle of scannedKeys) {
          try {
            await apiRequest("POST", "/api/epic/agent/send", { type: "nav_view", window: winTitle });
          } catch {}
        }
        setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/tree"] }), 5000);
      }, 200);
      return () => clearTimeout(timer);
    }

    if (!desktopFilter) return;
    const timer = setTimeout(async () => {
      for (const winTitle of scannedKeys) {
        try {
          await apiRequest("POST", "/api/epic/agent/send", { type: "nav_view", window: winTitle, search: desktopFilter });
        } catch {}
      }
      setTimeout(() => queryClient.invalidateQueries({ queryKey: ["/api/tree"] }), 5000);
    }, 400);
    return () => clearTimeout(timer);
  }, [desktopFilter, desktopFilterActive, data]);

  useEffect(() => {
    containerRef.current?.querySelector(`[data-idx="${selectedIdx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx]);

  if (isLoading) return <div className="p-2 text-muted-foreground" data-testid="loading-tree">Loading...</div>;

  return (
    <div ref={containerRef} className="flex flex-col h-full overflow-y-auto font-mono text-xs" data-testid="tree-view">
      <div className="px-2 py-1 text-muted-foreground border-b border-border sticky top-0 bg-background z-10 flex justify-between">
        <span>TREE -- All Data</span>
        <span className="text-[10px]">Enter:open  e:edit  r:refile  j/k:nav</span>
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
              {node.key === "epic" && (
                <span
                  data-testid="epic-rec-toggle"
                  className={`ml-2 px-1 cursor-pointer ${epicRecording.active ? "text-red-500 animate-pulse" : "text-muted-foreground"}`}
                  onClick={async (e) => {
                    e.stopPropagation();
                    if (epicRecording.active) {
                      try {
                        const resp = await fetch(apiUrl("/api/epic/record/stop"), {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({}),
                        });
                        if (resp.ok) {
                          setEpicRecording(prev => ({ ...prev, active: false }));
                          const d = await resp.json();
                          let steps = d.steps || [];
                          await new Promise(r => setTimeout(r, 3000));
                          const statusResp = await fetch(apiUrl("/api/epic/record/status"));
                          if (statusResp.ok) {
                            const sd = await statusResp.json();
                            if (sd.stepCount > steps.length) {
                              const stopResp2 = await fetch(apiUrl("/api/epic/record/stop"), {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({}),
                              }).catch(() => null);
                              if (stopResp2?.ok) {
                                const d2 = await stopResp2.json();
                                if ((d2.steps || []).length > steps.length) steps = d2.steps;
                              }
                            }
                          }
                          steps = steps.map((s: any, i: number) => ({ ...s, step: i + 1 }));
                          if (steps.length > 0) {
                            setRecReview({ show: true, steps, name: "" });
                          }
                        }
                      } catch {}
                    } else {
                      try {
                        await fetch(apiUrl("/api/epic/record/start"), {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ env: "SUP" }),
                        });
                        setEpicRecording(prev => ({ ...prev, active: true }));
                      } catch {}
                    }
                  }}
                >{epicRecording.active ? "[REC]" : "[rec]"}</span>
              )}
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
        } else if (node.type === "epicTreeNode") {
          icon = node.client === "text" ? "#" : "·";
          label = node.name;
          extra = node.controlType === "TextMenuItem" ? "txt" : "";
        } else if (node.type === "pulseLink") {
          icon = "→";
          label = node.name;
          extra = "↗";
        } else if (node.type === "galaxyKb") {
          icon = node.verified ? "✓" : node.flagged ? "!" : "★";
          label = node.title.slice(0, 50);
          extra = `${node.memoryCount || 0}m`;
          if (node.summary) {
            label += ` -- ${node.summary.slice(0, 30)}`;
          }
        } else if (node.type === "galaxyGuide") {
          icon = "★";
          label = node.title.slice(0, 55);
          extra = "";
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
        } else if (node.type === "epicWorkflow") {
          icon = "▶";
          label = `${node.name}  [${node.env}]`;
          extra = `${node.stepCount} steps`;
        } else if (node.type === "snow-item") {
          icon = node.slaBreached ? "!" : "·";
          label = `${node.number.padEnd(15)} ${node.shortDescription.slice(0, 40)}`;
          extra = `${node.state}${node.priority ? ` ${node.priority}` : ""}`;
        } else if (node.type === "uiaElement") {
          const isPending = navActionPending === node.hint;
          if (node.isStatic) {
            icon = " ";
            label = `${node.controlType.padEnd(12)} ${node.name}`;
          } else {
            icon = isPending ? "~" : (node.hint ? `[${node.hint}]` : "·");
            const ctLabel = node.controlType.padEnd(12);
            label = `${ctLabel} ${node.name}`;
            if (node.value) extra = `= "${node.value.slice(0, 20)}"`;
            else if (node.checked === true) extra = "[x]";
            else if (node.checked === false) extra = "[ ]";
            else if (!node.enabled) extra = "(disabled)";
            else {
              const tags: string[] = [];
              if (["Button", "MenuItem", "Hyperlink", "SplitButton"].includes(node.controlType)) tags.push("clickable");
              if (["Edit", "ComboBox", "Spinner"].includes(node.controlType)) tags.push("editable");
              if (["CheckBox", "RadioButton"].includes(node.controlType)) tags.push("toggleable");
              if (["ListItem", "TreeItem", "TabItem"].includes(node.controlType)) tags.push("selectable");
              if (["TreeItem", "Group", "Tree", "Pane", "SplitButton", "ComboBox"].includes(node.controlType)) tags.push("expandable");
              if (tags.length > 0) extra = `[${tags.join(",")}]`;
            }
          }
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
            onClick={() => setSelectedIdx(idx)}
            onDoubleClick={() => activateNode(node)}
          >
            <span className="w-4 shrink-0 text-center">{icon}</span>
            <span className="truncate flex-1">{label}</span>
            {extra && <span className="text-muted-foreground shrink-0 text-[10px]">{extra}</span>}
          </div>
        );
      })}
      {desktopFilterActive && (
        <div className="border-t border-border bg-background px-2 py-1 flex items-center gap-1" data-testid="desktop-filter">
          <span className="text-xs text-muted-foreground">/</span>
          <input
            ref={desktopFilterRef}
            type="text"
            data-testid="desktop-filter-input"
            className="flex-1 bg-transparent border-none outline-none text-xs font-mono"
            placeholder="filter elements..."
            value={desktopFilter}
            onChange={(e) => setDesktopFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDesktopFilterActive(false);
                setDesktopFilter("");
              }
            }}
            autoFocus
          />
          <span className="text-[10px] text-muted-foreground cursor-pointer" onClick={() => { setDesktopFilterActive(false); setDesktopFilter(""); }}>ESC</span>
        </div>
      )}
      {navInlineInput && (
        <div className="border-t border-border bg-background px-2 py-1" data-testid="nav-inline-input">
          <div className="text-[10px] text-muted-foreground mb-1">Type value for [{navInlineInput.hint}]:</div>
          <input
            type="text"
            data-testid="nav-inline-value"
            className="w-full bg-transparent border border-border px-1 py-0.5 text-xs font-mono"
            placeholder="Enter value..."
            onKeyDown={async (e) => {
              if (e.key === "Enter") {
                const val = (e.target as HTMLInputElement).value;
                if (val) {
                  try {
                    await apiRequest("POST", "/api/epic/agent/send", { type: "nav_do", window: navInlineInput.windowTitle, hint: navInlineInput.hint, value: val });
                    queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
                  } catch {}
                }
                setNavInlineInput(null);
              } else if (e.key === "Escape") {
                setNavInlineInput(null);
              }
            }}
            autoFocus
          />
        </div>
      )}
      {refilePanel && (
        <div className="border-t border-border bg-background p-2" data-testid="refile-panel">
          <div className="text-xs font-bold mb-1 text-primary">REFILE CAPTURE</div>
          <div className="text-[10px] text-muted-foreground mb-1 truncate">{refilePanel.content}</div>
          <div className="flex gap-2 mb-1">
            <label className="text-[10px] text-muted-foreground flex items-center gap-1">
              <input type="radio" name="refile-type" value="task" checked={refilePanel.type === "task"} onChange={() => setRefilePanel(prev => prev ? { ...prev, type: "task" } : prev)} />
              Task
            </label>
            <label className="text-[10px] text-muted-foreground flex items-center gap-1">
              <input type="radio" name="refile-type" value="note" checked={refilePanel.type === "note"} onChange={() => setRefilePanel(prev => prev ? { ...prev, type: "note" } : prev)} />
              Note
            </label>
          </div>
          <input
            type="text"
            data-testid="refile-title"
            className="w-full bg-transparent border border-border px-1 py-0.5 text-xs font-mono mb-1"
            placeholder="Title..."
            value={refilePanel.title}
            onChange={(e) => setRefilePanel(prev => prev ? { ...prev, title: e.target.value } : prev)}
            autoFocus
          />
          <div className="flex gap-1 mb-1">
            <input
              type="text"
              data-testid="refile-tags"
              className="flex-1 bg-transparent border border-border px-1 py-0.5 text-[10px] font-mono"
              placeholder="Tags (comma sep)..."
              value={refilePanel.tags}
              onChange={(e) => setRefilePanel(prev => prev ? { ...prev, tags: e.target.value } : prev)}
            />
            {refilePanel.type === "task" && (
              <select
                data-testid="refile-priority"
                className="bg-background border border-border px-1 py-0.5 text-[10px]"
                value={refilePanel.priority}
                onChange={(e) => setRefilePanel(prev => prev ? { ...prev, priority: e.target.value } : prev)}
              >
                <option value="">Pri</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
              </select>
            )}
          </div>
          {refilePanel.type === "task" && (
            <div className="flex gap-1 mb-1">
              <input
                type="date"
                data-testid="refile-scheduled"
                className="flex-1 bg-transparent border border-border px-1 py-0.5 text-[10px]"
                value={refilePanel.scheduledDate}
                onChange={(e) => setRefilePanel(prev => prev ? { ...prev, scheduledDate: e.target.value } : prev)}
              />
              <input
                type="date"
                data-testid="refile-deadline"
                className="flex-1 bg-transparent border border-border px-1 py-0.5 text-[10px]"
                value={refilePanel.deadlineDate}
                onChange={(e) => setRefilePanel(prev => prev ? { ...prev, deadlineDate: e.target.value } : prev)}
              />
            </div>
          )}
          {refilePanel.type === "task" && data?.tasks && (
            <select
              data-testid="refile-parent"
              className="w-full bg-background border border-border px-1 py-0.5 text-[10px] mb-1"
              value={refilePanel.parentId}
              onChange={(e) => setRefilePanel(prev => prev ? { ...prev, parentId: e.target.value } : prev)}
            >
              <option value="">No parent</option>
              {data.tasks.map(t => (
                <option key={t.id} value={String(t.id)}>{t.title}</option>
              ))}
            </select>
          )}
          <div className="flex gap-1">
            <button
              data-testid="refile-submit"
              className="px-2 py-0.5 text-xs border border-primary text-primary hover:bg-primary/20"
              onClick={() => {
                const parsedTags = refilePanel.tags.split(",").map(t => t.trim()).filter(Boolean);
                apiRequest("POST", `/api/captures/${refilePanel.captureId}/refile`, {
                  type: refilePanel.type,
                  title: refilePanel.title,
                  tags: parsedTags,
                  priority: refilePanel.priority || undefined,
                  scheduledDate: refilePanel.scheduledDate || undefined,
                  deadlineDate: refilePanel.deadlineDate || undefined,
                  parentId: refilePanel.parentId ? parseInt(refilePanel.parentId, 10) : undefined,
                }).then(() => {
                  queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
                  queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
                  setRefilePanel(null);
                }).catch(() => {});
              }}
            >[refile]</button>
            <button
              data-testid="refile-cancel"
              className="px-2 py-0.5 text-xs border border-border text-muted-foreground hover:bg-muted"
              onClick={() => setRefilePanel(null)}
            >[cancel]</button>
          </div>
        </div>
      )}
      {recReview && recReview.show && (
        <div className="border-t border-border bg-background p-2" data-testid="epic-rec-review">
          <div className="text-xs font-bold mb-1 text-primary">RECORDING REVIEW ({recReview.steps.filter(s => !s.excluded).length} steps)</div>
          <div className="mb-2 max-h-40 overflow-y-auto">
            {recReview.steps.map((s, i) => (
              <div key={i} className={`flex items-center gap-1 text-[10px] py-0.5 ${s.excluded ? "line-through text-muted-foreground" : ""}`}>
                <span
                  className="cursor-pointer w-3 text-center shrink-0"
                  data-testid={`rec-step-toggle-${i}`}
                  onClick={() => {
                    setRecReview(prev => {
                      if (!prev) return prev;
                      const steps = [...prev.steps];
                      steps[i] = { ...steps[i], excluded: !steps[i].excluded };
                      return { ...prev, steps };
                    });
                  }}
                >{s.excluded ? "x" : "+"}</span>
                <span className="truncate flex-1">{s.description}</span>
                <span className="text-muted-foreground shrink-0">[{s.screen}]</span>
              </div>
            ))}
          </div>
          <div className="flex gap-1 items-center">
            <input
              type="text"
              data-testid="rec-workflow-name"
              className="flex-1 bg-transparent border border-border px-1 py-0.5 text-xs font-mono"
              placeholder="Workflow name..."
              value={recReview.name}
              onChange={(e) => setRecReview(prev => prev ? { ...prev, name: e.target.value } : prev)}
            />
            <button
              data-testid="rec-save-btn"
              className="px-2 py-0.5 text-xs border border-primary text-primary hover:bg-primary/20"
              onClick={async () => {
                if (!recReview.name.trim()) return;
                const steps = recReview.steps.filter(s => !s.excluded);
                try {
                  const resp = await fetch(apiUrl("/api/epic/record/save"), {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name: recReview.name.trim(), steps }),
                  });
                  if (resp.ok) {
                    setRecReview(null);
                    if (onRunCommand) onRunCommand("epic workflows");
                  }
                } catch {}
              }}
            >[save]</button>
            <button
              data-testid="rec-discard-btn"
              className="px-2 py-0.5 text-xs border border-border text-muted-foreground hover:bg-muted"
              onClick={() => setRecReview(null)}
            >[discard]</button>
          </div>
        </div>
      )}
    </div>
  );
}
