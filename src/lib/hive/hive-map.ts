import type { HiveState } from "../types";

/**
 * HiveMapService — presentation tokens for the honeycomb overlay (shared by the map
 * and legends). Fill opacities are deliberately low and drop further at street zoom
 * so roads, labels, markers and accessibility cues stay readable.
 */
export const HIVE_STATE_STYLE: Record<HiveState, { fill: string; line: string; en: string; ar: string; descEn: string; descAr: string }> = {
  quiet: { fill: "#a7bea3", line: "#8aa886", en: "Quiet", ar: "هادئة", descEn: "Little recent activity", descAr: "نشاط حديث محدود" },
  active: { fill: "#d8b46a", line: "#b08d4f", en: "Active", ar: "نشطة", descEn: "Normal community activity", descAr: "نشاط مجتمعي طبيعي" },
  resource_rich: { fill: "#2f9a62", line: "#1f8a55", en: "Resource rich", ar: "وفرة", descEn: "More verified opportunities than demand", descAr: "فرص موثقة أكثر من الطلب" },
  high_demand: { fill: "#e08a3c", line: "#c06c1f", en: "High demand", ar: "طلب مرتفع", descEn: "More searches than opportunities", descAr: "طلبات بحث أكثر من الفرص" },
  overloaded: { fill: "#c2493a", line: "#a3362a", en: "Overloaded", ar: "مزدحمة", descEn: "High demand, little verified supply", descAr: "طلب مرتفع وعرض موثق قليل" },
};

export const HIVE_STATES: HiveState[] = ["quiet", "active", "resource_rich", "high_demand", "overloaded"];

export function fillOpacityForZoom(zoom: number): number {
  if (zoom >= 15) return 0.12;
  if (zoom >= 13) return 0.22;
  return 0.3;
}
