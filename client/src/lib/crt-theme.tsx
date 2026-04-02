import React, { createContext, useContext, useState, useCallback, useEffect } from "react";

export const PHOSPHOR_PROFILES = {
  amber: {
    label: "Amber Terminal",
    fontColor: "#ff8100",
    bright: "#ffc940",
    normal: "#ff8100",
    dim: "#aa5500",
    faint: "#663300",
    glow: "255, 129, 0",
    hsl: {
      bg: "25 30% 5%",
      card: "25 25% 7%",
      cardFg: "35 90% 68%",
      popover: "25 25% 7%",
      popoverFg: "35 90% 68%",
      foreground: "35 90% 68%",
      primary: "30 100% 50%",
      primaryFg: "25 30% 5%",
      secondary: "35 40% 55%",
      secondaryFg: "25 30% 5%",
      muted: "25 20% 10%",
      mutedFg: "30 40% 40%",
      accent: "20 100% 60%",
      accentFg: "25 30% 5%",
      destructive: "0 70% 55%",
      destructiveFg: "0 0% 100%",
      border: "25 20% 14%",
      input: "25 20% 10%",
      ring: "30 100% 50%",
      orgKeyword: "30 40% 40%",
      orgDocTitle: "30 100% 50%",
      orgLevel1: "30 100% 55%",
      orgLevel2: "20 100% 60%",
      orgLevel3: "40 90% 55%",
      orgLevel4: "45 80% 50%",
      orgTodo: "39 100% 63%",
      orgDone: "30 30% 35%",
      orgLink: "200 70% 55%",
      orgDate: "45 60% 50%",
      orgCode: "180 40% 55%",
    },
  },
  green: {
    label: "Matrix Green",
    fontColor: "#0ccc68",
    bright: "#33ff88",
    normal: "#0ccc68",
    dim: "#088844",
    faint: "#044422",
    glow: "12, 204, 104",
    hsl: {
      bg: "160 30% 4%",
      card: "160 25% 6%",
      cardFg: "149 60% 60%",
      popover: "160 25% 6%",
      popoverFg: "149 60% 60%",
      foreground: "149 60% 60%",
      primary: "149 89% 42%",
      primaryFg: "160 30% 4%",
      secondary: "155 40% 50%",
      secondaryFg: "160 30% 4%",
      muted: "160 15% 9%",
      mutedFg: "148 30% 35%",
      accent: "170 80% 45%",
      accentFg: "160 30% 4%",
      destructive: "0 70% 55%",
      destructiveFg: "0 0% 100%",
      border: "160 15% 13%",
      input: "160 15% 9%",
      ring: "149 89% 42%",
      orgKeyword: "148 30% 35%",
      orgDocTitle: "149 89% 42%",
      orgLevel1: "149 89% 48%",
      orgLevel2: "170 80% 45%",
      orgLevel3: "100 60% 50%",
      orgLevel4: "55 70% 55%",
      orgTodo: "45 100% 58%",
      orgDone: "148 25% 30%",
      orgLink: "200 70% 55%",
      orgDate: "55 60% 50%",
      orgCode: "180 50% 55%",
    },
  },
  blue: {
    label: "Ocean Blue",
    fontColor: "#7fb4ff",
    bright: "#a0ccff",
    normal: "#7fb4ff",
    dim: "#4477aa",
    faint: "#223855",
    glow: "127, 180, 255",
    hsl: {
      bg: "220 25% 6%",
      card: "220 20% 8%",
      cardFg: "215 70% 72%",
      popover: "220 20% 8%",
      popoverFg: "215 70% 72%",
      foreground: "215 70% 72%",
      primary: "215 100% 60%",
      primaryFg: "0 0% 100%",
      secondary: "210 50% 60%",
      secondaryFg: "220 25% 6%",
      muted: "220 15% 11%",
      mutedFg: "210 30% 40%",
      accent: "190 80% 50%",
      accentFg: "220 25% 6%",
      destructive: "0 70% 55%",
      destructiveFg: "0 0% 100%",
      border: "220 15% 16%",
      input: "220 15% 11%",
      ring: "215 100% 60%",
      orgKeyword: "210 30% 40%",
      orgDocTitle: "215 100% 60%",
      orgLevel1: "215 100% 65%",
      orgLevel2: "190 80% 50%",
      orgLevel3: "260 60% 65%",
      orgLevel4: "160 50% 55%",
      orgTodo: "45 90% 60%",
      orgDone: "210 20% 35%",
      orgLink: "280 60% 65%",
      orgDate: "45 70% 55%",
      orgCode: "180 50% 55%",
    },
  },
  devtools: {
    label: "DevTools Dark",
    fontColor: "#d4d4d4",
    bright: "#3dc9ff",
    normal: "#d4d4d4",
    dim: "#808080",
    faint: "#4a4a4a",
    glow: "0, 122, 204",
    hsl: {
      bg: "0 0% 12%",
      card: "0 0% 15%",
      cardFg: "0 0% 83%",
      popover: "0 0% 15%",
      popoverFg: "0 0% 83%",
      foreground: "0 0% 83%",
      primary: "200 100% 40%",
      primaryFg: "0 0% 100%",
      secondary: "0 0% 83%",
      secondaryFg: "0 0% 12%",
      muted: "0 0% 18%",
      mutedFg: "0 0% 50%",
      accent: "200 100% 40%",
      accentFg: "0 0% 100%",
      destructive: "0 70% 55%",
      destructiveFg: "0 0% 100%",
      border: "0 0% 24%",
      input: "0 0% 18%",
      ring: "200 100% 40%",
      orgKeyword: "304 44% 65%",
      orgDocTitle: "210 60% 59%",
      orgLevel1: "210 60% 59%",
      orgLevel2: "199 95% 81%",
      orgLevel3: "168 53% 55%",
      orgLevel4: "95 29% 73%",
      orgTodo: "168 53% 55%",
      orgDone: "0 0% 50%",
      orgLink: "200 100% 40%",
      orgDate: "16 47% 64%",
      orgCode: "16 47% 64%",
    },
  },
  solarized: {
    label: "Solarized Dark",
    fontColor: "#839496",
    bright: "#268bd2",
    normal: "#839496",
    dim: "#586e75",
    faint: "#073642",
    glow: "131, 148, 150",
    hsl: {
      bg: "192 100% 11%",
      card: "192 81% 14%",
      cardFg: "186 8% 55%",
      popover: "192 81% 14%",
      popoverFg: "186 8% 55%",
      foreground: "186 8% 55%",
      primary: "205 69% 49%",
      primaryFg: "192 100% 11%",
      secondary: "186 8% 55%",
      secondaryFg: "192 100% 11%",
      muted: "192 50% 16%",
      mutedFg: "194 14% 40%",
      accent: "205 69% 49%",
      accentFg: "192 100% 11%",
      destructive: "1 71% 52%",
      destructiveFg: "44 100% 97%",
      border: "192 81% 14%",
      input: "192 50% 16%",
      ring: "205 69% 49%",
      orgKeyword: "194 14% 40%",
      orgDocTitle: "205 69% 49%",
      orgLevel1: "205 69% 49%",
      orgLevel2: "175 59% 40%",
      orgLevel3: "68 100% 30%",
      orgLevel4: "45 100% 35%",
      orgTodo: "68 100% 30%",
      orgDone: "194 14% 40%",
      orgLink: "205 69% 49%",
      orgDate: "45 100% 35%",
      orgCode: "175 59% 40%",
    },
  },
  dracula: {
    label: "Dracula",
    fontColor: "#f8f8f2",
    bright: "#bd93f9",
    normal: "#f8f8f2",
    dim: "#6272a4",
    faint: "#44475a",
    glow: "248, 248, 242",
    hsl: {
      bg: "231 15% 18%",
      card: "232 14% 22%",
      cardFg: "60 30% 96%",
      popover: "232 14% 22%",
      popoverFg: "60 30% 96%",
      foreground: "60 30% 96%",
      primary: "265 89% 78%",
      primaryFg: "231 15% 18%",
      secondary: "60 30% 96%",
      secondaryFg: "231 15% 18%",
      muted: "232 14% 25%",
      mutedFg: "225 27% 51%",
      accent: "265 89% 78%",
      accentFg: "231 15% 18%",
      destructive: "0 100% 67%",
      destructiveFg: "60 30% 96%",
      border: "232 14% 31%",
      input: "232 14% 25%",
      ring: "265 89% 78%",
      orgKeyword: "225 27% 51%",
      orgDocTitle: "265 89% 78%",
      orgLevel1: "265 89% 78%",
      orgLevel2: "191 97% 77%",
      orgLevel3: "135 94% 65%",
      orgLevel4: "65 92% 76%",
      orgTodo: "135 94% 65%",
      orgDone: "225 27% 51%",
      orgLink: "265 89% 78%",
      orgDate: "65 92% 76%",
      orgCode: "191 97% 77%",
    },
  },
  redAlert: {
    label: "Red Alert",
    fontColor: "#ff3333",
    bright: "#ff6666",
    normal: "#ff3333",
    dim: "#801a1a",
    faint: "#330000",
    glow: "255, 51, 51",
    hsl: {
      bg: "0 30% 5%",
      card: "0 25% 7%",
      cardFg: "0 80% 65%",
      popover: "0 25% 7%",
      popoverFg: "0 80% 65%",
      foreground: "0 80% 65%",
      primary: "0 100% 60%",
      primaryFg: "0 0% 100%",
      secondary: "0 50% 55%",
      secondaryFg: "0 30% 5%",
      muted: "0 20% 10%",
      mutedFg: "0 40% 35%",
      accent: "0 100% 70%",
      accentFg: "0 30% 5%",
      destructive: "0 100% 50%",
      destructiveFg: "0 100% 95%",
      border: "0 20% 15%",
      input: "0 20% 10%",
      ring: "0 100% 60%",
      orgKeyword: "0 40% 35%",
      orgDocTitle: "0 100% 60%",
      orgLevel1: "0 100% 60%",
      orgLevel2: "15 90% 60%",
      orgLevel3: "30 80% 55%",
      orgLevel4: "340 70% 60%",
      orgTodo: "24 100% 55%",
      orgDone: "0 25% 30%",
      orgLink: "200 60% 55%",
      orgDate: "30 60% 50%",
      orgCode: "180 40% 50%",
    },
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

  const keys: ThemeKey[] = ["amber", "green", "blue", "devtools", "solarized", "dracula", "redAlert"];
  const cycleTheme = useCallback(() => {
    setTheme(prev => {
      const next = keys[(keys.indexOf(prev) + 1) % keys.length];
      try { localStorage.setItem("crt-theme", next); } catch {}
      return next;
    });
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const p = PHOSPHOR_PROFILES[theme];
    const h = p.hsl;

    root.style.setProperty("--background", h.bg);
    root.style.setProperty("--foreground", h.foreground);
    root.style.setProperty("--card", h.card);
    root.style.setProperty("--card-foreground", h.cardFg);
    root.style.setProperty("--popover", h.popover);
    root.style.setProperty("--popover-foreground", h.popoverFg);
    root.style.setProperty("--primary", h.primary);
    root.style.setProperty("--primary-foreground", h.primaryFg);
    root.style.setProperty("--secondary", h.secondary);
    root.style.setProperty("--secondary-foreground", h.secondaryFg);
    root.style.setProperty("--muted", h.muted);
    root.style.setProperty("--muted-foreground", h.mutedFg);
    root.style.setProperty("--accent", h.accent);
    root.style.setProperty("--accent-foreground", h.accentFg);
    root.style.setProperty("--destructive", h.destructive);
    root.style.setProperty("--destructive-foreground", h.destructiveFg);
    root.style.setProperty("--border", h.border);
    root.style.setProperty("--input", h.input);
    root.style.setProperty("--ring", h.ring);

    root.style.setProperty("--org-keyword", h.orgKeyword);
    root.style.setProperty("--org-document-title", h.orgDocTitle);
    root.style.setProperty("--org-level-1", h.orgLevel1);
    root.style.setProperty("--org-level-2", h.orgLevel2);
    root.style.setProperty("--org-level-3", h.orgLevel3);
    root.style.setProperty("--org-level-4", h.orgLevel4);
    root.style.setProperty("--org-todo", h.orgTodo);
    root.style.setProperty("--org-done", h.orgDone);
    root.style.setProperty("--org-link", h.orgLink);
    root.style.setProperty("--org-date", h.orgDate);
    root.style.setProperty("--org-code", h.orgCode);
  }, [theme]);

  return (
    <Ctx.Provider value={{ theme, t: PHOSPHOR_PROFILES[theme], setTheme: handleSetTheme, cycleTheme }}>
      {children}
    </Ctx.Provider>
  );
}

export function useCrtTheme() {
  return useContext(Ctx);
}
