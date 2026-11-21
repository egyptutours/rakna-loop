import { body, route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { adminOverview, decideFlag, decidePartner, decideSpace, processAccountDeletion, updateRules, upsertRewardItem } from "@/lib/domain/admin";
import { decideMission } from "@/lib/domain/community";
import { DomainError } from "@/lib/domain/errors";
import { resolveFlaggedReport } from "@/lib/domain/handoff";
import { decideRedemption } from "@/lib/domain/rewards";
import { getPlatformSettings, setVillaBookingsEnabled } from "@/lib/domain/home";
import { rateLimit } from "@/lib/security/rate-limit";
import { adminActionSchema, rulesSchema } from "@/lib/security/schemas";
import { hiveConfigPatchSchema } from "@/lib/security/hive-schemas";
import { runHiveLifecycle } from "@/lib/hive/lifecycle";
import { clearHiveCache } from "@/lib/hive/aggregation-cache";

export const dynamic = "force-dynamic";

export const GET = route(async () => {
  await requireRole(["admin"]);
  const ctx = getContext();
  const [overview, rewards, settings] = await Promise.all([adminOverview(ctx), ctx.repo.listRewards(), getPlatformSettings(ctx)]);
  return { ...overview, rewards, platformSettings: settings };
});

/** Every admin decision is validated, authorized and written to admin_audit_logs. */
export const POST = route(async (req: Request) => {
  const admin = await requireRole(["admin"]);
  await rateLimit("admin", admin.id);
  const a = await body(req, adminActionSchema);
  const ctx = getContext();
  switch (a.action) {
    case "partner":
      return decidePartner(ctx, admin.id, a.id, a.status);
    case "space":
      return decideSpace(ctx, admin.id, a.id, a.approval);
    case "redemption":
      return decideRedemption(ctx, admin.id, a.id, a.approve);
    case "mission":
      return decideMission(ctx, admin.id, a.id, a.approve);
    case "flag":
      return decideFlag(ctx, admin.id, a.id, a.decision, a.amount);
    case "report":
      return resolveFlaggedReport(ctx, admin.id, a.id, a.approve);
    case "reward_toggle": {
      const r = await ctx.repo.getReward(a.id);
      if (!r) throw new DomainError("not_found");
      return upsertRewardItem(ctx, admin.id, { ...r, active: a.active, keysRequired: a.keysRequired ?? r.keysRequired });
    }
    case "purge_locations": {
      const rules = await ctx.repo.getRules();
      const before = new Date(ctx.now().getTime() - rules.locationRetentionHours * 3_600_000).toISOString();
      const n = await ctx.repo.purgePreciseLocations(before);
      await ctx.repo.insertAudit({ id: crypto.randomUUID(), actorId: admin.id, action: "privacy.purge_locations", target: "location_records", details: `${n} records coarsened (older than ${rules.locationRetentionHours} h)`, createdAt: ctx.now().toISOString() });
      return { purged: n };
    }
    case "process_deletion":
      return processAccountDeletion(ctx, admin.id, a.id);
    case "hive_lifecycle": {
      const report = await runHiveLifecycle(ctx);
      await ctx.repo.insertAudit({ id: crypto.randomUUID(), actorId: admin.id, action: "hive.lifecycle", target: "temporary_signals", details: JSON.stringify(report), createdAt: ctx.now().toISOString() });
      return report;
    }
    case "villa_bookings":
      // Municipal sandbox switch: villa spaces leave / rejoin the waitlist together (audited).
      return { settings: await setVillaBookingsEnabled(ctx, admin.id, a.enabled) };
    case "hive_config": {
      const patch = hiveConfigPatchSchema.parse(a.config);
      const current = await ctx.repo.getHiveConfig();
      const next = { ...current, ...patch, states: { ...current.states, ...(patch.states ?? {}) } };
      await ctx.repo.setHiveConfig(next);
      clearHiveCache();
      await ctx.repo.insertAudit({ id: crypto.randomUUID(), actorId: admin.id, action: "hive.config_update", target: "hive_config", details: JSON.stringify(patch), createdAt: ctx.now().toISOString() });
      return { config: next };
    }
  }
});

export const PUT = route(async (req: Request) => {
  const admin = await requireRole(["admin"]);
  await rateLimit("admin", admin.id);
  const patch = await body(req, rulesSchema);
  return { rules: await updateRules(getContext(), admin.id, patch) };
});
