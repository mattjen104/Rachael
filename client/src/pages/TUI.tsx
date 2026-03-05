import React, { useState, useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, Smartphone } from "lucide-react";
import { useOrgAgenda, useToggleOrgStatus } from "@/hooks/use-org-data";

export default function TUI() {
  const { data: agenda } = useOrgAgenda();
  const toggleMutation = useToggleOrgStatus();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const displayItems: { type: "header" | "task"; text: string; status?: string; fileName?: string; lineNumber?: number }[] = [];

  if (agenda) {
    if (agenda.overdue.length > 0) {
      for (const day of agenda.overdue) {
        displayItems.push({ type: "header", text: `${day.label} (carry)` });
        day.items.forEach(t => {
          displayItems.push({ type: "task", text: t.title, status: t.status || "TODO", fileName: t.sourceFile, lineNumber: t.lineNumber });
        });
      }
    }

    if (agenda.today.items.length > 0) {
      displayItems.push({ type: "header", text: `${agenda.today.label}` });
      agenda.today.items.forEach(t => {
        displayItems.push({ type: "task", text: t.title, status: t.status || "TODO", fileName: t.sourceFile, lineNumber: t.lineNumber });
      });
    }

    if (agenda.upcoming.length > 0) {
      displayItems.push({ type: "header", text: "Upcoming" });
      for (const day of agenda.upcoming) {
        day.items.forEach(t => {
          displayItems.push({ type: "task", text: t.title, status: t.status || "TODO", fileName: t.sourceFile, lineNumber: t.lineNumber });
        });
      }
    }
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
        if (item && item.type === "task" && item.fileName && item.lineNumber) {
          toggleMutation.mutate({ fileName: item.fileName, lineNumber: item.lineNumber });
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
    <div className="flex flex-col h-screen w-screen bg-[#0a0a0a] items-center justify-center font-sans relative">
      <style>{`
        @keyframes crt-flicker {
          0% { opacity: 0.97; }
          5% { opacity: 1; }
          10% { opacity: 0.98; }
          15% { opacity: 1; }
          50% { opacity: 1; }
          80% { opacity: 0.96; }
          85% { opacity: 1; }
          100% { opacity: 0.98; }
        }

        @keyframes scanline-scroll {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100%); }
        }

        @keyframes text-glow-pulse {
          0%, 100% { text-shadow: 0 0 4px #33ff33, 0 0 8px #33ff3366; }
          50% { text-shadow: 0 0 6px #33ff33, 0 0 12px #33ff3388, 0 0 2px #66ff66; }
        }

        .crt-screen {
          animation: crt-flicker 8s infinite;
          position: relative;
        }

        .crt-screen::before {
          content: "";
          position: absolute;
          inset: 0;
          background: repeating-linear-gradient(
            0deg,
            transparent,
            transparent 1px,
            rgba(0, 0, 0, 0.15) 1px,
            rgba(0, 0, 0, 0.15) 2px
          );
          pointer-events: none;
          z-index: 2;
        }

        .crt-screen::after {
          content: "";
          position: absolute;
          inset: 0;
          background: radial-gradient(
            ellipse at center,
            transparent 60%,
            rgba(0, 0, 0, 0.35) 100%
          );
          pointer-events: none;
          z-index: 3;
        }

        .crt-scanline-bar {
          position: absolute;
          left: 0;
          right: 0;
          height: 4px;
          background: linear-gradient(
            180deg,
            transparent,
            rgba(51, 255, 51, 0.04),
            transparent
          );
          animation: scanline-scroll 6s linear infinite;
          pointer-events: none;
          z-index: 4;
        }

        .crt-text {
          color: #33ff33;
          text-shadow: 0 0 4px #33ff33, 0 0 8px #33ff3366;
          animation: text-glow-pulse 4s ease-in-out infinite;
        }

        .crt-text-selected {
          color: #66ff66;
          text-shadow: 0 0 6px #66ff66, 0 0 12px #33ff3388, 0 0 20px #33ff3344;
        }

        .crt-text-dim {
          color: #22aa22;
          text-shadow: 0 0 3px #22aa2288, 0 0 6px #22aa2244;
        }

        .crt-bezel {
          background: linear-gradient(145deg, #1a1a1a 0%, #111 50%, #0d0d0d 100%);
          box-shadow:
            inset 0 1px 0 rgba(255,255,255,0.03),
            inset 0 -1px 0 rgba(0,0,0,0.5),
            0 0 30px rgba(51, 255, 51, 0.06),
            0 0 60px rgba(51, 255, 51, 0.03),
            0 8px 32px rgba(0,0,0,0.8);
        }

        .crt-glass {
          background: radial-gradient(
            ellipse at 40% 30%,
            rgba(51, 255, 51, 0.02) 0%,
            #000 70%
          );
          box-shadow:
            inset 0 0 20px rgba(0, 0, 0, 0.8),
            inset 0 0 4px rgba(51, 255, 51, 0.05);
          border: 1px solid #1a1a1a;
        }
      `}</style>

      <Link href="/" className="absolute top-6 left-6 flex items-center gap-2 text-[#22aa22]/60 hover:text-[#33ff33] transition-colors font-mono text-xs" data-testid="link-back">
        <ArrowLeft className="w-3 h-3" />
        ../workspace
      </Link>

      <div className="text-center mb-8">
        <h1 className="text-xl font-bold text-[#33ff33]/80 flex items-center justify-center gap-2 mb-2 font-mono" style={{ textShadow: "0 0 8px #33ff3344" }}>
          <Smartphone className="w-5 h-5" />
          LilyGO T-Keyboard
        </h1>
        <p className="text-[#22aa22]/50 text-xs font-mono">
          <kbd className="border border-[#33ff33]/20 px-1.5 py-0.5 rounded text-[10px] text-[#33ff33]/60 mx-0.5">W</kbd>
          <kbd className="border border-[#33ff33]/20 px-1.5 py-0.5 rounded text-[10px] text-[#33ff33]/60 mx-0.5">S</kbd>
          nav
          <span className="mx-2 text-[#33ff33]/20">│</span>
          <kbd className="border border-[#33ff33]/20 px-1.5 py-0.5 rounded text-[10px] text-[#33ff33]/60 mx-0.5">D</kbd>
          toggle
        </p>
      </div>

      <div className="crt-bezel p-6 rounded-lg flex flex-col items-center">
        <div
          className="crt-glass crt-screen overflow-hidden flex flex-col rounded-sm"
          style={{
            width: "160px",
            height: "40px",
            transform: "scale(3)",
            transformOrigin: "center top",
            marginBottom: "80px",
          }}
        >
          <div className="crt-scanline-bar" />
          <div
            className="whitespace-nowrap overflow-hidden font-mono leading-none tracking-tight"
            style={{
              fontSize: "16px",
              lineHeight: "20px",
              width: "160px",
            }}
          >
            <div className="truncate w-full crt-text crt-text-selected" data-testid="tui-line-1">
              {renderLine(currentItem, true)}
            </div>
            <div className="truncate w-full crt-text crt-text-dim" data-testid="tui-line-2">
              {renderLine(nextItem, false)}
            </div>
          </div>
        </div>

        <div className="mt-6 opacity-40 flex flex-col items-center gap-2 w-full max-w-[240px]">
          <div className="w-full h-px bg-gradient-to-r from-transparent via-[#33ff33]/20 to-transparent mb-1" />
          <div className="text-[9px] text-[#33ff33]/30 uppercase tracking-[0.2em] font-mono">BB Q10 Keyboard</div>
          <div className="grid grid-cols-10 gap-[2px] w-full">
            {"QWERTYUIOP".split("").map((k, i) => (
              <div key={`r1-${i}`} className="h-[14px] bg-[#1a1a1a] rounded-[1px] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] text-[#33ff33]/15 font-mono">{k}</span>
              </div>
            ))}
            {"ASDFGHJKL_".split("").map((k, i) => (
              <div key={`r2-${i}`} className="h-[14px] bg-[#1a1a1a] rounded-[1px] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] text-[#33ff33]/15 font-mono">{k === "_" ? "⏎" : k}</span>
              </div>
            ))}
            {"⇧ZXCVBNM⌫.".split("").map((k, i) => (
              <div key={`r3-${i}`} className="h-[14px] bg-[#1a1a1a] rounded-[1px] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] text-[#33ff33]/15 font-mono">{k}</span>
              </div>
            ))}
          </div>
          <div className="w-[60%] h-[10px] bg-[#1a1a1a] rounded-[2px] border border-[#222] mt-[2px]" />
        </div>
      </div>
    </div>
  );
}
