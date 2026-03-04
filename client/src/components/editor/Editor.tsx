import React, { useEffect, useRef } from "react";

interface EditorProps {
  file: string;
  mode: "NORMAL" | "INSERT" | "VISUAL";
  setMode: (mode: "NORMAL" | "INSERT" | "VISUAL") => void;
}

const mockDadOrg = `#+TITLE: Dad Knowledge Space
#+AUTHOR: Auto-Captured via iCloud
#+DATE: [2026-03-04 Wed]
#+STARTUP: showeverything

* INBOX Recent Captures
** TODO Process photo capture from Camera Roll                               :capture:photo:
   SCHEDULED: <2026-03-04 Wed>
   :PROPERTIES:
   :SOURCE: iCloud/Camera Roll
   :CAPTURED_AT: [2026-03-04 Wed 09:12]
   :END:
   
   New diagram of the architecture sketched on whiteboard.
   [[file:~/iCloud/Photos/IMG_20260304_0912.jpg]]

** DONE Review voice memo about project ideas                                :capture:voice:
   CLOSED: [2026-03-04 Wed 10:05]
   :PROPERTIES:
   :SOURCE: iCloud/Voice Memos
   :END:

* KNOWLEDGE BASE
** The Web App Architecture
   We are building a frontend React application that mimics Emacs/Doom mode 
   but runs in the browser. 
   
   Key features required:
   - [X] Vim keybindings (simulated visual states)
   - [X] Org-mode syntax highlighting
   - [ ] Auto-sync mechanism (mocked for now)
   
** Notes on React State Management
   Remember to keep the UI snappy. The editor should ideally be completely 
   uncontrolled for the actual typing, with only metadata synced back up.
`;

export default function Editor({ file, mode, setMode }: EditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus effect for mode switching
  useEffect(() => {
    if (textareaRef.current) {
      if (mode === "INSERT") {
        textareaRef.current.focus();
      } else {
        textareaRef.current.blur();
      }
    }
  }, [mode]);

  // Handle Vim-like keybindings simply for mockup
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if they're typing normally in insert mode
      if (mode === "INSERT" && e.key !== "Escape") return;

      if (e.key === "Escape") {
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
  }, [mode, setMode]);

  // Render text with Org-mode syntax highlighting
  const renderOrgContent = (text: string) => {
    return text.split("\\n").map((line, i) => {
      let className = "font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed";
      
      // Basic Org-mode syntax parsing
      if (line.startsWith("#+")) {
        className += " text-[#5B6268]"; // comments/meta
        
        // Highlight the keyword differently from value
        const match = line.match(/^(#\\+[A-Z_]+:)(.*)$/);
        if (match) {
          return (
            <div key={i} className={className}>
              <span className="text-org-keyword">{match[1]}</span>
              {match[1] === "#+TITLE:" ? (
                <span className="text-org-document-title font-bold text-xl ml-2">{match[2]}</span>
              ) : (
                <span className="text-[#bbc2cf] ml-2">{match[2]}</span>
              )}
            </div>
          );
        }
      } else if (line.match(/^\\*\\s/)) {
        className += " text-org-level-1 font-bold text-lg mt-4";
      } else if (line.match(/^\\*\\*\\s/)) {
        className += " text-org-level-2 font-bold mt-2";
      } else if (line.match(/^\\*\\*\\*\\s/)) {
        className += " text-org-level-3 font-semibold mt-1";
      } else if (line.includes("TODO")) {
        const parts = line.split("TODO");
        return (
          <div key={i} className={className}>
            {parts[0]}
            <span className="text-org-todo font-bold bg-[#3f444a] px-1 rounded-sm">TODO</span>
            {parts[1]}
          </div>
        );
      } else if (line.includes("DONE")) {
         const parts = line.split("DONE");
        return (
          <div key={i} className={className}>
            {parts[0]}
            <span className="text-org-done font-bold bg-[#3f444a] px-1 rounded-sm">DONE</span>
            {parts[1]}
          </div>
        );
      } else if (line.match(/\\[\\[.*\\]\\]/)) {
        // Links
        className += " text-org-link underline underline-offset-2";
      }

      return (
        <div key={i} className={className}>
          {line}
        </div>
      );
    });
  };

  return (
    <div className="flex-1 w-full h-full relative font-mono text-sm flex">
      {/* Gutter */}
      <div className="w-12 border-r border-border bg-[#21242b] flex flex-col items-end py-4 pr-2 text-[#5B6268] select-none h-full overflow-y-auto hidden-scrollbar">
        {mockDadOrg.split("\\n").map((_, i) => (
          <div key={i} className="min-h-[1.5rem] leading-relaxed">
            {mode === "NORMAL" && i === 10 ? <span className="text-primary">{i + 1}</span> : i + 1}
          </div>
        ))}
      </div>

      {/* Editor Content area */}
      <div className="flex-1 h-full overflow-y-auto p-4 relative group">
        {mode !== "INSERT" ? (
          <div className="w-full max-w-4xl mx-auto pb-32">
             {renderOrgContent(mockDadOrg)}
             {/* Mock Cursor for NORMAL mode */}
             {mode === "NORMAL" && (
                <div className="absolute top-[284px] left-[16px] w-2.5 h-[1.2rem] bg-primary animate-pulse mix-blend-difference pointer-events-none" />
             )}
             {/* Mock Selection for VISUAL mode */}
             {mode === "VISUAL" && (
                <div className="absolute top-[284px] left-[16px] w-64 h-[1.2rem] bg-secondary/40 pointer-events-none" />
             )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="w-full h-full max-w-4xl mx-auto bg-transparent text-foreground outline-none resize-none leading-relaxed pb-32 whitespace-pre-wrap"
            defaultValue={mockDadOrg}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
