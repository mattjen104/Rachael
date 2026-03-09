import React, { useState, useEffect, useMemo, useCallback } from "react";
import Sidebar from "@/components/layout/Sidebar";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import AgendaView from "@/components/editor/AgendaView";
import OrgBufferView from "@/components/editor/UnifiedView";
import type { ScrollTarget } from "@/components/editor/UnifiedView";
import RoamView from "@/components/editor/RoamView";
import OrgCapture from "@/components/editor/OrgCapture";
import Minibuffer from "@/components/editor/Minibuffer";
import { useSeedData, useOrgFiles, useCarryOverTasks } from "@/hooks/use-org-data";
import { useCrtTheme } from "@/lib/crt-theme";

type ViewMode = "org" | "agenda" | "roam" | "clipboard";

export default function Workspace() {
  const [viewMode, setViewMode] = useState<ViewMode>("clipboard");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [minibufferOpen, setMinibufferOpen] = useState(false);
  const [lastCommand, setLastCommand] = useState<string | null>(null);
  const [scrollTarget, setScrollTarget] = useState<ScrollTarget | null>(null);

  const seedMutation = useSeedData();
  const { data: orgFiles } = useOrgFiles();
  const carryOverMutation = useCarryOverTasks();
  const { cycleTheme } = useCrtTheme();

  const defaultCaptureFile = useMemo(() => {
    if (!orgFiles || orgFiles.length === 0) return "dad.org";
    const inbox = orgFiles.find(f => f.name === "inbox.org");
    if (inbox) return inbox.name;
    const dad = orgFiles.find(f => f.name === "dad.org");
    if (dad) return dad.name;
    return orgFiles[0].name;
  }, [orgFiles]);

  useEffect(() => {
    if (orgFiles && orgFiles.length === 0) {
      seedMutation.mutate();
    }
  }, [orgFiles]);

  const handleCommandExecuted = useCallback((label: string) => {
    setLastCommand(label);
  }, []);

  const echoMessage = useCallback((msg: string) => {
    setLastCommand(msg);
  }, []);

  useEffect(() => {
    if (lastCommand) {
      const timer = setTimeout(() => setLastCommand(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [lastCommand]);

  const handleNavigateToFile = useCallback((fileName: string) => {
    setViewMode("org");
    setScrollTarget({ file: fileName });
  }, []);

  const handleJumpToHeading = useCallback((sourceFile: string, title: string, lineNumber: number) => {
    setViewMode("org");
    setScrollTarget({ file: sourceFile, heading: title, lineNumber });
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (captureOpen) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setMinibufferOpen(prev => !prev);
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (minibufferOpen) return;

      if (isInput) return;

      if (e.key === " ") {
        e.preventDefault();
        setMinibufferOpen(true);
        return;
      }

      if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setCaptureOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [captureOpen, minibufferOpen]);

  return (
    <div className="crt-overlay flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-mono">
      <div className="crt-noise-overlay" />
      <div className="crt-glow-bar" />

      <div className="flex flex-1 overflow-hidden relative z-0">
        <Sidebar viewMode={viewMode} onSwitchView={setViewMode} />
        <main className="flex-1 flex flex-col relative overflow-hidden bg-background">
          {viewMode === "org" ? (
            <OrgBufferView
              scrollTarget={scrollTarget}
              onScrollComplete={() => setScrollTarget(null)}
            />
          ) : viewMode === "agenda" ? (
            <AgendaView onNavigateToFile={handleNavigateToFile} />
          ) : viewMode === "roam" ? (
            <RoamView />
          ) : (
            <ClipboardManager activeOrgFile={defaultCaptureFile} onEcho={echoMessage} />
          )}
        </main>
      </div>
      {minibufferOpen ? (
        <Minibuffer
          onClose={() => setMinibufferOpen(false)}
          onSwitchView={(v) => setViewMode(v)}
          onOpenCapture={() => setCaptureOpen(true)}
          onCycleTheme={cycleTheme}
          onCarryOver={() => carryOverMutation.mutate()}
          onCommandExecuted={handleCommandExecuted}
          onJumpToHeading={handleJumpToHeading}
        />
      ) : (
        <StatusBar viewMode={viewMode} lastCommand={lastCommand} onOpenMinibuffer={() => setMinibufferOpen(true)} />
      )}
      <OrgCapture open={captureOpen} onClose={() => setCaptureOpen(false)} defaultFile={defaultCaptureFile} />
    </div>
  );
}
