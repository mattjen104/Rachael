import React from "react";

interface RenderContext {
  fileName?: string;
  lineNumber?: number;
  onToggleStatus?: (fileName: string, lineNumber: number) => void;
}

function renderHeadingWithStatus(
  line: string,
  key: string,
  headingLevel: number,
  ctx?: RenderContext
) {
  const isTopLevel = headingLevel === 1;
  const isDeep = headingLevel >= 3;
  const baseMt = isTopLevel ? "mt-2" : "mt-1";
  const baseBright = isTopLevel ? "phosphor-glow-bright" : "phosphor-glow";

  const hasTodo = line.includes("TODO");
  const hasDone = line.includes("DONE");
  const clickable = ctx?.onToggleStatus && ctx?.fileName;

  if (hasTodo) {
    const parts = line.split("TODO");
    return (
      <div key={key} className={`font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold ${baseMt} ${baseBright}`}>
        {parts[0]}
        <span
          className={`text-org-todo font-bold phosphor-glow-bright ${clickable ? "cursor-pointer hover:underline" : ""}`}
          onClick={clickable ? () => ctx.onToggleStatus!(ctx.fileName!, ctx.lineNumber!) : undefined}
          data-testid={clickable ? `toggle-status-${ctx!.lineNumber}` : undefined}
        >TODO</span>
        {parts[1]}
      </div>
    );
  }

  if (hasDone) {
    const parts = line.split("DONE");
    return (
      <div key={key} className={`font-mono whitespace-pre-wrap min-h-[1.4em] text-muted-foreground font-bold ${baseMt} phosphor-glow-dim`}>
        {parts[0]}
        <span
          className={`font-bold ${clickable ? "cursor-pointer hover:underline" : ""}`}
          onClick={clickable ? () => ctx.onToggleStatus!(ctx.fileName!, ctx.lineNumber!) : undefined}
          data-testid={clickable ? `toggle-status-${ctx!.lineNumber}` : undefined}
        >DONE</span>
        {parts[1]}
      </div>
    );
  }

  return (
    <div key={key} className={`font-mono whitespace-pre-wrap min-h-[1.4em] text-foreground font-bold ${baseMt} ${baseBright}`}>
      {line}
    </div>
  );
}

export function renderOrgContent(text: string, keyPrefix: string = "", ctx?: RenderContext) {
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
    } else if (/^\*+\s/.test(line)) {
      const stars = line.match(/^(\*+)\s/)![1].length;
      return renderHeadingWithStatus(line, key, stars, ctx);
    } else if (/\[\[.*\]\]/.test(line)) {
      const match = line.match(/\[\[(.*)\]\]/);
      const linkContent = match ? match[1] : "";
      return (
        <div key={key} className="font-mono whitespace-pre-wrap min-h-[1.4em] phosphor-glow-dim">
          <span
            className="text-foreground underline underline-offset-2 cursor-pointer hover:phosphor-glow transition-colors w-fit"
            title={linkContent}
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
