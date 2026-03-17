import React, { useState, useEffect, useCallback } from "react";
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
import Minibuffer from "@/components/editor/Minibuffer";
import { useSmartCapture } from "@/hooks/use-org-data";
import { useCrtTheme } from "@/lib/crt-theme";
import { useTvMode } from "@/hooks/use-tv-mode";

export default function Workspace() {
  const [viewMode, setViewMode] = useState<ViewMode>("agenda");
  const [minibufferOpen, setMinibufferOpen] = useState(false);
  const [minibufferInitialMode, setMinibufferInitialMode] = useState<"command" | "search" | "capture" | "add-url" | "shell">("command");
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<number | undefined>(undefined);
  const [pendingShellCmd, setPendingShellCmd] = useState<string | null>(null);

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

  useEffect(() => {
    if (window.parent !== window) {
      window.parent.postMessage({ action: "orgcloud-ready" }, "*");
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
      const tag = (document.activeElement as HTMLElement)?.tagName;
      const isEditable = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        (document.activeElement as HTMLElement)?.isContentEditable;
      if (isEditable || minibufferOpen) return;

      const text = e.clipboardData?.getData("text/plain")?.trim();
      if (!text) return;

      e.preventDefault();
      smartCapture.mutate(text);
      setLastCommand(`Captured: ${text.slice(0, 30)}`);
    };
    window.addEventListener("paste", handlePaste);
    return () => window.removeEventListener("paste", handlePaste);
  }, [smartCapture, minibufferOpen]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (minibufferOpen) return;

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

      if (e.key === "Escape") {
        if (viewMode === "cockpit") return;
        e.preventDefault();
        setViewMode("agenda");
        return;
      }

      if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (viewMode === "cockpit") return;
        e.preventDefault();
        const views: ViewMode[] = ["agenda", "tree", "programs", "results", "reader", "transcripts", "cockpit", "snow", "voice"];
        setViewMode(views[parseInt(e.key) - 1]);
        return;
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [minibufferOpen, viewMode]);

  return (
    <div className={`flex flex-col h-screen w-full mx-auto bg-background text-foreground overflow-hidden ${isTvMode ? "max-w-full px-4" : "max-w-[500px]"}`} data-testid="workspace">
      <Sidebar current={viewMode} onSwitch={setViewMode} />

      <div className="flex-1 overflow-hidden">
        {viewMode === "agenda" && <AgendaView onNavigate={handleNavigate} />}
        {viewMode === "tree" && <TreeView onNavigate={handleNavigate} onRunCommand={handleRunCommand} />}
        {viewMode === "programs" && <ProgramsView onNavigate={handleNavigate} />}
        {viewMode === "results" && <ResultsView selectedResultId={selectedItemId} />}
        {viewMode === "reader" && <ReaderView selectedPageId={selectedItemId} />}
        {viewMode === "transcripts" && <TranscriptsView selectedTranscriptId={selectedItemId} />}
        {viewMode === "cockpit" && <CockpitView />}
        {viewMode === "snow" && <SnowView />}
        {viewMode === "voice" && <VoiceView />}
      </div>

      <StatusBar
        viewMode={viewMode}
        lastCommand={lastCommand}
        onOpenMinibuffer={() => setMinibufferOpen(true)}
      />

      {minibufferOpen && (
        <Minibuffer
          initialMode={minibufferInitialMode}
          initialShellCmd={pendingShellCmd}
          onClose={() => { setMinibufferOpen(false); setPendingShellCmd(null); }}
          onSwitchView={setViewMode}
          onNavigate={handleNavigate}
          onCycleTheme={cycleTheme}
          onCommandExecuted={handleCommandExecuted}
        />
      )}
    </div>
  );
}
