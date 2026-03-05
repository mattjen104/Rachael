import React from "react";
import { FileText } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useOrgFiles } from "@/hooks/use-org-data";
import { renderOrgContent } from "./OrgRenderer";

interface UnifiedViewProps {
  onNavigateToFile: (fileName: string) => void;
}

export default function UnifiedView({ onNavigateToFile }: UnifiedViewProps) {
  const { data: orgFiles = [], isLoading } = useOrgFiles();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground font-mono phosphor-glow-dim">
        Loading files...
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

  return (
    <div className="flex-1 w-full h-full flex flex-col font-mono text-sm bg-background" data-testid="unified-view">
      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto p-4 pb-32">
          {orgFiles.map((file, fileIdx) => (
            <div key={file.id} className={fileIdx > 0 ? "mt-8" : ""} data-testid={`unified-section-${file.name}`}>
              <button
                onClick={() => onNavigateToFile(file.name)}
                className="group flex items-center gap-2 mb-3 text-muted-foreground hover:text-primary transition-colors w-full"
                data-testid={`unified-header-${file.name}`}
              >
                <FileText className="w-3.5 h-3.5 flex-shrink-0" />
                <span className="text-xs font-bold uppercase tracking-wider phosphor-glow-dim group-hover:phosphor-glow">
                  {file.name}
                </span>
                <div className="flex-1 h-px bg-border ml-2" />
                <span className="text-[9px] opacity-0 group-hover:opacity-100 transition-opacity">
                  edit →
                </span>
              </button>
              <div className="pl-2 border-l border-border/50">
                {renderOrgContent(file.content, `${file.name}-`)}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
