import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRequest, rankParking } from "@/lib/domain/recommend";
import { understandRequest } from "@/lib/ai/assistant";
import { aiConfigured, getDataMode, isDemoMode } from "@/lib/config";
import { buildSeed } from "@/lib/data/seed";
import { confidenceFor } from "@/lib/domain/handoff";
import { availableCapacity, isSpaceBookable, withinSchedule } from "@/lib/domain/marketplace";
import { T0, setup } from "./helpers";

// T0 = Tuesday 10:00 Riyadh. "9 AM" is therefore tomorrow 09:00 Riyadh = 06:00Z.
const EN = "I need parking near Al Olaya at 9 AM for two hours, within a reasonable walking distance and a budget of 20 SAR.";
const AR = "أحتاج موقفًا قرب العليا الساعة ٩ صباحًا لمدة ساعتين، ضمن مسافة مشي معقولة وميزانية 20 ريال.";

describe("AI parking assistant — deterministic understanding", () => {
  it("parses the English example", () => {
    const p = parseRequest(EN, T0);
    expect(p.destination).toBe("olaya");
    expect(p.arrival).toBe("2026-11-18T06:00:00.000Z");
    expect(p.durationHours).toBe(2);
    expect(p.budgetSar).toBe(20);
    expect(p.maxWalkM).toBe(800);
    expect(p.arrivalIsNow).toBe(false);
    expect(p.understood).toEqual(expect.arrayContaining(["destination", "arrival", "duration", "budget", "walk"]));
  });

  it("parses the Arabic example (with Arabic-Indic digits)", () => {
    const p = parseRequest(AR, T0);
    expect(p.destination).toBe("olaya");
    expect(p.arrival).toBe("2026-11-18T06:00:00.000Z");
    expect(p.durationHours).toBe(2);
    expect(p.budgetSar).toBe(20);
  });

  it("handles 'now', other neighborhoods and evening times", () => {
    expect(parseRequest("parking on King Fahd Road now for 1 hour", T0)).toMatchObject({ destination: "kfr", arrivalIsNow: true, durationHours: 1 });
    expect(parseRequest("موقف في الملقا الساعة 7 مساء", T0).arrival).toBe("2026-11-17T16:00:00.000Z");
  });
});

describe("Recommendation ranking", () => {
  async function rank(text: string) {
    const env = setup();
    const parsed = parseRequest(text, env.now);
    const arrival = new Date(parsed.arrival);
    const end = new Date(arrival.getTime() + parsed.durationHours * 3_600_000);
    const spaces = [];
    for (const space of await env.repo.listSpaces()) {
      const bookable = await isSpaceBookable(env.ctx, space);
      spaces.push({ space, bookable, withinSchedule: withinSchedule(space.schedule, arrival, parsed.durationHours), freeCapacity: bookable ? await availableCapacity(env.ctx, space, arrival, end) : 0 });
    }
    const reports = (await env.repo.listReports()).filter((r) => ["available", "pending_departure"].includes(r.status));
    const signals = await Promise.all(reports.map(async (report) => ({ report, confidence: await confidenceFor(env.ctx, report, null) })));
    return rankParking({ parsed, spaces, signals, now: env.now });
  }

  it("ranks approved, open, in-budget spaces near the destination and explains why", async () => {
    const out = await rank(EN);
    expect(out.results.length).toBeGreaterThan(0);
    expect(out.results.every((r) => r.kind === "private")).toBe(true); // 9 AM tomorrow → no community signals
    const top = out.results[0];
    expect(top.title).toContain("Olaya");
    expect(top.priceTotal).toBeLessThanOrEqual(20);
    expect(top.reasons.length).toBeGreaterThanOrEqual(3);
    expect(top.reasons[0].ar.length).toBeGreaterThan(0);
    // The space still awaiting review is never recommended.
    expect(out.results.some((r) => r.title.includes("awaiting review"))).toBe(false);
    expect(out.notes.some((n) => n.en.includes("Community signals last about 20 minutes"))).toBe(true);
  });

  it("includes community signals for 'now' requests, clearly marked as not guaranteed and not bookable", async () => {
    const out = await rank("parking near Al Olaya now for 1 hour");
    const community = out.results.filter((r) => r.kind === "community");
    expect(community.length).toBeGreaterThan(0);
    for (const c of community) {
      expect(c.guaranteed).toBe(false);
      expect(c.bookable).toBe(false);
      expect(c.priceTotal).toBeNull();
    }
    expect(out.results.filter((r) => r.kind === "private").every((r) => r.guaranteed === "subject_to_availability")).toBe(true);
  });
});

describe("14. Demo mode without external credentials", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to demo mode and no AI when no credentials are configured", () => {
    expect(getDataMode()).toBe("demo");
    expect(isDemoMode()).toBe(true);
    expect(aiConfigured()).toBe(false);
  });

  it("stays in demo mode if Supabase is requested but credentials are missing", () => {
    vi.stubEnv("RAKNA_DATA_MODE", "supabase");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    expect(getDataMode()).toBe("demo");
  });

  it("falls back to the rule-based engine without an Anthropic key", async () => {
    const res = await understandRequest(EN, T0);
    expect(res.aiUsed).toBe(false);
    expect(res.parsed.source).toBe("rules");
    expect(res.parsed.destination).toBe("olaya");
  });

  it("marks every seeded record as DEMO DATA and includes the required accounts", () => {
    const s = buildSeed(T0);
    const all = [...s.profiles, ...s.reports, ...s.partners, ...s.spaces, ...s.rewards, ...s.challenges];
    expect(all.every((r) => (r as { isDemo: boolean }).isDemo === true)).toBe(true);
    expect(s.profiles.filter((p) => p.role === "driver").length).toBeGreaterThanOrEqual(2);
    expect(s.profiles.some((p) => p.role === "partner")).toBe(true);
    expect(s.profiles.some((p) => p.role === "admin")).toBe(true);
    const hoods = new Set(s.reports.map((r) => r.neighborhood));
    expect([...hoods].sort()).toEqual(["kfr", "malqa", "olaya", "wurud"]);
    expect(s.spaces.every((x) => x.title.includes("Demo"))).toBe(true);
  });
});
