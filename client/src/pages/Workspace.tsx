import React, { useState, useEffect, useMemo } from "react";
import Sidebar from "@/components/layout/Sidebar";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import AgendaView from "@/components/editor/AgendaView";
import OrgBufferView from "@/components/editor/UnifiedView";
import RoamView from "@/components/editor/RoamView";
import OrgCapture from "@/components/editor/OrgCapture";
import { useSeedData, useOrgFiles } from "@/hooks/use-org-data";

type ViewMode = "org" | "agenda" | "roam" | "clipboard";

export default function Workspace() {
  const [viewMode, setViewMode] = useState<ViewMode>("org");
  const [captureOpen, setCaptureOpen] = useState(false);

  const seedMutation = useSeedData();
  const { data: orgFiles } = useOrgFiles();

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

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (captureOpen) return;
      if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        setCaptureOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [captureOpen]);

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
            <ClipboardManager activeOrgFile={defaultCaptureFile} />
          )}
        </main>
      </div>
      <StatusBar viewMode={viewMode} />
      <OrgCapture open={captureOpen} onClose={() => setCaptureOpen(false)} defaultFile={defaultCaptureFile} />
    </div>
  );
}
