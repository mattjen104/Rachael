import React, { useState, useEffect } from "react";
import Sidebar from "@/components/layout/Sidebar";
import Editor from "@/components/editor/Editor";
import StatusBar from "@/components/layout/StatusBar";
import ClipboardManager from "@/components/editor/ClipboardManager";
import { useSeedData, useOrgFiles } from "@/hooks/use-org-data";

export default function Workspace() {
  const [activeFile, setActiveFile] = useState("dad.org");
  const [mode, setMode] = useState<"NORMAL" | "INSERT" | "VISUAL">("NORMAL");
  const [showClipboard, setShowClipboard] = useState(false);
  
  const seedMutation = useSeedData();
  const { data: orgFiles } = useOrgFiles();
  
  useEffect(() => {
    if (orgFiles && orgFiles.length === 0) {
      seedMutation.mutate();
    }
  }, [orgFiles]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-background text-foreground font-sans">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar 
          activeFile={activeFile} 
          onSelectFile={setActiveFile} 
          toggleClipboard={() => setShowClipboard(!showClipboard)}
          isClipboardActive={showClipboard}
        />
        <main className="flex-1 flex flex-col relative overflow-hidden bg-[#282c34]">
          <Editor file={activeFile} mode={mode} setMode={setMode} />
        </main>
        {showClipboard && <ClipboardManager activeOrgFile={activeFile} />}
      </div>
      <StatusBar file={activeFile} mode={mode} />
    </div>
  );
}
