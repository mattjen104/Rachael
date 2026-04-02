import React, { createContext, useContext, useState, useCallback, useEffect } from "react";

export const PHOSPHOR_PROFILES = {
  amber: {
    label: "Default Amber",
    fontColor: "#ff8100",
    bright: "#ffc940",
    normal: "#ff8100",
    dim: "#aa5500",
    faint: "#663300",
    glow: "255, 129, 0",
    hsl: {
      bg: "30 80% 3%",
      card: "30 80% 4%",
      cardFg: "30 100% 50%",
      popover: "30 80% 4%",
      popoverFg: "30 100% 50%",
      foreground: "30 100% 50%",
      primary: "30 100% 50%",
      primaryFg: "30 80% 3%",
      secondary: "30 100% 50%",
      secondaryFg: "30 80% 3%",
      muted: "30 60% 8%",
      mutedFg: "30 70% 28%",
      accent: "30 100% 50%",
      accentFg: "30 80% 3%",
      destructive: "30 100% 50%",
      destructiveFg: "30 80% 3%",
      border: "30 50% 10%",
      input: "30 50% 8%",
      ring: "30 100% 50%",
      orgKeyword: "30 70% 28%",
      orgDocTitle: "30 100% 50%",
      orgLevel1: "30 100% 50%",
      orgLevel2: "30 100% 50%",
      orgLevel3: "30 100% 50%",
      orgLevel4: "30 100% 50%",
      orgTodo: "39 100% 63%",
      orgDone: "30 70% 28%",
      orgLink: "30 100% 50%",
      orgDate: "30 70% 28%",
      orgCode: "30 100% 50%",
    },
  },
  green: {
    label: "Mono Green",
    fontColor: "#0ccc68",
    bright: "#33ff88",
    normal: "#0ccc68",
    dim: "#088844",
    faint: "#044422",
    glow: "12, 204, 104",
    hsl: {
      bg: "149 80% 2%",
      card: "149 80% 3%",
      cardFg: "149 89% 42%",
      popover: "149 80% 3%",
      popoverFg: "149 89% 42%",
      foreground: "149 89% 42%",
      primary: "149 89% 42%",
      primaryFg: "149 80% 2%",
      secondary: "149 89% 42%",
      secondaryFg: "149 80% 2%",
      muted: "149 50% 7%",
      mutedFg: "148 60% 24%",
      accent: "149 89% 42%",
      accentFg: "149 80% 2%",
      destructive: "149 89% 42%",
      destructiveFg: "149 80% 2%",
      border: "149 40% 9%",
      input: "149 40% 7%",
      ring: "149 89% 42%",
      orgKeyword: "148 60% 24%",
      orgDocTitle: "149 89% 42%",
      orgLevel1: "149 89% 42%",
      orgLevel2: "149 89% 42%",
      orgLevel3: "149 89% 42%",
      orgLevel4: "149 89% 42%",
      orgTodo: "145 100% 58%",
      orgDone: "148 60% 24%",
      orgLink: "149 89% 42%",
      orgDate: "148 60% 24%",
      orgCode: "149 89% 42%",
    },
  },
  blue: {
    label: "Deep Blue",
    fontColor: "#7fb4ff",
    bright: "#a0ccff",
    normal: "#7fb4ff",
    dim: "#4477aa",
    faint: "#223855",
    glow: "127, 180, 255",
    hsl: {
      bg: "215 80% 3%",
      card: "215 80% 4%",
      cardFg: "215 100% 75%",
      popover: "215 80% 4%",
      popoverFg: "215 100% 75%",
      foreground: "215 100% 75%",
      primary: "215 100% 75%",
      primaryFg: "215 80% 3%",
      secondary: "215 100% 75%",
      secondaryFg: "215 80% 3%",
      muted: "210 40% 8%",
      mutedFg: "210 50% 35%",
      accent: "215 100% 75%",
      accentFg: "215 80% 3%",
      destructive: "215 100% 75%",
      destructiveFg: "215 80% 3%",
      border: "210 40% 10%",
      input: "210 40% 8%",
      ring: "215 100% 75%",
      orgKeyword: "210 50% 35%",
      orgDocTitle: "215 100% 75%",
      orgLevel1: "215 100% 75%",
      orgLevel2: "215 100% 75%",
      orgLevel3: "215 100% 75%",
      orgLevel4: "215 100% 75%",
      orgTodo: "212 100% 80%",
      orgDone: "210 50% 35%",
      orgLink: "215 100% 75%",
      orgDate: "210 50% 35%",
      orgCode: "215 100% 75%",
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
      bg: "0 100% 2%",
      card: "0 100% 3%",
      cardFg: "0 100% 60%",
      popover: "0 100% 3%",
      popoverFg: "0 100% 60%",
      foreground: "0 100% 60%",
      primary: "0 100% 60%",
      primaryFg: "0 100% 2%",
      secondary: "0 100% 60%",
      secondaryFg: "0 100% 2%",
      muted: "0 66% 8%",
      mutedFg: "0 66% 30%",
      accent: "0 100% 70%",
      accentFg: "0 100% 2%",
      destructive: "0 100% 50%",
      destructiveFg: "0 100% 95%",
      border: "0 66% 12%",
      input: "0 66% 8%",
      ring: "0 100% 60%",
      orgKeyword: "0 66% 30%",
      orgDocTitle: "0 100% 60%",
      orgLevel1: "0 100% 60%",
      orgLevel2: "0 100% 70%",
      orgLevel3: "0 100% 60%",
      orgLevel4: "0 100% 50%",
      orgTodo: "24 100% 50%",
      orgDone: "0 66% 30%",
      orgLink: "0 100% 70%",
      orgDate: "0 66% 30%",
      orgCode: "0 100% 60%",
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

    root.style.setProperty("--crt-glow", p.glow);
    root.style.setProperty("--crt-font-color", p.fontColor);
    root.style.setProperty("--crt-bright", p.bright);
    root.style.setProperty("--crt-dim", p.dim);

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
