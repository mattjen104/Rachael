import React, { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import Sidebar from "@/components/layout/Sidebar";
import type { ViewMode } from "@/components/layout/Sidebar";
import StatusBar from "@/components/layout/StatusBar";
import AgendaView from "@/components/views/AgendaView";
import TreeView from "@/components/views/TreeView";
import ProgramsView from "@/components/views/ProgramsView";
import ResultsView from "@/components/views/ResultsView";
import ReaderView from "@/components/views/ReaderView";
import TranscriptsView from "@/components/views/TranscriptsView";
import CockpitView from "@/components/views/CockpitView";
import SnowView from "@/components/views/SnowView";
import VoiceView from "@/components/views/VoiceView";
import EvolutionPanel from "@/components/views/EvolutionPanel";
import GalaxyKbView from "@/components/views/GalaxyKbView";
import Minibuffer from "@/components/editor/Minibuffer";
import InlineEditor from "@/components/editor/InlineEditor";
import NotificationToast from "@/components/layout/NotificationToast";
import { useSmartCapture } from "@/hooks/use-org-data";
import { useCrtTheme } from "@/lib/crt-theme";
import { useTvMode } from "@/hooks/use-tv-mode";
import type { Task, Note } from "@shared/schema";

interface ChromeWindow extends Window {
  chrome?: {
    runtime?: {
      sendMessage?: (msg: Record<string, string>, cb?: () => void) => void;
    };
  };
}

function getUrlParams(): { minibufferMode?: "command" | "search" | "capture" | "add-url" | "shell"; view?: ViewMode; openMinibuffer: boolean; template?: string } {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const template = params.get("template") || undefined;
  if (mode === "command") return { minibufferMode: "command", openMinibuffer: true };
  if (mode === "capture") return { minibufferMode: "capture", openMinibuffer: true, template };
  if (mode === "search") return { minibufferMode: "search", openMinibuffer: true };
  if (mode === "agenda") return { view: "agenda", openMinibuffer: false };
  return { openMinibuffer: false };
}

function sendClosePopup() {
  try {
    const w = window as ChromeWindow;
    if (w.chrome?.runtime?.sendMessage) {
      w.chrome.runtime.sendMessage({ action: "close-popup" });
    }
  } catch (_) {}
}

const viewTransition = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.15 },
};

export default function Workspace() {
  const urlParams = getUrlParams();
  const [viewMode, setViewMode] = useState<ViewMode>(urlParams.view || "agenda");
  const [minibufferOpen, setMinibufferOpen] = useState(urlParams.openMinibuffer);
  const [minibufferInitialMode, setMinibufferInitialMode] = useState<"command" | "search" | "capture" | "add-url" | "shell">(urlParams.minibufferMode || "command");
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | undefined>(undefined);
  const [pendingShellCmd, setPendingShellCmd] = useState<string | null>(null);
  const [editorItem, setEditorItem] = useState<{ type: "task"; data: Task } | { type: "note"; data: Note } | null>(null);
  const [captureContext, setCaptureContext] = useState<{ url: string; title: string; selection: string } | null>(null);

  const { cycleTheme } = useCrtTheme();
  const { isTvMode } = useTvMode();
  const smartCapture = useSmartCapture();

  const handleCommandExecuted = useCallback((label: string) => {
    setLastCommand(label);
  }, []);

  useEffect(() => {
    if (lastCommand) {
      const timer = setTimeout(() => setLastCommand(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [lastCommand]);

  const handleNavigate = useCallback((view: string, id?: number) => {
    setViewMode(view as ViewMode);
    setSelectedItemId(id);
  }, []);

  const handleRunCommand = useCallback((cmd: string) => {
    setPendingShellCmd(cmd);
    setMinibufferInitialMode("shell");
    setMinibufferOpen(true);
  }, []);

  const handleEditItem = useCallback((item: { type: "task"; data: Task } | { type: "note"; data: Note }) => {
    setEditorItem(item);
  }, []);

  const handleMinibufferClose = useCallback(() => {
    setMinibufferOpen(false);
    setPendingShellCmd(null);
    sendClosePopup();
  }, []);

  useEffect(() => {
    if (window.parent !== window) {
      window.parent.postMessage({ action: "orgcloud-ready" }, "*");
    }
  }, []);

  useEffect(() => {
    if (!urlParams.openMinibuffer) return;
    const w = window as ChromeWindow;
    if (w.chrome?.runtime?.sendMessage) {
      try {
        w.chrome.runtime.sendMessage({ action: "get-pending-context" }, (response: { context?: { url: string; title: string; selection: string } } | undefined) => {
          if (response?.context) {
            setCaptureContext(response.context);
          }
        });
      } catch (_) {}
    }
  }, []);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.action === "capture") {
        const { url, title, selection } = event.data;
        const content = selection || title || url || "";
        if (content) smartCapture.mutate(content);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [smartCapture]);

  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      const isEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (el?.isContentEditable ?? false);
      if (isEditable || minibufferOpen || editorItem) return;

      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;

      e.preventDefault();
      smartCapture.mutate(text);
      setLastCommand(`Captured: ${text.slice(0, 30)}`);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [smartCapture, minibufferOpen, editorItem]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (editorItem) return;
        if (minibufferOpen) return;
        if (viewMode === "cockpit") return;
        sendClosePopup();
        setViewMode("agenda");
        return;
      }

      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (minibufferOpen || editorItem) return;

      if (e.key === " " || (e.altKey && e.key === "x") || (e.ctrlKey && e.key === "k")) {
        e.preventDefault();
        setMinibufferInitialMode("command");
        setMinibufferOpen(true);
        return;
      }

      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setMinibufferInitialMode("search");
        setMinibufferOpen(true);
        return;
      }

      if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setMinibufferInitialMode("capture");
        setMinibufferOpen(true);
        return;
      }

      if (e.key === ":" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setMinibufferInitialMode("shell");
        setMinibufferOpen(true);
        return;
      }

      if (((e.key >= "1" && e.key <= "9") || e.key === "0") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (viewMode === "cockpit") return;
        e.preventDefault();
        const views: ViewMode[] = ["agenda", "tree", "programs", "results", "reader", "transcripts", "cockpit", "snow", "voice", "evolution"];
        const idx = e.key === "0" ? 9 : parseInt(e.key) - 1;
        if (idx < views.length) setViewMode(views[idx]);
        return;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [minibufferOpen, viewMode, editorItem]);

  const renderView = () => {
    switch (viewMode) {
      case "agenda": return <AgendaView onNavigate={handleNavigate} onEditItem={handleEditItem} />;
      case "tree": return <TreeView onNavigate={handleNavigate} onRunCommand={handleRunCommand} onEditItem={handleEditItem} />;
      case "programs": return <ProgramsView onNavigate={handleNavigate} />;
      case "results": return <ResultsView selectedResultId={selectedItemId} />;
      case "reader": return <ReaderView selectedPageId={selectedItemId} />;
      case "transcripts": return <TranscriptsView selectedTranscriptId={selectedItemId} />;
      case "cockpit": return <CockpitView />;
      case "snow": return <SnowView />;
      case "voice": return <VoiceView />;
      case "evolution": return <EvolutionPanel />;
      case "galaxy-kb": return <GalaxyKbView selectedEntryId={selectedItemId} />;
      default: return null;
    }
  };

  return (
    <div className={`flex flex-col h-screen w-full mx-auto bg-background text-foreground overflow-hidden ${isTvMode ? "max-w-full px-4" : "max-w-[500px]"}`} data-testid="workspace">
      <Sidebar current={viewMode} onSwitch={setViewMode} />

      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={viewMode}
            {...viewTransition}
            className="h-full"
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>
      </div>

      <NotificationToast />

      <StatusBar
        viewMode={viewMode}
        lastCommand={lastCommand}
        onOpenMinibuffer={() => setMinibufferOpen(true)}
      />

      <AnimatePresence>
        {minibufferOpen && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
          >
            <Minibuffer
              initialMode={minibufferInitialMode}
              initialShellCmd={pendingShellCmd}
              initialTemplate={urlParams.template}
              initialCaptureContext={captureContext}
              onClose={handleMinibufferClose}
              onSwitchView={setViewMode}
              onNavigate={handleNavigate}
              onCycleTheme={cycleTheme}
              onCommandExecuted={handleCommandExecuted}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {editorItem && (
        <InlineEditor
          item={editorItem}
          onClose={() => setEditorItem(null)}
        />
      )}
    </div>
  );
}
