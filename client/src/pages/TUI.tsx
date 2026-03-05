import React, { useState, useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, Smartphone } from "lucide-react";
import { useOrgAgenda, useToggleOrgStatus } from "@/hooks/use-org-data";

const PHOSPHOR_THEMES = {
  green: {
    label: "Green",
    bright: "#33ff33",
    mid: "#66ff66",
    dim: "#22aa22",
    glow: "51, 255, 51",
    glass: "51, 255, 51",
  },
  amber: {
    label: "Amber",
    bright: "#ffb000",
    mid: "#ffc940",
    dim: "#aa7700",
    glow: "255, 176, 0",
    glass: "255, 176, 0",
  },
  white: {
    label: "White",
    bright: "#e0e0e0",
    mid: "#ffffff",
    dim: "#888888",
    glow: "224, 224, 224",
    glass: "200, 200, 220",
  },
} as const;

type ThemeKey = keyof typeof PHOSPHOR_THEMES;

function buildCrtStyles(t: typeof PHOSPHOR_THEMES[ThemeKey]): string {
  return `
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
      0%, 100% { text-shadow: 0 0 4px ${t.bright}, 0 0 8px rgba(${t.glow}, 0.4); }
      50% { text-shadow: 0 0 6px ${t.bright}, 0 0 12px rgba(${t.glow}, 0.5), 0 0 2px ${t.mid}; }
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
        rgba(${t.glow}, 0.04),
        transparent
      );
      animation: scanline-scroll 6s linear infinite;
      pointer-events: none;
      z-index: 4;
    }

    .crt-text {
      color: ${t.bright};
      text-shadow: 0 0 4px ${t.bright}, 0 0 8px rgba(${t.glow}, 0.4);
      animation: text-glow-pulse 4s ease-in-out infinite;
    }

    .crt-text-selected {
      color: ${t.mid};
      text-shadow: 0 0 6px ${t.mid}, 0 0 12px rgba(${t.glow}, 0.5), 0 0 20px rgba(${t.glow}, 0.25);
    }

    .crt-text-dim {
      color: ${t.dim};
      text-shadow: 0 0 3px rgba(${t.glow}, 0.5), 0 0 6px rgba(${t.glow}, 0.25);
    }

    .crt-bezel {
      background: linear-gradient(145deg, #1a1a1a 0%, #111 50%, #0d0d0d 100%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,0.03),
        inset 0 -1px 0 rgba(0,0,0,0.5),
        0 0 30px rgba(${t.glow}, 0.06),
        0 0 60px rgba(${t.glow}, 0.03),
        0 8px 32px rgba(0,0,0,0.8);
    }

    .crt-glass {
      background: radial-gradient(
        ellipse at 40% 30%,
        rgba(${t.glass}, 0.02) 0%,
        #000 70%
      );
      box-shadow:
        inset 0 0 20px rgba(0, 0, 0, 0.8),
        inset 0 0 4px rgba(${t.glass}, 0.05);
      border: 1px solid #1a1a1a;
    }
  `;
}

export default function TUI() {
  const { data: agenda } = useOrgAgenda();
  const toggleMutation = useToggleOrgStatus();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [theme, setTheme] = useState<ThemeKey>("green");

  const t = PHOSPHOR_THEMES[theme];

  const displayItems: { type: "header" | "task"; text: string; status?: string; fileName?: string; lineNumber?: number }[] = [];

  if (agenda) {
    if (agenda.overdue.length > 0) {
      for (const day of agenda.overdue) {
        displayItems.push({ type: "header", text: `${day.label} (carry)` });
        day.items.forEach(item => {
          displayItems.push({ type: "task", text: item.title, status: item.status || "TODO", fileName: item.sourceFile, lineNumber: item.lineNumber });
        });
      }
    }

    if (agenda.today.items.length > 0) {
      displayItems.push({ type: "header", text: `${agenda.today.label}` });
      agenda.today.items.forEach(item => {
        displayItems.push({ type: "task", text: item.title, status: item.status || "TODO", fileName: item.sourceFile, lineNumber: item.lineNumber });
      });
    }

    if (agenda.upcoming.length > 0) {
      displayItems.push({ type: "header", text: "Upcoming" });
      for (const day of agenda.upcoming) {
        day.items.forEach(item => {
          displayItems.push({ type: "task", text: item.title, status: item.status || "TODO", fileName: item.sourceFile, lineNumber: item.lineNumber });
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

  const themeKeys: ThemeKey[] = ["green", "amber", "white"];

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0a0a0a] items-center justify-center font-sans relative">
      <style>{buildCrtStyles(t)}</style>

      <Link href="/" className="absolute top-6 left-6 flex items-center gap-2 transition-colors font-mono text-xs" style={{ color: `${t.dim}99` }} data-testid="link-back">
        <ArrowLeft className="w-3 h-3" />
        ../workspace
      </Link>

      <div className="absolute top-6 right-6 flex items-center gap-1" data-testid="theme-toggle">
        {themeKeys.map(k => (
          <button
            key={k}
            onClick={() => setTheme(k)}
            className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded transition-all"
            style={{
              color: theme === k ? PHOSPHOR_THEMES[k].bright : `${PHOSPHOR_THEMES[k].dim}66`,
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: theme === k ? `${PHOSPHOR_THEMES[k].bright}44` : `${PHOSPHOR_THEMES[k].dim}22`,
              background: theme === k ? `rgba(${PHOSPHOR_THEMES[k].glow}, 0.08)` : "transparent",
              textShadow: theme === k ? `0 0 6px ${PHOSPHOR_THEMES[k].bright}88` : "none",
            }}
            data-testid={`theme-btn-${k}`}
          >
            {PHOSPHOR_THEMES[k].label}
          </button>
        ))}
      </div>

      <div className="text-center mb-8">
        <h1 className="text-xl font-bold flex items-center justify-center gap-2 mb-2 font-mono" style={{ color: `${t.bright}cc`, textShadow: `0 0 8px ${t.bright}44` }}>
          <Smartphone className="w-5 h-5" />
          LilyGO T-Keyboard
        </h1>
        <p className="text-xs font-mono" style={{ color: `${t.dim}80` }}>
          <kbd className="px-1.5 py-0.5 rounded text-[10px] mx-0.5" style={{ borderWidth: "1px", borderStyle: "solid", borderColor: `${t.bright}33`, color: `${t.bright}99` }}>W</kbd>
          <kbd className="px-1.5 py-0.5 rounded text-[10px] mx-0.5" style={{ borderWidth: "1px", borderStyle: "solid", borderColor: `${t.bright}33`, color: `${t.bright}99` }}>S</kbd>
          {" nav "}
          <span className="mx-2" style={{ color: `${t.bright}33` }}>│</span>
          <kbd className="px-1.5 py-0.5 rounded text-[10px] mx-0.5" style={{ borderWidth: "1px", borderStyle: "solid", borderColor: `${t.bright}33`, color: `${t.bright}99` }}>D</kbd>
          {" toggle"}
        </p>
      </div>

      <div className="crt-bezel p-6 rounded-lg flex flex-col items-center">
        <div
          className="crt-glass crt-screen overflow-hidden flex flex-col rounded-sm"
          style={{
            width: "24.1mm",
            height: "6.0mm",
          }}
        >
          <div className="crt-scanline-bar" />
          <div
            className="whitespace-nowrap overflow-hidden font-mono leading-none tracking-tight w-full h-full"
            style={{
              fontSize: "2.85mm",
              lineHeight: "3mm",
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
          <div className="w-full h-px mb-1" style={{ background: `linear-gradient(to right, transparent, ${t.bright}33, transparent)` }} />
          <div className="text-[9px] uppercase tracking-[0.2em] font-mono" style={{ color: `${t.bright}4d` }}>BB Q10 Keyboard</div>
          <div className="grid grid-cols-10 gap-[2px] w-full">
            {"QWERTYUIOP".split("").map((k, i) => (
              <div key={`r1-${i}`} className="h-[14px] bg-[#1a1a1a] rounded-[1px] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] font-mono" style={{ color: `${t.bright}26` }}>{k}</span>
              </div>
            ))}
            {"ASDFGHJKL_".split("").map((k, i) => (
              <div key={`r2-${i}`} className="h-[14px] bg-[#1a1a1a] rounded-[1px] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] font-mono" style={{ color: `${t.bright}26` }}>{k === "_" ? "\u23CE" : k}</span>
              </div>
            ))}
            {"\u21E7ZXCVBNM\u232B.".split("").map((k, i) => (
              <div key={`r3-${i}`} className="h-[14px] bg-[#1a1a1a] rounded-[1px] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] font-mono" style={{ color: `${t.bright}26` }}>{k}</span>
              </div>
            ))}
          </div>
          <div className="w-[60%] h-[10px] bg-[#1a1a1a] rounded-[2px] border border-[#222] mt-[2px]" />
        </div>
      </div>
    </div>
  );
}
