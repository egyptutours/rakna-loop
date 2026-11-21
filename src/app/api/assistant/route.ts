import { body, route } from "@/lib/api/handler";
import { getCurrentUser } from "@/lib/auth/session";
import { understandRequest } from "@/lib/ai/assistant";
import { aiConfigured } from "@/lib/config";
import { getContext } from "@/lib/data";
import { confidenceFor, refreshReport } from "@/lib/domain/handoff";
import { NEIGHBORHOODS } from "@/lib/config";
import { DomainError } from "@/lib/domain/errors";
import { hiveIndexFor, neighborhood } from "@/lib/hive/cells";
import { availableCapacity, isSpaceBookable, withinSchedule } from "@/lib/domain/marketplace";
import { rankParking } from "@/lib/domain/recommend";
import { rateLimit } from "@/lib/security/rate-limit";
import { assistantSchema } from "@/lib/security/schemas";
import { coarsen } from "@/lib/geo";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

/** AI Parking Assistant. Ranks only stored records; AI (if configured) only parses the request. */
export const POST = route(async (req: Request) => {
  const user = await getCurrentUser();
  // A paid AI call must never be triggerable anonymously (audit F-SEC-3).
  if (aiConfigured() && !user) throw new DomainError("unauthenticated", "Sign in to use the AI assistant");
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  await rateLimit("assistant", user?.id ?? `ip:${ip}`);
  const { query, viewer } = await body(req, assistantSchema);
  const ctx = getContext();
  const now = ctx.now();

  const { parsed, aiUsed, aiError } = await understandRequest(query, now);
  const arrival = new Date(parsed.arrival);
  const end = new Date(arrival.getTime() + parsed.durationHours * 3_600_000);

  const destAnchor = parsed.destination ? NEIGHBORHOODS.find((n) => n.id === parsed.destination)!.center : null;
  const candidateSpaces = destAnchor ? await ctx.repo.listSpacesInCells(8, neighborhood(hiveIndexFor(destAnchor).r8, 1)) : await ctx.repo.listSpaces();
  const spaces = [];
  for (const space of candidateSpaces) {
    const bookable = await isSpaceBookable(ctx, space);
    spaces.push({
      space,
      bookable,
      withinSchedule: withinSchedule(space.schedule, arrival, parsed.durationHours),
      freeCapacity: bookable ? await availableCapacity(ctx, space, arrival, end) : 0,
    });
  }
  // Bounded hive lookup: live signals only, in the destination's (or viewer's) hive + 3 rings,
  // or — with no anchor — only live signals (a small hot set by construction).
  const anchor = parsed.destination ? NEIGHBORHOODS.find((n) => n.id === parsed.destination)!.center : viewer ?? null;
  const live = anchor
    ? await ctx.repo.listReportsInCells(9, neighborhood(hiveIndexFor(anchor).r9, 3), { statuses: ["available", "pending_departure"] })
    : await ctx.repo.listReports({ sinceIso: new Date(now.getTime() - 3 * 3_600_000).toISOString() });
  const reports = (await Promise.all(live.map((r) => refreshReport(ctx, r)))).filter((r) => ["available", "pending_departure"].includes(r.status) && r.reporterId !== user?.id);
  const signals = await Promise.all(reports.map(async (report) => ({ report, confidence: await confidenceFor(ctx, report, viewer ?? null) })));

  const ranked = rankParking({ parsed, spaces, signals, now });
  // Community signal coordinates are coarsened here too: precise location only after "Navigate".
  ranked.results = ranked.results.map((r) => (r.kind === "community" ? { ...r, location: coarsen(r.location) } : r));
  return { parsed, ...ranked, engine: aiUsed ? "ai" : "rules", aiConfigured: aiConfigured(), aiError: aiError ?? null };
});
