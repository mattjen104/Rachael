import React, { useState, useEffect, useMemo, useCallback } from "react";
import Sidebar from "@/components/layout/Sidebar";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import MailView from "@/components/editor/MailView";
import OrgView from "@/components/editor/OrgView";
import OrgCapture from "@/components/editor/OrgCapture";
import type { CaptureContext } from "@/components/editor/OrgCapture";
import Minibuffer from "@/components/editor/Minibuffer";
import { useSeedData, useOrgFiles } from "@/hooks/use-org-data";
import { useCrtTheme } from "@/lib/crt-theme";

type ViewMode = "mail" | "org" | "clipboard";

export default function Workspace() {
  const [viewMode, setViewMode] = useState<ViewMode>("clipboard");
  const [captureOpen, setCaptureOpen] = useState(false);
  const [capturePrefill, setCapturePrefill] = useState<CaptureContext | null>(null);
  const [minibufferOpen, setMinibufferOpen] = useState(false);
  const [lastCommand, setLastCommand] = useState<string | null>(null);

  const seedMutation = useSeedData();
  const { data: orgFiles } = useOrgFiles();
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

  const handleJumpToHeading = useCallback((_sourceFile: string, _title: string, _lineNumber: number) => {
    setViewMode("org");
  }, []);

  const openCapture = useCallback((prefill?: CaptureContext) => {
    setCapturePrefill(prefill || null);
    setCaptureOpen(true);
  }, []);

  const closeCapture = useCallback(() => {
    setCaptureOpen(false);
    setCapturePrefill(null);
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
        openCapture({ url, title, selection });
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [openCapture]);

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

      if (e.key === "c" && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (!captureOpen && window.parent === window) {
          openCapture();
        }
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
          {viewMode === "mail" ? (
            <MailView />
          ) : viewMode === "org" ? (
            <OrgView />
          ) : (
            <ClipboardManager activeOrgFile={defaultCaptureFile} onEcho={echoMessage} />
          )}
        </main>
      </div>
      {minibufferOpen ? (
        <Minibuffer
          onClose={() => setMinibufferOpen(false)}
          onSwitchView={(v) => setViewMode(v)}
          onOpenCapture={() => openCapture()}
          onCycleTheme={cycleTheme}
          onCommandExecuted={handleCommandExecuted}
          onJumpToHeading={handleJumpToHeading}
        />
      ) : (
        <StatusBar viewMode={viewMode} lastCommand={lastCommand} onOpenMinibuffer={() => setMinibufferOpen(true)} />
      )}
      <OrgCapture open={captureOpen} onClose={closeCapture} defaultFile={defaultCaptureFile} prefill={capturePrefill} />
    </div>
  );
}
