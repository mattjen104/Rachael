import React from "react";

export function renderOrgContent(text: string, keyPrefix: string = "") {
  return text.split("\n").map((line, i) => {
    const key = `${keyPrefix}${i}`;
    let className = "font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed phosphor-glow-dim";

    if (line.startsWith("#+")) {
      className += " text-org-keyword";
      const match = line.match(/^(#\+[A-Z_]+:)(.*)$/);
      if (match) {
        return (
          <div key={key} className={className}>
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
          <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-2 font-bold mt-2 phosphor-glow">
            {parts[0]}
            <span className="text-org-todo font-bold bg-muted px-1 rounded-sm phosphor-glow-bright">TODO</span>
            {parts[1]}
          </div>
        );
      }
      if (line.includes("DONE")) {
        const parts = line.split("DONE");
        return (
          <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed text-org-level-2 font-bold mt-2 phosphor-glow-dim">
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
        <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed phosphor-glow-dim">
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
        <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.5rem] leading-relaxed phosphor-glow-dim">
          <span className={checked ? "text-org-done line-through" : "text-foreground"}>
            {line}
          </span>
        </div>
      );
    }

    return (
      <div key={key} className={className}>
        {line || "\u00A0"}
      </div>
    );
  });
}
