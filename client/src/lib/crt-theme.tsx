import React, { createContext, useContext, useState, useCallback } from "react";

export const PHOSPHOR_PROFILES = {
  amber: {
    label: "Default Amber",
    fontColor: "#ff8100",
    bright: "#ffc940",
    normal: "#ff8100",
    dim: "#aa5500",
    faint: "#663300",
    glow: "255, 129, 0",
    bg: "#0c0800",
    bgPanel: "#0a0600",
    bgInput: "#100a00",
    borderColor: "#2a1a00",
    borderActive: "#ff810044",
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
    normal: "#0ccc68",
    dim: "#088844",
    faint: "#044422",
    glow: "12, 204, 104",
    bg: "#000c04",
    bgPanel: "#000a03",
    bgInput: "#001008",
    borderColor: "#002a10",
    borderActive: "#0ccc6844",
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
    normal: "#7fb4ff",
    dim: "#4477aa",
    faint: "#223855",
    glow: "127, 180, 255",
    bg: "#000410",
    bgPanel: "#00030c",
    bgInput: "#000614",
    borderColor: "#001a3a",
    borderActive: "#7fb4ff44",
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

export type ThemeKey = keyof typeof PHOSPHOR_PROFILES;
export type PhosphorProfile = typeof PHOSPHOR_PROFILES[ThemeKey];

interface CrtThemeContext {
  theme: ThemeKey;
  t: PhosphorProfile;
  setTheme: (k: ThemeKey) => void;
  cycleTheme: () => void;
}

const Ctx = createContext<CrtThemeContext>({
  theme: "amber",
  t: PHOSPHOR_PROFILES.amber,
  setTheme: () => {},
  cycleTheme: () => {},
});

export function CrtThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<ThemeKey>(() => {
    try {
      const saved = localStorage.getItem("crt-theme");
      if (saved && saved in PHOSPHOR_PROFILES) return saved as ThemeKey;
    } catch {}
    return "amber";
  });

  const handleSetTheme = useCallback((k: ThemeKey) => {
    setTheme(k);
    try { localStorage.setItem("crt-theme", k); } catch {}
  }, []);

  const keys: ThemeKey[] = ["amber", "green", "blue"];
  const cycleTheme = useCallback(() => {
    setTheme(prev => {
      const next = keys[(keys.indexOf(prev) + 1) % keys.length];
      try { localStorage.setItem("crt-theme", next); } catch {}
      return next;
    });
  }, []);

  return (
    <Ctx.Provider value={{ theme, t: PHOSPHOR_PROFILES[theme], setTheme: handleSetTheme, cycleTheme }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCrtTheme() {
  return useContext(Ctx);
}
