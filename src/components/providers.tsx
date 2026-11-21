"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, setAuthToken } from "@/lib/client/api";
import { dirFor, ERROR_MESSAGES, type Bi } from "@/lib/i18n";
import type { Lang, Profile, Role } from "@/lib/types";

export interface DemoUser {
  id: string;
  displayName: string;
  displayNameAr: string;
  role: Role;
}

interface SessionData {
  user: Profile | null;
  demoMode: boolean;
  aiEnabled: boolean;
  demoUsers: DemoUser[];
}

interface AppContextValue {
  lang: Lang;
  dir: "rtl" | "ltr";
  setLang: (l: Lang) => void;
  /** Inline bilingual string: L("English", "العربية"). */
  L: (en: string, ar: string) => string;
  B: (b: Bi) => string;
  errorText: (e: unknown) => string;
  session: SessionData | null;
  refreshSession: () => Promise<void>;
  switchUser: (id: string) => Promise<void>;
  toast: (msg: string, tone?: "ok" | "error" | "info") => void;
}

const Ctx = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp must be used inside <Providers>");
  return v;
}

interface Toast {
  id: number;
  msg: string;
  tone: "ok" | "error" | "info";
}

export function Providers({ initialLang, children }: { initialLang: Lang; children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [session, setSession] = useState<SessionData | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const refreshSession = useCallback(async () => {
    try {
      setSession(await api<SessionData>("/api/session"));
    } catch {
      setSession({ user: null, demoMode: true, aiEnabled: false, demoUsers: [] });
    }
  }, []);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  // Supabase mode: keep the API bearer token in sync with the Supabase Auth session.
  useEffect(() => {
    // Loaded lazily and only when Supabase is configured (keeps supabase-js out of demo bundles).
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return;
    let unsubscribe: (() => void) | undefined;
    void import("@/lib/client/supabase-browser").then(({ supabaseBrowser }) => {
      const sb = supabaseBrowser();
      if (!sb) return;
      void sb.auth.getSession().then(({ data }) => {
        setAuthToken(data.session?.access_token ?? null);
        void refreshSession();
      });
      const { data } = sb.auth.onAuthStateChange((_event, s) => {
        setAuthToken(s?.access_token ?? null);
        void refreshSession();
      });
      unsubscribe = () => data.subscription.unsubscribe();
    });
    return () => unsubscribe?.();
  }, [refreshSession]);

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirFor(lang);
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    void api("/api/lang", { body: { lang: l } }).catch(() => {});
  }, []);

  const toast = useCallback((msg: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  const switchUser = useCallback(
    async (id: string) => {
      await api("/api/session", { body: { userId: id } });
      await refreshSession();
    },
    [refreshSession],
  );

  const value = useMemo<AppContextValue>(() => {
    const L = (en: string, ar: string) => (lang === "ar" ? ar : en);
    const B = (b: Bi) => (lang === "ar" ? b.ar : b.en);
    const errorText = (e: unknown) => {
      if (e instanceof ApiError) {
        const m = ERROR_MESSAGES[e.code];
        const base = m ? B(m) : e.message;
        const d = e.details as { distanceM?: number; allowedM?: number; retryAfterS?: number } | null;
        if (e.code === "too_far" && d?.distanceM !== undefined) {
          return `${base} ${L(`You are ~${d.distanceM} m away (limit ${d.allowedM} m).`, `أنت على بُعد ~${d.distanceM} م (الحد ${d.allowedM} م).`)}`;
        }
        return base;
      }
      return B(ERROR_MESSAGES.internal);
    };
    return { lang, dir: dirFor(lang), setLang, L, B, errorText, session, refreshSession, switchUser, toast };
  }, [lang, setLang, session, refreshSession, switchUser, toast]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[70] flex flex-col items-center gap-2 px-4 md:bottom-6" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto max-w-md rounded-2xl px-4 py-3 text-sm font-medium shadow-[var(--shadow-lift)] ${
              t.tone === "error" ? "bg-danger text-white" : t.tone === "ok" ? "bg-forest text-white" : "bg-ink text-white"
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
