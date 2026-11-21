"use client";

import { useState } from "react";
import { Crosshair, FlaskConical, MapPin } from "lucide-react";
import { useApp } from "./providers";
import { Button, cn } from "./ui";
import type { EvidenceType, LatLng } from "@/lib/types";

export interface Evidence {
  location: LatLng | null;
  accuracyM: number | null;
  evidence: EvidenceType;
}

export interface SimPreset {
  id: string;
  label: { en: string; ar: string };
  location: LatLng;
  accuracyM: number;
  tone?: "ok" | "warn" | "bad";
}

/** Offset a point by metres (north/east). */
export function offset(p: LatLng, northM: number, eastM: number): LatLng {
  return { lat: p.lat + northM / 111_320, lng: p.lng + eastM / (111_320 * Math.cos((p.lat * Math.PI) / 180)) };
}

/**
 * Location capture. Browser geolocation is requested ONLY when the user taps the
 * button (never in the background). In demo mode, simulated positions let you test
 * proximity rules without walking to Riyadh.
 */
export function LocationPicker({ value, onChange, presets, purpose }: { value: Evidence | null; onChange: (e: Evidence) => void; presets?: SimPreset[]; purpose: string }) {
  const { L, B, session } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const useGps = () => {
    setErr(null);
    if (!("geolocation" in navigator)) {
      setErr(L("This browser can't share location.", "هذا المتصفح لا يدعم مشاركة الموقع."));
      return;
    }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setBusy(false);
        onChange({ location: { lat: pos.coords.latitude, lng: pos.coords.longitude }, accuracyM: Math.round(pos.coords.accuracy), evidence: "gps" });
      },
      (e) => {
        setBusy(false);
        setErr(
          e.code === e.PERMISSION_DENIED
            ? L("Location permission was denied. You can enable it in your browser settings.", "تم رفض إذن الموقع. يمكنك تفعيله من إعدادات المتصفح.")
            : L("Couldn't get your location. Try again outdoors.", "تعذر تحديد موقعك. حاول مجددًا في مكان مكشوف."),
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000 },
    );
  };

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-mute">{purpose}</p>
      <Button type="button" variant="secondary" onClick={useGps} loading={busy} className="w-full">
        <Crosshair className="h-4 w-4" aria-hidden />
        {L("Use my current location (one time)", "استخدم موقعي الحالي (مرة واحدة)")}
      </Button>
      {err && <p className="text-xs text-danger">{err}</p>}

      {session?.demoMode && presets && presets.length > 0 && (
        <div className="rounded-2xl border border-dashed border-gold/50 bg-gold-soft/40 p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-gold">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden />
            {L("Demo: simulate a position", "تجريبي: محاكاة موقع")}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onChange({ location: p.location, accuracyM: p.accuracyM, evidence: "simulated" })}
                className={cn(
                  "rounded-xl border bg-card px-3 py-2 text-start text-xs font-medium transition hover:border-forest-3",
                  p.tone === "bad" ? "border-danger/30" : p.tone === "warn" ? "border-warn/30" : "border-line",
                )}
              >
                {B(p.label)}
              </button>
            ))}
          </div>
        </div>
      )}

      {value?.location && (
        <div className="flex items-start gap-2 rounded-xl bg-sage-mist p-3 text-xs">
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-forest" aria-hidden />
          <div>
            <p className="num font-medium text-ink">
              {value.location.lat.toFixed(5)}, {value.location.lng.toFixed(5)}
            </p>
            <p className="text-mute">
              {L("Accuracy", "الدقة")}: <span className="num">±{value.accuracyM ?? "?"} m</span> ·{" "}
              {value.evidence === "gps" ? L("Device GPS", "GPS الجهاز") : L("Simulated (demo)", "محاكاة (تجريبي)")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
