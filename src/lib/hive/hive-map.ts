import type { HiveState } from "../types";

/**
 * HiveMapService — presentation tokens for the honeycomb overlay (shared by the map
 * and legends). Fill opacities are deliberately low and drop further at street zoom
 * so roads, labels, markers and accessibility cues stay readable.
 */
export const HIVE_STATE_STYLE: Record<HiveState, { fill: string; line: string; en: string; ar: string; descEn: string; descAr: string }> = {
  quiet: { fill: "#d8c29e", line: "#b39a74", en: "Quiet", ar: "هادئة", descEn: "Little recent activity", descAr: "نشاط قليل مؤخرًا" },
  active: { fill: "#d9a75a", line: "#a9742e", en: "Active", ar: "نشيطة", descEn: "Normal community activity", descAr: "نشاط مجتمعي عادي" },
  resource_rich: { fill: "#2e8b5a", line: "#1c7a4c", en: "Resource rich", ar: "وفرة", descEn: "More verified opportunities than demand", descAr: "فرص موثقة أكثر من الطلب" },
  high_demand: { fill: "#e08a3c", line: "#c06c1f", en: "High demand", ar: "طلب عالي", descEn: "More searches than opportunities", descAr: "طلبات البحث أكثر من الفرص" },
  overloaded: { fill: "#b5392f", line: "#8e2c2a", en: "Overloaded", ar: "زحمة", descEn: "High demand, little verified supply", descAr: "طلب عالي وعرض موثق قليل" },
};

export const HIVE_STATES: HiveState[] = ["quiet", "active", "resource_rich", "high_demand", "overloaded"];

export function fillOpacityForZoom(zoom: number): number {
  if (zoom >= 15) return 0.12;
  if (zoom >= 13) return 0.22;
  return 0.3;
}
