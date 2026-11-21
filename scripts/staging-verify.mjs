// READ-ONLY staging verification. Writes nothing.
//
//   node --env-file=.env.staging.local scripts/staging-verify.mjs
//   (optional) APP_URL=https://<your-staging-app> in .env.staging.local to also check the deployed app
//
// Checks: migrations 0001–0006 present, RLS/permissions as seen by the ANON key, lifecycle
// job health, H3 columns populated, and (with APP_URL) demo lockout + security headers.
import { stagingClients } from "./_staging-guard.mjs";

const { anon, admin, ref } = stagingClients();
const results = [];
const check = async (name, fn) => {
  try {
    const r = await fn();
    results.push({ check: name, result: r === true ? "PASS" : r === false ? "FAIL" : r });
  } catch (e) {
    results.push({ check: name, result: `FAIL: ${e.message}` });
  }
};
const denied = (res) => Boolean(res.error) && /permission denied|not allowed|42501|PGRST/i.test(`${res.error.code} ${res.error.message}`);

console.log(`Verifying STAGING project ${ref} (read-only)\n`);

// Schema / migrations (service role)
await check("0001–0003 core schema (points_ledger readable by service role)", async () => !(await admin.from("points_ledger").select("id").limit(1)).error);
await check("0004 hive: H3 columns on parking_spaces", async () => !(await admin.from("parking_spaces").select("h3_r9, h3_r10, accessible_bays").limit(1)).error);
await check("0004 hive: hive_cell_stats table", async () => !(await admin.from("hive_cell_stats").select("h3_r10").limit(1)).error);
await check("0005 audit fixes: ledger_totals() exists", async () => !(await admin.rpc("ledger_totals")).error);
await check("0005 audit fixes: hive_job_runs table", async () => !(await admin.from("hive_job_runs").select("id").limit(1)).error);
await check("0006 schedule: hive_job_health view", async () => !(await admin.from("hive_job_health").select("job").limit(1)).error);
await check("Lifecycle job has run successfully (pg_cron, within 15 min)", async () => {
  const { data, error } = await admin.from("hive_job_health").select("*").eq("job", "hive_lifecycle").maybeSingle();
  if (error) throw error;
  if (!data) return "PENDING: no runs yet — wait 5 min after 0006, or check cron.job in the SQL editor";
  return data.overdue ? `FAIL: overdue (last success ${data.last_success_at})` : `PASS (last success ${data.last_success_at}, failures 24h: ${data.failures_24h})`;
});
await check("Spaces have H3 indexes (run db:backfill-h3 if not)", async () => {
  const { count, error } = await admin.from("parking_spaces").select("id", { count: "exact", head: true }).is("h3_r10", null);
  if (error) throw error;
  return count === 0 ? true : `FAIL: ${count} space(s) without H3`;
});

// Security as seen by the public ANON key (what any browser holds)
await check("anon cannot read departure_reports (precise coordinates)", async () => {
  const r = await anon.from("departure_reports").select("location_lat").limit(1);
  return denied(r) || (r.data ?? []).length === 0;
});
await check("anon can read coarsened departure_reports_public", async () => !(await anon.from("departure_reports_public").select("location_lat").limit(1)).error);
await check("anon cannot read profiles", async () => {
  const r = await anon.from("profiles").select("id").limit(1);
  return denied(r) || (r.data ?? []).length === 0;
});
await check("anon cannot call insert_ledger_entry (award Keys)", async () => denied(await anon.rpc("insert_ledger_entry", { p_id: "00000000-0000-4000-8000-000000000000", p_user_id: "00000000-0000-4000-8000-000000000000", p_amount: 1, p_type: "mission_reward", p_reason: "x", p_idempotency_key: "verify-probe", p_ref_type: null, p_ref_id: null })));
await check("anon cannot run rakna_hive_lifecycle()", async () => denied(await anon.rpc("rakna_hive_lifecycle")));
await check("anon cannot run anonymize_profile()", async () => denied(await anon.rpc("anonymize_profile", { p_user_id: "00000000-0000-4000-8000-000000000000" })));
await check("anon cannot read hive_job_runs", async () => {
  const r = await anon.from("hive_job_runs").select("id").limit(1);
  return denied(r) || (r.data ?? []).length === 0;
});
await check("anon cannot insert parking_spaces", async () => Boolean((await anon.from("parking_spaces").insert({ title: "x" })).error));

// Deployed app (optional)
const app = process.env.APP_URL?.replace(/\/$/, "");
if (app) {
  await check("App: CSP + HSTS headers", async () => {
    const h = (await fetch(app, { method: "HEAD" })).headers;
    return Boolean(h.get("content-security-policy")) && Boolean(h.get("strict-transport-security"));
  });
  await check("App: running in supabase mode (not demo)", async () => (await (await fetch(`${app}/api/session`)).json()).data?.demoMode === false);
  await check("App: demo controls locked (POST /api/demo → 403)", async () => (await fetch(`${app}/api/demo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"action":"reset"}' })).status === 403);
  await check("App: demo account switch locked (POST /api/session → 403)", async () => (await fetch(`${app}/api/session`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"userId":"00000000-0000-4000-a000-0000000000ad"}' })).status === 403);
  await check("App: hive map API responds", async () => (await fetch(`${app}/api/hive/map?w=46.66&s=24.68&e=46.71&n=24.72&z=13.5`)).ok);
} else {
  results.push({ check: "Deployed app checks", result: "SKIPPED (set APP_URL)" });
}

console.table(results);
const failed = results.filter((r) => String(r.result).startsWith("FAIL"));
console.log(failed.length ? `\n${failed.length} check(s) failed.` : "\nAll executed checks passed. Still verify cron.job in the SQL editor and run the manual checklist in docs/STAGING.md §9.");
process.exit(failed.length ? 1 : 0);
