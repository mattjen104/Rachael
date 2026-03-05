import React, { useState, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import Editor from "@/components/editor/Editor";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import AgendaView from "@/components/editor/AgendaView";
import OrgCapture from "@/components/editor/OrgCapture";
import { useSeedData, useOrgFiles } from "@/hooks/use-org-data";

type ViewMode = "editor" | "agenda";

export default function Workspace() {
  const [activeFile, setActiveFile] = useState("dad.org");
  const [mode, setMode] = useState<"NORMAL" | "INSERT" | "VISUAL">("NORMAL");
  const [showClipboard, setShowClipboard] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("editor");
  const [captureOpen, setCaptureOpen] = useState(false);

  const seedMutation = useSeedData();
  const { data: orgFiles } = useOrgFiles();

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
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          activeFile={activeFile}
          onSelectFile={(name) => { setActiveFile(name); setViewMode("editor"); }}
          toggleClipboard={() => setShowClipboard(!showClipboard)}
          isClipboardActive={showClipboard}
          viewMode={viewMode}
          onSwitchView={setViewMode}
          onOpenCapture={() => setCaptureOpen(true)}
        />
        <main className="flex-1 flex flex-col relative overflow-hidden bg-[#282c34]">
          {viewMode === "editor" ? (
            <Editor file={activeFile} mode={mode} setMode={setMode} />
          ) : (
            <AgendaView onNavigateToFile={handleNavigateToFile} />
          )}
        </main>
        {showClipboard && <ClipboardManager activeOrgFile={activeFile} />}
      </div>
      <StatusBar file={activeFile} mode={mode} viewMode={viewMode} />
      <OrgCapture open={captureOpen} onClose={() => setCaptureOpen(false)} defaultFile={activeFile} />
    </div>
  );
}
