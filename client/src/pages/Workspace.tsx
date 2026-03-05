import React, { useState, useEffect, useMemo, useCallback } from "react";
import Sidebar from "@/components/layout/Sidebar";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import AgendaView from "@/components/editor/AgendaView";
import OrgBufferView from "@/components/editor/UnifiedView";
import RoamView from "@/components/editor/RoamView";
import OrgCapture from "@/components/editor/OrgCapture";
import Minibuffer, { type CaptureData, type CapturePrefill } from "@/components/editor/Minibuffer";
import { useSeedData, useOrgFiles, useCarryOverTasks, useOrgCapture, useDeleteClipboardItem } from "@/hooks/use-org-data";
import { useCrtTheme } from "@/lib/crt-theme";

type ViewMode = "org" | "agenda" | "roam" | "clipboard";

export default function Workspace() {
  const [viewMode, setViewMode] = useState<ViewMode>("clipboard");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [minibufferOpen, setMinibufferOpen] = useState(false);
  const [minibufferInitialMode, setMinibufferInitialMode] = useState<"command" | "capture">("command");
  const [capturePrefill, setCapturePrefill] = useState<CapturePrefill | null>(null);
  const [lastCommand, setLastCommand] = useState<string | null>(null);

  const seedMutation = useSeedData();
  const { data: orgFiles } = useOrgFiles();
  const carryOverMutation = useCarryOverTasks();
  const captureMutation = useOrgCapture();
  const deleteClipboardMutation = useDeleteClipboardItem();
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

  useEffect(() => {
    if (lastCommand) {
      const timer = setTimeout(() => setLastCommand(null), 2000);
      return () => clearTimeout(timer);
    }
  }, [lastCommand]);

  const handleCapture = useCallback((data: CaptureData) => {
    const tags = data.tags && data.tags.length > 0 ? data.tags : undefined;
    captureMutation.mutate(
      {
        fileName: data.fileName,
        title: data.title,
        scheduledDate: data.template === "todo" ? (data.scheduledDate || new Date().toISOString().split("T")[0]) : undefined,
        tags,
      },
      {
        onSuccess: () => {
          if (data.clipboardId) {
            deleteClipboardMutation.mutate(data.clipboardId);
          }
        },
      }
    );
  }, [captureMutation, deleteClipboardMutation]);

  const handleRefile = useCallback((item: { id: number; content: string; urlTitle?: string | null }) => {
    setCapturePrefill({
      title: item.urlTitle || item.content,
      clipboardId: item.id,
    });
    setMinibufferInitialMode("capture");
    setMinibufferOpen(true);
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (captureOpen) return;

      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        if (minibufferOpen) {
          setMinibufferOpen(false);
        } else {
          setMinibufferInitialMode("command");
          setCapturePrefill(null);
          setMinibufferOpen(true);
        }
        return;
      }

      const tag = (e.target as HTMLElement)?.tagName;
      const isInput = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

      if (minibufferOpen) return;

      if (isInput) return;

      if (e.key === " ") {
        e.preventDefault();
        setMinibufferInitialMode("command");
        setCapturePrefill(null);
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

  const handleCloseMinibuffer = useCallback(() => {
    setMinibufferOpen(false);
    setCapturePrefill(null);
    setMinibufferInitialMode("command");
  }, []);

  return (
    <div className="crt-overlay flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-mono">
      <div className="crt-noise-overlay" />
      <div className="crt-glow-bar" />

      <div className="flex flex-1 overflow-hidden relative z-0">
        <Sidebar viewMode={viewMode} onSwitchView={setViewMode} />
        <main className="flex-1 flex flex-col relative overflow-hidden bg-background">
          {viewMode === "org" ? (
            <OrgBufferView />
          ) : viewMode === "agenda" ? (
            <AgendaView onNavigateToFile={() => {}} />
          ) : viewMode === "roam" ? (
            <RoamView />
          ) : (
            <ClipboardManager activeOrgFile={defaultCaptureFile} onRefile={handleRefile} />
          )}
        </main>
      </div>
      {minibufferOpen ? (
        <Minibuffer
          key={`${minibufferInitialMode}-${capturePrefill?.clipboardId || "none"}`}
          onClose={handleCloseMinibuffer}
          onSwitchView={(v) => setViewMode(v)}
          onCycleTheme={cycleTheme}
          onCarryOver={() => carryOverMutation.mutate()}
          onCommandExecuted={handleCommandExecuted}
          onCapture={handleCapture}
          prefill={capturePrefill}
          initialMode={minibufferInitialMode}
        />
      ) : (
        <StatusBar viewMode={viewMode} lastCommand={lastCommand} onOpenMinibuffer={() => { setMinibufferInitialMode("command"); setCapturePrefill(null); setMinibufferOpen(true); }} />
      )}
      <OrgCapture open={captureOpen} onClose={() => setCaptureOpen(false)} defaultFile={defaultCaptureFile} />
    </div>
  );
}
