import React, { useState, useEffect, useMemo } from "react";
import Sidebar from "@/components/layout/Sidebar";
import Editor from "@/components/editor/Editor";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import AgendaView from "@/components/editor/AgendaView";
import UnifiedView from "@/components/editor/UnifiedView";
import OrgCapture from "@/components/editor/OrgCapture";
import { useSeedData, useOrgFiles } from "@/hooks/use-org-data";

type ViewMode = "unified" | "editor" | "agenda";

export default function Workspace() {
  const [activeFile, setActiveFile] = useState("dad.org");
  const [mode, setMode] = useState<"NORMAL" | "INSERT" | "VISUAL">("NORMAL");
  const [showClipboard, setShowClipboard] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
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
      if (mode !== "NORMAL") return;
      if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        setCaptureOpen(true);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [mode, captureOpen]);

  const handleNavigateToFile = (fileName: string) => {
    setActiveFile(fileName);
    setViewMode("editor");
  };

  return (
    <div className="crt-overlay flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-mono">
      <div className="crt-noise-overlay" />
      <div className="crt-glow-bar" />

      <div className="flex flex-1 overflow-hidden relative z-0">
        <Sidebar
          activeFile={activeFile}
          onSelectFile={handleNavigateToFile}
          toggleClipboard={() => setShowClipboard(!showClipboard)}
          isClipboardActive={showClipboard}
          viewMode={viewMode}
          onSwitchView={setViewMode}
          onOpenCapture={() => setCaptureOpen(true)}
        />
        <main className="flex-1 flex flex-col relative overflow-hidden bg-background">
          {viewMode === "unified" ? (
            <UnifiedView onNavigateToFile={handleNavigateToFile} />
          ) : viewMode === "editor" ? (
            <Editor file={activeFile} mode={mode} setMode={setMode} />
          ) : (
            <AgendaView onNavigateToFile={handleNavigateToFile} />
          )}
        </main>
        {showClipboard && <ClipboardManager activeOrgFile={defaultCaptureFile} />}
      </div>
      <StatusBar file={activeFile} mode={mode} viewMode={viewMode} />
      <OrgCapture open={captureOpen} onClose={() => setCaptureOpen(false)} defaultFile={defaultCaptureFile} />
    </div>
  );
}
