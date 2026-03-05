import React, { useEffect, useRef, useState } from "react";
import { useOrgFileByName, useUpdateOrgFile } from "@/hooks/use-org-data";
import { renderOrgContent } from "./OrgRenderer";

interface EditorProps {
  file: string;
  mode: "NORMAL" | "INSERT" | "VISUAL";
  setMode: (mode: "NORMAL" | "INSERT" | "VISUAL") => void;
}

export default function Editor({ file, mode, setMode }: EditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { data: orgFile, isLoading } = useOrgFileByName(file);
  const updateMutation = useUpdateOrgFile();
  const [localContent, setLocalContent] = useState("");

  useEffect(() => {
    if (orgFile) {
      setLocalContent(orgFile.content);
    }
  }, [orgFile]);

  useEffect(() => {
    if (textareaRef.current) {
      if (mode === "INSERT") {
        textareaRef.current.focus();
      } else {
        textareaRef.current.blur();
      }
    }
  }, [mode]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (mode === "INSERT" && e.key !== "Escape") return;

      if (e.key === "Escape") {
        if (mode === "INSERT" && orgFile && localContent !== orgFile.content) {
          updateMutation.mutate({ id: orgFile.id, content: localContent });
        }
        setMode("NORMAL");
        return;
      }

      if (mode === "NORMAL") {
        if (e.key === "i" || e.key === "I") {
          e.preventDefault();
          setMode("INSERT");
        } else if (e.key === "v" || e.key === "V") {
          e.preventDefault();
          setMode("VISUAL");
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [mode, setMode, orgFile, localContent]);

  const content = localContent || "";
  const lines = content.split("\n");

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        Loading {file}...
      </div>
    );
  }

  if (!orgFile) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        File not found: {file}
      </div>
    );
  }

  return (
    <div className="flex-1 w-full h-full relative font-mono text-sm flex" data-testid="editor-container">
      <div className="w-12 border-r border-border bg-card flex flex-col items-end py-4 pr-2 text-muted-foreground select-none h-full overflow-y-auto phosphor-glow-dim"
        style={{ scrollbarWidth: 'none' }}>
        {lines.map((_, i) => (
          <div key={i} className="min-h-[1.5rem] leading-relaxed text-xs">
            {i + 1}
          </div>
        ))}
      </div>

      <div className="flex-1 h-full overflow-y-auto p-4 relative group">
        {mode !== "INSERT" ? (
          <div className="w-full max-w-4xl mx-auto pb-32" data-testid="editor-rendered">
            {renderOrgContent(content)}
            {mode === "NORMAL" && (
              <div className="absolute top-[284px] left-[16px] w-2.5 h-[1.2rem] bg-primary animate-pulse mix-blend-difference pointer-events-none" />
            )}
            {mode === "VISUAL" && (
              <div className="absolute top-[284px] left-[16px] w-64 h-[1.2rem] bg-secondary/40 pointer-events-none" />
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="w-full h-full max-w-4xl mx-auto bg-transparent text-foreground outline-none resize-none leading-relaxed pb-32 whitespace-pre-wrap phosphor-glow"
            value={localContent}
            onChange={(e) => setLocalContent(e.target.value)}
            spellCheck={false}
            data-testid="editor-textarea"
          />
        )}
      </div>
    </div>
  );
}
