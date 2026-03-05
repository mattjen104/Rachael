import React, { useState, useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, Smartphone } from "lucide-react";
import { useAgendaItems, useToggleAgendaStatus, useCarryOverTasks } from "@/hooks/use-org-data";

export default function TUI() {
  const { data: agendaItems = [] } = useAgendaItems();
  const toggleMutation = useToggleAgendaStatus();
  const carryOverMutation = useCarryOverTasks();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    carryOverMutation.mutate();
  }, []);

  const today = new Date().toISOString().split("T")[0];

  const displayItems: { id: number | null; type: "header" | "task"; text: string; status?: string; carriedOver?: boolean }[] = [];

  const todayTasks = agendaItems.filter(t => t.scheduledDate === today);
  const futureTasks = agendaItems.filter(t => t.scheduledDate > today);

  if (todayTasks.length > 0) {
    displayItems.push({ id: null, type: "header", text: `${today} Today` });
    todayTasks.forEach(t => {
      displayItems.push({ id: t.id, type: "task", text: `${t.carriedOver ? "[Carried] " : ""}${t.text}`, status: t.status, carriedOver: t.carriedOver });
    });
  }

  if (futureTasks.length > 0) {
    displayItems.push({ id: null, type: "header", text: "Upcoming" });
    futureTasks.forEach(t => {
      displayItems.push({ id: t.id, type: "task", text: t.text, status: t.status });
    });
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();

      if (key === "s") {
        setSelectedIndex(prev => Math.min(prev + 1, displayItems.length - 1));
      } else if (key === "w") {
        setSelectedIndex(prev => Math.max(prev - 1, 0));
      } else if (key === "d" || key === "enter") {
        const item = displayItems[selectedIndex];
        if (item && item.type === "task" && item.id !== null) {
          const newStatus = item.status === "DONE" ? "TODO" : "DONE";
          toggleMutation.mutate({ id: item.id, status: newStatus });
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, displayItems]);

  const currentItem = displayItems[selectedIndex];
  const nextItem = displayItems[selectedIndex + 1];

  const renderLine = (item: typeof displayItems[0] | undefined, isSelected: boolean) => {
    if (!item) return "\u00A0";
    let prefix = "";
    if (item.type === "header") prefix = "# ";
    if (item.type === "task") prefix = item.status === "DONE" ? "[x] " : "[ ] ";

    const text = prefix + item.text;
    return isSelected ? `> ${text}` : `  ${text}`;
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#1e1e1e] items-center justify-center font-sans relative">
      <Link href="/" className="absolute top-6 left-6 flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors" data-testid="link-back">
        <ArrowLeft className="w-4 h-4" />
        Back to Workspace
      </Link>

      <div className="text-center mb-8">
        <h1 className="text-2xl font-bold text-white flex items-center justify-center gap-2 mb-2">
          <Smartphone className="w-6 h-6" />
          LilyGO T-Keyboard SSH Sim
        </h1>
        <p className="text-muted-foreground text-sm">
          Use <kbd className="bg-muted px-1 py-0.5 rounded text-xs mx-1">W</kbd>
          <kbd className="bg-muted px-1 py-0.5 rounded text-xs mx-1">S</kbd> to navigate,
          <kbd className="bg-muted px-1 py-0.5 rounded text-xs mx-1">D</kbd> to toggle
        </p>
      </div>

      <div className="bg-[#2a2a2a] p-8 rounded-xl shadow-2xl border border-[#333] flex flex-col items-center">
        <div
          className="bg-black border-2 border-[#111] overflow-hidden flex flex-col"
          style={{
            width: "160px",
            height: "40px",
            transform: "scale(2)",
            transformOrigin: "center top",
            marginBottom: "40px",
          }}
        >
          <div
            className="text-white whitespace-nowrap overflow-hidden font-mono leading-none tracking-tight"
            style={{
              fontSize: "16px",
              lineHeight: "20px",
              width: "160px",
            }}
          >
            <div className="truncate w-full bg-black text-[#51afef]" data-testid="tui-line-1">
              {renderLine(currentItem, true)}
            </div>
            <div className="truncate w-full bg-black text-[#bbc2cf]" data-testid="tui-line-2">
              {renderLine(nextItem, false)}
            </div>
          </div>
        </div>

        <div className="mt-8 opacity-50 flex flex-col items-center gap-2 w-full max-w-[200px]">
          <div className="w-full h-px bg-gradient-to-r from-transparent via-[#444] to-transparent mb-2" />
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Blackberry Keyboard</div>
          <div className="grid grid-cols-4 gap-1 w-full">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className="h-4 bg-[#333] rounded-[2px]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
