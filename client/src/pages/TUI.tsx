import React, { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useOrgAgenda, useToggleOrgStatus } from "@/hooks/use-org-data";
import { useCrtTheme, type ThemeKey } from "@/lib/crt-theme";

const PHOSPHOR_THEMES = {
  amber: {
    label: "Default Amber",
    fontColor: "#ff8100",
    bright: "#ffc940",
    dim: "#aa5500",
    glow: "255, 129, 0",
    frameColor: "#cfcfcf",
    bloom: 0.6,
    burnIn: 0.3,
    staticNoise: 0.1,
    screenCurvature: 0.2,
    jitter: 0.2,
    glowingLine: 0.2,
    horizontalSync: 0.1,
    flickering: 0.1,
    ambientLight: 0.3,
    chromaColor: 0.2,
    frameShininess: 0.3,
  },
  green: {
    label: "Mono Green",
    fontColor: "#0ccc68",
    bright: "#33ff88",
    dim: "#088844",
    glow: "12, 204, 104",
    frameColor: "#d4d4d4",
    bloom: 0.5,
    burnIn: 0.3,
    staticNoise: 0.1,
    screenCurvature: 0.3,
    jitter: 0.2,
    glowingLine: 0.2,
    horizontalSync: 0.1,
    flickering: 0.1,
    ambientLight: 0.3,
    chromaColor: 0.0,
    frameShininess: 0.1,
  },
  blue: {
    label: "Deep Blue",
    fontColor: "#7fb4ff",
    bright: "#a0ccff",
    dim: "#4477aa",
    glow: "127, 180, 255",
    frameColor: "#ffffff",
    bloom: 0.6,
    burnIn: 0.3,
    staticNoise: 0.1,
    screenCurvature: 0.4,
    jitter: 0.2,
    glowingLine: 0.2,
    horizontalSync: 0.1,
    flickering: 0.1,
    ambientLight: 0.0,
    chromaColor: 1.0,
    frameShininess: 0.9,
  },
} as const;

type ThemeKey = keyof typeof PHOSPHOR_THEMES;

function buildCrtStyles(t: typeof PHOSPHOR_THEMES[ThemeKey]): string {
  const bloomPx = Math.round(t.bloom * 12);
  const bloomPx2 = Math.round(t.bloom * 20);
  const flickerMin = 1 - t.flickering * 0.15;
  const curvaturePct = Math.round(60 + t.screenCurvature * 30);
  const curvatureVig = (0.35 + t.screenCurvature * 0.3).toFixed(2);
  const jitterPx = (t.jitter * 0.4).toFixed(2);
  const hSyncStrength = (t.horizontalSync * 0.5).toFixed(2);
  const noiseOpacity = (t.staticNoise * 0.3).toFixed(2);
  const glowLineOpacity = (t.glowingLine * 0.08).toFixed(2);
  const ambientGlow = Math.round(t.ambientLight * 80);
  const shineOpacity = (t.frameShininess * 0.15).toFixed(2);

  return `
    @keyframes crt-flicker {
      0% { opacity: ${flickerMin}; }
      3% { opacity: 1; }
      6% { opacity: ${(flickerMin + 0.01).toFixed(2)}; }
      9% { opacity: 1; }
      50% { opacity: 1; }
      75% { opacity: ${(flickerMin + 0.005).toFixed(2)}; }
      80% { opacity: 1; }
      100% { opacity: ${(flickerMin + 0.01).toFixed(2)}; }
    }

    @keyframes scanline-scroll {
      0% { transform: translateY(-100%); }
      100% { transform: translateY(100%); }
    }

    @keyframes text-glow-pulse {
      0%, 100% { text-shadow: 0 0 ${bloomPx}px ${t.fontColor}, 0 0 ${bloomPx2}px rgba(${t.glow}, 0.4); }
      50% { text-shadow: 0 0 ${bloomPx + 2}px ${t.fontColor}, 0 0 ${bloomPx2 + 4}px rgba(${t.glow}, 0.55), 0 0 2px ${t.bright}; }
    }

    @keyframes jitter-x {
      0%, 100% { transform: translateX(0); }
      10% { transform: translateX(${jitterPx}px); }
      30% { transform: translateX(-${jitterPx}px); }
      50% { transform: translateX(${(parseFloat(jitterPx) * 0.5).toFixed(2)}px); }
      70% { transform: translateX(-${(parseFloat(jitterPx) * 0.3).toFixed(2)}px); }
      90% { transform: translateX(${(parseFloat(jitterPx) * 0.2).toFixed(2)}px); }
    }

    @keyframes hsync-glitch {
      0%, 94%, 100% { transform: translateX(0); opacity: 1; }
      95% { transform: translateX(${hSyncStrength}px); opacity: 0.97; }
      96% { transform: translateX(-${(parseFloat(hSyncStrength) * 2).toFixed(1)}px); opacity: 0.95; }
      97% { transform: translateX(${(parseFloat(hSyncStrength) * 1.5).toFixed(1)}px); opacity: 0.98; }
    }

    @keyframes noise-drift {
      0% { background-position: 0 0; }
      100% { background-position: 100px 50px; }
    }

    .crt-screen {
      animation: crt-flicker 8s infinite;
      position: relative;
      overflow: hidden;
    }

    .crt-scanlines {
      position: absolute;
      inset: 0;
      background: repeating-linear-gradient(
        0deg,
        transparent,
        transparent 1px,
        rgba(0, 0, 0, 0.12) 1px,
        rgba(0, 0, 0, 0.12) 2px
      );
      pointer-events: none;
      z-index: 2;
    }

    .crt-vignette {
      position: absolute;
      inset: 0;
      background: radial-gradient(
        ellipse at center,
        transparent ${curvaturePct}%,
        rgba(0, 0, 0, ${curvatureVig}) 100%
      );
      pointer-events: none;
      z-index: 3;
    }

    .crt-noise {
      position: absolute;
      inset: 0;
      opacity: ${noiseOpacity};
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      background-size: 80px 80px;
      animation: noise-drift 0.3s steps(4) infinite;
      pointer-events: none;
      z-index: 5;
      mix-blend-mode: overlay;
    }

    .crt-glow-bar {
      position: absolute;
      left: 0;
      right: 0;
      height: 6px;
      background: linear-gradient(
        180deg,
        transparent,
        rgba(${t.glow}, ${glowLineOpacity}),
        transparent
      );
      animation: scanline-scroll 4s linear infinite;
      pointer-events: none;
      z-index: 4;
    }

    .crt-content {
      animation: jitter-x 0.15s steps(2) infinite, hsync-glitch 12s ease-in-out infinite;
    }

    .crt-text {
      color: ${t.fontColor};
      text-shadow: 0 0 ${bloomPx}px ${t.fontColor}, 0 0 ${bloomPx2}px rgba(${t.glow}, 0.4);
      animation: text-glow-pulse 4s ease-in-out infinite;
    }

    .crt-text-selected {
      color: ${t.bright};
      text-shadow: 0 0 ${bloomPx + 3}px ${t.bright}, 0 0 ${bloomPx2 + 6}px rgba(${t.glow}, 0.5), 0 0 ${bloomPx2 + 12}px rgba(${t.glow}, 0.2);
    }

    .crt-text-dim {
      color: ${t.dim};
      text-shadow: 0 0 ${Math.round(bloomPx * 0.6)}px rgba(${t.glow}, 0.5), 0 0 ${Math.round(bloomPx2 * 0.5)}px rgba(${t.glow}, 0.2);
    }

    .crt-bezel {
      background: linear-gradient(145deg, #1a1a1a 0%, #111 50%, #0d0d0d 100%);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,${shineOpacity}),
        inset 0 -1px 0 rgba(0,0,0,0.5),
        0 0 ${ambientGlow}px rgba(${t.glow}, 0.04),
        0 0 ${ambientGlow * 2}px rgba(${t.glow}, 0.02),
        0 8px 32px rgba(0,0,0,0.8);
    }

    .crt-glass {
      background: radial-gradient(
        ellipse at 35% 25%,
        rgba(${t.glow}, 0.015) 0%,
        #000 70%
      );
      box-shadow:
        inset 0 0 20px rgba(0, 0, 0, 0.8),
        inset 0 0 4px rgba(${t.glow}, 0.04);
      border: 1px solid #1a1a1a;
      border-radius: ${Math.round(1 + t.screenCurvature * 3)}px;
    }

    .crt-shine {
      position: absolute;
      inset: 0;
      background: linear-gradient(
        135deg,
        rgba(255, 255, 255, ${(t.frameShininess * 0.06).toFixed(3)}) 0%,
        transparent 40%
      );
      pointer-events: none;
      z-index: 6;
      border-radius: inherit;
    }
  `;
}

export default function TUI() {
  const { data: agenda } = useOrgAgenda();
  const toggleMutation = useToggleOrgStatus();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const { theme, setTheme } = useCrtTheme();

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

  const themeKeys: ThemeKey[] = ["amber", "green", "blue"];

  return (
    <div className="flex flex-col h-screen w-screen bg-[#0a0a0a] items-center justify-center font-sans relative">
      <style>{buildCrtStyles(t)}</style>

      <Link href="/" className="absolute top-6 left-6 flex items-center gap-2 transition-colors font-mono text-xs" style={{ color: `${t.dim}99` }} data-testid="link-back">
        <span>←</span>
        ../workspace
      </Link>

      <div className="absolute top-6 right-6 flex items-center gap-1" data-testid="theme-toggle">
        {themeKeys.map(k => (
          <button
            key={k}
            onClick={() => setTheme(k)}
            className="font-mono text-[10px] uppercase tracking-wider px-2 py-1 transition-all"
            style={{
              color: theme === k ? PHOSPHOR_THEMES[k].fontColor : `${PHOSPHOR_THEMES[k].dim}66`,
              borderWidth: "1px",
              borderStyle: "solid",
              borderColor: theme === k ? `${PHOSPHOR_THEMES[k].fontColor}44` : `${PHOSPHOR_THEMES[k].dim}22`,
              background: theme === k ? `rgba(${PHOSPHOR_THEMES[k].glow}, 0.08)` : "transparent",
              textShadow: theme === k ? `0 0 6px ${PHOSPHOR_THEMES[k].fontColor}88` : "none",
            }}
            data-testid={`theme-btn-${k}`}
          >
            {PHOSPHOR_THEMES[k].label}
          </button>
        ))}
      </div>

      <div className="text-center mb-8">
        <h1 className="text-xl font-bold flex items-center justify-center gap-2 mb-2 font-mono" style={{ color: `${t.fontColor}cc`, textShadow: `0 0 8px ${t.fontColor}44` }}>
          <span>▯</span>
          LilyGO T-Keyboard
        </h1>
        <p className="text-xs font-mono" style={{ color: `${t.dim}80` }}>
          <kbd className="px-1.5 py-0.5 text-[10px] mx-0.5" style={{ borderWidth: "1px", borderStyle: "solid", borderColor: `${t.fontColor}33`, color: `${t.fontColor}99` }}>W</kbd>
          <kbd className="px-1.5 py-0.5 text-[10px] mx-0.5" style={{ borderWidth: "1px", borderStyle: "solid", borderColor: `${t.fontColor}33`, color: `${t.fontColor}99` }}>S</kbd>
          {" nav "}
          <span className="mx-2" style={{ color: `${t.fontColor}33` }}>{"\u2502"}</span>
          <kbd className="px-1.5 py-0.5 text-[10px] mx-0.5" style={{ borderWidth: "1px", borderStyle: "solid", borderColor: `${t.fontColor}33`, color: `${t.fontColor}99` }}>D</kbd>
          {" toggle"}
        </p>
      </div>

      <div className="crt-bezel p-6 flex flex-col items-center">
        <div
          className="crt-glass crt-screen overflow-hidden flex flex-col"
          style={{
            width: "48.2mm",
            height: "12.0mm",
          }}
        >
          <div className="crt-scanlines" />
          <div className="crt-vignette" />
          <div className="crt-noise" />
          <div className="crt-glow-bar" />
          <div className="crt-shine" />
          <div
            className="crt-content whitespace-nowrap overflow-hidden font-mono leading-none tracking-tight w-full h-full"
            style={{
              fontSize: "3.2mm",
              lineHeight: "6mm",
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

        <div className="mt-8 opacity-40 flex flex-col items-center gap-2 w-full max-w-[240px]">
          <div className="w-full h-px mb-1" style={{ background: `linear-gradient(to right, transparent, ${t.fontColor}33, transparent)` }} />
          <div className="text-[9px] uppercase tracking-[0.2em] font-mono" style={{ color: `${t.fontColor}4d` }}>BB Q10 Keyboard</div>
          <div className="grid grid-cols-10 gap-[2px] w-full">
            {"QWERTYUIOP".split("").map((k, i) => (
              <div key={`r1-${i}`} className="h-[14px] bg-[#1a1a1a] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] font-mono" style={{ color: `${t.fontColor}26` }}>{k}</span>
              </div>
            ))}
            {"ASDFGHJKL_".split("").map((k, i) => (
              <div key={`r2-${i}`} className="h-[14px] bg-[#1a1a1a] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] font-mono" style={{ color: `${t.fontColor}26` }}>{k === "_" ? "\u23CE" : k}</span>
              </div>
            ))}
            {"\u21E7ZXCVBNM\u232B.".split("").map((k, i) => (
              <div key={`r3-${i}`} className="h-[14px] bg-[#1a1a1a] border border-[#222] flex items-center justify-center">
                <span className="text-[5px] font-mono" style={{ color: `${t.fontColor}26` }}>{k}</span>
              </div>
            ))}
          </div>
          <div className="w-[60%] h-[10px] bg-[#1a1a1a] border border-[#222] mt-[2px]" />
        </div>
      </div>
    </div>
  );
}
