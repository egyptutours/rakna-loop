import type { DomainContext } from "../domain/context";

/**
 * Human-centered outcome metrics. Optimizes for successful mobility outcomes, not
 * screen time. Everything here is MEASURED from stored records; nothing is projected.
 * "Search time saved" needs a measured baseline (e.g. a survey or a control group),
 * so only the measured claim→verified-find time is reported.
 */
export async function hiveImpactMetrics(ctx: DomainContext) {
  const now = ctx.now();
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [reports, confirmations, bookings, spaces, missions, feedback, volume, runs] = await Promise.all([
    ctx.repo.listReports({ sinceIso: since }),
    ctx.repo.listConfirmations({ sinceIso: since }),
    ctx.repo.listBookings(),
    ctx.repo.listSpaces(),
    ctx.repo.listMissions({ status: "approved" }),
    ctx.repo.getFeedback(),
    ctx.repo.stats(),
    ctx.repo.listJobRuns("hive_lifecycle", 5),
  ]);

  const found = reports.filter((r) => r.status === "found");
  const timesMin = found
    .filter((r) => r.claimedAt && r.resolvedAt)
    .map((r) => (new Date(r.resolvedAt!).getTime() - new Date(r.claimedAt!).getTime()) / 60_000)
    .filter((m) => m >= 0 && m < 120)
    .sort((a, b) => a - b);
  const median = timesMin.length ? timesMin[Math.floor(timesMin.length / 2)] : null;

  const released = confirmations.filter((c) => c.rejectionReason?.startsWith("released")).length;
  const unsuccessful = reports.filter((r) => r.status === "not_found").length + released;

  const horizonEnd = new Date(now.getTime() + 7 * 86_400_000);
  let scheduled = 0;
  for (const s of spaces.filter((x) => x.approval === "approved")) scheduled += s.schedule.days.length * (s.schedule.closeHour - s.schedule.openHour) * s.capacity;
  const booked = bookings.filter((b) => b.status !== "cancelled" && new Date(b.startAt) >= now && new Date(b.startAt) < horizonEnd).reduce((s, b) => s + b.hours, 0);

  const totalFeedback = feedback.helpful + feedback.notHelpful;
  return {
    window: "7d",
    successfulHandoffs: found.length,
    unsuccessfulSearches: unsuccessful,
    successRate: found.length + unsuccessful > 0 ? Math.round((found.length / (found.length + unsuccessful)) * 100) : null,
    medianMinutesClaimToFind: median === null ? null : Math.round(median * 10) / 10,
    searchTimeSavedNote: "Requires a measured baseline; not estimated.",
    privateUtilization7d: scheduled > 0 ? Math.round((booked / scheduled) * 1000) / 10 : 0,
    sustainableMissionsApproved: missions.length,
    satisfaction: { helpful: feedback.helpful, notHelpful: feedback.notHelpful, percent: totalFeedback ? Math.round((feedback.helpful / totalFeedback) * 100) : null },
    dataVolume: volume,
    lifecycle: {
      lastRuns: runs,
      lastSuccessAt: runs.find((r) => r.ok)?.finishedAt ?? null,
      // Scheduled every 5 min in production; flag if no successful run in 15 min.
      overdue: !runs.some((r) => r.ok && r.finishedAt && now.getTime() - new Date(r.finishedAt).getTime() < 15 * 60_000),
      failuresInLast5: runs.filter((r) => r.ok === false).length,
    },
  };
}
