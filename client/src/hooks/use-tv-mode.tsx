import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

interface TvModeContext {
  isTvMode: boolean;
  setTvMode: (enabled: boolean) => void;
}

const TvCtx = createContext<TvModeContext>({
  isTvMode: false,
  setTvMode: () => {},
});

const TV_STORAGE_KEY = "orgcloud-tv-mode";

export function TvModeProvider({ children }: { children: React.ReactNode }) {
  const [isTvMode, setIsTvMode] = useState<boolean>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get("tv") === "1") {
        localStorage.setItem(TV_STORAGE_KEY, "1");
        return true;
      }
      return localStorage.getItem(TV_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  const setTvMode = useCallback((enabled: boolean) => {
    setIsTvMode(enabled);
    try {
      if (enabled) {
        localStorage.setItem(TV_STORAGE_KEY, "1");
      } else {
        localStorage.removeItem(TV_STORAGE_KEY);
      }
    } catch {}
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (isTvMode) {
      root.classList.add("tv-mode");
    } else {
      root.classList.remove("tv-mode");
    }
  }, [isTvMode]);

  return (
    <TvCtx.Provider value={{ isTvMode, setTvMode }}>
      {children}
    </TvCtx.Provider>
  );
}

export function useTvMode() {
  return useContext(TvCtx);
}
