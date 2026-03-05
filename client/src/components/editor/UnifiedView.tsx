import React from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOrgFiles } from "@/hooks/use-org-data";
import { renderOrgContent } from "./OrgRenderer";

export default function OrgBufferView() {
  const { data: orgFiles = [], isLoading } = useOrgFiles();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        Loading...
      </div>
    );
  }

  if (orgFiles.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        No org files found.
      </div>
    );
  }

  const combinedContent = orgFiles
    .map((file) => {
      const lines = file.content.split("\n");
      const bumpedLines = lines.map((line) => {
        if (/^\*+\s/.test(line)) {
          return "*" + line;
        }
        return line;
      });
      return `* ${file.name}\n${bumpedLines.join("\n")}`;
    })
    .join("\n\n");

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono text-sm bg-background" data-testid="org-buffer-view">
      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto p-4 pb-32">
          {renderOrgContent(combinedContent, "org-")}
        </div>
      </ScrollArea>
    </div>
  );
}
