import React, { useState, useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, Smartphone } from "lucide-react";

// Mock data representing the Agenda / Bullet Journal
const agendaData = [
  { id: 1, type: "header", text: "2026-03-04 Today" },
  { id: 2, type: "task", status: "TODO", text: "[Carried] Fix CSS" },
  { id: 3, type: "task", status: "TODO", text: "Process photos" },
  { id: 4, type: "task", status: "DONE", text: "Review memo" },
  { id: 5, type: "header", text: "2026-03-05 Tomorrow" },
  { id: 6, type: "task", status: "TODO", text: "Build TUI" },
];

export default function TUI() {
  const [selectedIndex, setSelectedIndex] = useState(1); // Start on first task
  const [isTyping, setIsTyping] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isTyping) return;
      
      const key = e.key.toLowerCase();
      
      if (key === 's') { // Down
        setSelectedIndex((prev) => Math.min(prev + 1, agendaData.length - 1));
      } else if (key === 'w') { // Up
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (key === 'd') { // Right / Enter
        // Toggle task or expand
        console.log("Interact with", agendaData[selectedIndex]);
      } else if (key === 'a') { // Left / Back
        // Go back up the tree
        console.log("Go back");
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, isTyping]);

  // Determine what two lines to show
  // We want to show the selected item. If it's a task, maybe show its parent header on line 1, and the task on line 2.
  // Or just show selectedItem on line 1, and next item on line 2.
  // The user says: "40 x 160 with a 16 pixel font size so that means two lines"
  
  const currentItem = agendaData[selectedIndex];
  const nextItem = agendaData[selectedIndex + 1];

  const renderLine = (item: typeof agendaData[0] | undefined, isSelected: boolean) => {
    if (!item) return "";
    let prefix = "";
    if (item.type === "header") prefix = "▼ ";
    if (item.type === "task") prefix = item.status === "DONE" ? "[x] " : "[ ] ";
    
    const text = prefix + item.text;
    return isSelected ? `> ${text}` : `  ${text}`;
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-[#1e1e1e] items-center justify-center font-sans relative">
      <Link href="/" className="absolute top-6 left-6 flex items-center gap-2 text-muted-foreground hover:text-primary transition-colors">
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
          <kbd className="bg-muted px-1 py-0.5 rounded text-xs mx-1">A</kbd> 
          <kbd className="bg-muted px-1 py-0.5 rounded text-xs mx-1">S</kbd> 
          <kbd className="bg-muted px-1 py-0.5 rounded text-xs mx-1">D</kbd> to navigate
        </p>
      </div>

      {/* Hardware Bezel Mockup */}
      <div className="bg-[#2a2a2a] p-8 rounded-xl shadow-2xl border border-[#333] flex flex-col items-center">
        {/* The Screen (160x40 logical pixels) */}
        <div 
          className="bg-black border-2 border-[#111] overflow-hidden flex flex-col"
          style={{ 
            width: "160px", 
            height: "40px", 
            // We scale it up with transform so it's easier to see on desktop, 
            // but the aspect ratio and constraint remains exactly 160x40 logical.
            transform: "scale(2)",
            transformOrigin: "center top",
            marginBottom: "40px" // compensate for scale
          }}
        >
          <div 
            className="text-white whitespace-nowrap overflow-hidden font-mono leading-none tracking-tight"
            style={{ 
              fontSize: "16px",
              lineHeight: "20px",
              width: "160px"
            }}
          >
            <div className="truncate w-full bg-black text-[#51afef]">
              {renderLine(currentItem, true)}
            </div>
            <div className="truncate w-full bg-black text-[#bbc2cf]">
              {renderLine(nextItem, false)}
            </div>
          </div>
        </div>
        
        {/* Mock Keyboard area */}
        <div className="mt-8 opacity-50 flex flex-col items-center gap-2 w-full max-w-[200px]">
          <div className="w-full h-px bg-gradient-to-r from-transparent via-[#444] to-transparent mb-2" />
          <div className="text-[10px] text-muted-foreground uppercase tracking-widest">Blackberry Keyboard</div>
          <div className="grid grid-cols-4 gap-1 w-full">
             {Array.from({length: 12}).map((_, i) => (
                <div key={i} className="h-4 bg-[#333] rounded-[2px]" />
             ))}
          </div>
        </div>
      </div>
    </div>
  );
}
