import React from "react";

export function renderOrgContent(text: string, keyPrefix: string = "") {
  return text.split("\n").map((line, i) => {
    const key = `${keyPrefix}${i}`;
    let className = "font-mono whitespace-pre-wrap min-h-[1.4em] phosphor-glow-dim";

    if (line.startsWith("#+")) {
      const match = line.match(/^(#\+[A-Z_]+:)(.*)$/);
      if (match) {
        return (
          <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.4em] text-muted-foreground phosphor-glow-dim">
            <span>{match[1]}</span>
            {match[1] === "#+TITLE:" ? (
              <span className="text-foreground font-bold ml-1 phosphor-glow">{match[2]}</span>
            ) : (
              <span className="ml-1">{match[2]}</span>
            )}
          </div>
        );
      }
      className += " text-muted-foreground";
    } else if (/^\*{3}\s/.test(line)) {
      className = "font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold mt-1 phosphor-glow";
    } else if (/^\*{2}\s/.test(line)) {
      if (line.includes("TODO")) {
        const parts = line.split("TODO");
        return (
          <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold mt-1 phosphor-glow">
            {parts[0]}
            <span className="text-org-todo font-bold phosphor-glow-bright">TODO</span>
            {parts[1]}
          </div>
        );
      }
      if (line.includes("DONE")) {
        const parts = line.split("DONE");
        return (
          <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.4em] text-muted-foreground font-bold mt-1 phosphor-glow-dim">
            {parts[0]}
            <span className="font-bold">DONE</span>
            {parts[1]}
          </div>
        );
      }
      className = "font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold mt-1 phosphor-glow";
    } else if (/^\*\s/.test(line)) {
      className = "font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold mt-2 phosphor-glow-bright";
    } else if (/\[\[.*\]\]/.test(line)) {
      const match = line.match(/\[\[(.*)\]\]/);
      const linkContent = match ? match[1] : "";
      return (
        <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.4em] phosphor-glow-dim">
          <span
            className="text-foreground underline underline-offset-2 cursor-pointer hover:phosphor-glow transition-colors w-fit"
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
      className += " text-muted-foreground";
    } else if (line.match(/^\s+-\s\[.\]/)) {
      const checked = line.includes("[X]");
      return (
        <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.4em] phosphor-glow-dim">
          <span className={checked ? "text-muted-foreground line-through" : "text-foreground"}>
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
