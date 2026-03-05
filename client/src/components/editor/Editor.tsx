import React, { useEffect, useRef, useState } from "react";
import { useOrgFileByName, useUpdateOrgFile } from "@/hooks/use-org-data";

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

  const renderOrgContent = (text: string) => {
    return text.split("\n").map((line, i) => {
      let className = "font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed phosphor-glow-dim";

      if (line.startsWith("#+")) {
        className += " text-org-keyword";
        const match = line.match(/^(#\+[A-Z_]+:)(.*)$/);
        if (match) {
          return (
            <div key={i} className={className}>
              <span className="text-org-keyword">{match[1]}</span>
              {match[1] === "#+TITLE:" ? (
                <span className="text-org-document-title font-bold text-xl ml-2 phosphor-glow-bright">{match[2]}</span>
              ) : (
                <span className="text-foreground ml-2">{match[2]}</span>
              )}
            </div>
          );
        }
      } else if (/^\*{3}\s/.test(line)) {
        className = "font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-3 font-semibold mt-1 phosphor-glow";
      } else if (/^\*{2}\s/.test(line)) {
        if (line.includes("TODO")) {
          const parts = line.split("TODO");
          return (
            <div key={i} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-2 font-bold mt-2 phosphor-glow">
              {parts[0]}
              <span className="text-org-todo font-bold bg-muted px-1 rounded-sm phosphor-glow-bright">TODO</span>
              {parts[1]}
            </div>
          );
        }
        if (line.includes("DONE")) {
          const parts = line.split("DONE");
          return (
            <div key={i} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-2 font-bold mt-2 phosphor-glow-dim">
              {parts[0]}
              <span className="text-org-done font-bold bg-muted px-1 rounded-sm">DONE</span>
              {parts[1]}
            </div>
          );
        }
        className = "font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-2 font-bold mt-2 phosphor-glow";
      } else if (/^\*\s/.test(line)) {
        className = "font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-1 font-bold text-lg mt-4 phosphor-glow-bright";
      } else if (/\[\[.*\]\]/.test(line)) {
        const match = line.match(/\[\[(.*)\]\]/);
        const linkContent = match ? match[1] : "";
        return (
          <div key={i} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed phosphor-glow-dim">
            <span
              className="text-org-link underline underline-offset-2 cursor-pointer hover:text-primary transition-colors flex items-center gap-1 w-fit phosphor-glow"
              onClick={() => alert(`Opening iCloud file reference:\n${linkContent}`)}
              title="Open iCloud Reference"
            >
              [[{linkContent}]]
            </span>
          </div>
        );
      } else if (line.match(/^\s+:.*:/)) {
        className += " text-muted-foreground";
      } else if (line.match(/SCHEDULED:|CLOSED:|DEADLINE:/)) {
        className += " text-org-date";
      } else if (line.match(/^\s+-\s\[.\]/)) {
        const checked = line.includes("[X]");
        return (
          <div key={i} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed phosphor-glow-dim">
            <span className={checked ? "text-org-done line-through" : "text-foreground"}>
              {line}
            </span>
          </div>
        );
      }

      return (
        <div key={i} className={className}>
          {line || "\u00A0"}
        </div>
      );
    });
  };

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
