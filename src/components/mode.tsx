"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Driver / Host mode (UI only — authorization is always enforced on the server).
 * A RAKNA HOME host is an ordinary driver account that also lists a bay, so one
 * account switches between the two views. Remembered per browser.
 */
export type AppMode = "driver" | "host";
const KEY = "rakna_mode";
const EVENT = "rakna-mode";

export function useMode(): [AppMode, (m: AppMode) => void] {
  const [mode, setModeState] = useState<AppMode>("driver");
  useEffect(() => {
    const read = () => {
      try {
        setModeState(localStorage.getItem(KEY) === "host" ? "host" : "driver");
      } catch {
        /* storage unavailable */
      }
    };
    read();
    window.addEventListener(EVENT, read);
    return () => window.removeEventListener(EVENT, read);
  }, []);
  const setMode = useCallback((m: AppMode) => {
    try {
      localStorage.setItem(KEY, m);
    } catch {
      /* storage unavailable */
    }
    setModeState(m);
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return [mode, setMode];
}
