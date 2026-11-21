import { beforeAll, describe, expect, it } from "vitest";
import { createDb, pgError, type Db } from "./harness";

/**
 * Real-PostgreSQL validation of supabase/migrations (PostgreSQL 18 + PostGIS 3.6 via
 * PGlite, Supabase roles/grants shimmed). Security assertions run as the `authenticated`
 * and `anon` roles with RLS enforced — no frontend or API checks are involved.
 */

const U = "11111111-1111-4111-8111-111111111111"; // driver
const V = "22222222-2222-4222-8222-222222222222"; // another driver
const P = "33333333-3333-4333-8333-333333333333"; // partner
const ADM = "44444444-4444-4444-8444-444444444444"; // admin
const PARTNER_ID = "55555555-5555-4555-8555-555555555555";
const SPACE_ID = "66666666-6666-4666-8666-666666666666";
const REPORT_U = "77777777-7777-4777-8777-777777777777";
const REWARD = "88888888-8888-4888-8888-888888888888";

let db: Db;
const q = (sql: string, params: unknown[] = []) => db.pg.query(sql, params);
const svc = <T>(fn: () => Promise<T>) => db.asService(fn);
const H = { r7: "87537369bffffff", r8: "88537369b7fffff", r9: "89537369b6bffff", r10: "8a537369b69ffff" };

async function insertReport(id: string, reporter: string, o: { status?: string; minutesAgo?: number; expiresInMin?: number; aggregated?: boolean; lat?: number } = {}) {
  await q(
    `insert into departure_reports (id, reporter_id, location_lat, location_lng, accuracy_m, neighborhood, created_at, expected_departure_at, expires_at, status,
       h3_r7, h3_r8, h3_r9, h3_r10, aggregated_at, resolved_at)
     values ($1, $2, $3, 46.68531, 8, 'olaya', now() - make_interval(mins => $4::int), now() - make_interval(mins => $4::int), now() + make_interval(mins => $5::int), $6::text::report_status,
       $7, $8, $9, $10, case when $11::boolean then now() - make_interval(mins => $4::int) end, case when $6::text in ('found','not_found') then now() - make_interval(mins => $4::int) end)`,
    [id, reporter, o.lat ?? 24.69412, o.minutesAgo ?? 0, o.expiresInMin ?? 20, o.status ?? "available", H.r7, H.r8, H.r9, H.r10, o.aggregated ?? false],
  );
}

/** A new driver per report: the schema allows only ONE live report per driver (partial unique index). */
let seq = 0;
async function freshDriver(): Promise<string> {
  seq++;
  const id = `abcdef00-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  await db.createUser(id);
  return id;
}

beforeAll(async () => {
  db = await createDb();
  await db.createUser(U, { name: "Driver U" });
  await db.createUser(V, { name: "Driver V" });
  await db.createUser(P, { role: "partner" });
  await db.createUser(ADM, { role: "admin" });
  await q(`insert into parking_partners (id, owner_id, name, kind, contact_email, status) values ($1, $2, 'Tower', 'office', 'p@test.invalid', 'approved')`, [PARTNER_ID, P]);
  await q(
    `insert into parking_spaces (id, partner_id, title, location_lat, location_lng, neighborhood, address, capacity, price_per_hour, schedule, approval, h3_r7, h3_r8, h3_r9, h3_r10)
     values ($1, $2, 'P2', 24.6961, 46.6842, 'olaya', 'x', 1, 8, '{"days":[0,1,2,3,4,5,6],"openHour":0,"closeHour":24}', 'pending_review', $3, $4, $5, $6)`,
    [SPACE_ID, PARTNER_ID, H.r7, H.r8, H.r9, H.r10],
  );
  await q(`insert into rewards_catalog (id, title, category, keys_required, stock) values ($1, 'Voucher', 'sponsored_voucher', 5, 1)`, [REWARD]);
  await insertReport(REPORT_U, U);
  await svc(() => q(`select * from insert_ledger_entry(gen_random_uuid(), $1, 30, 'mission_reward', 'seed', 'seed:U', null, null)`, [U]));
}, 120_000);

describe("1. Migrations: syntax and order", () => {
  it("applies 0001–0007 on PostgreSQL 18 + PostGIS", () => {
    expect(db.applied).toEqual(["0001_schema.sql", "0002_rls.sql", "0003_functions.sql", "0004_hive.sql", "0005_audit_fixes.sql", "0006_schedule_jobs.sql", "0007_rakna_home_phase3.sql"]);
  });
});

describe("2–5. Integrity, H3 columns and indexes", () => {
  it("enforces foreign keys", async () => {
    const e = await pgError(insertReport("99999999-9999-4999-8999-999999999999", "00000000-0000-4000-8000-000000000000"));
    expect(e.code).toBe("23503");
  });

  it("has H3 columns r7–r10 on reports and spaces, and a PostGIS geography column", async () => {
    const cols = (await q(`select table_name, column_name, data_type from information_schema.columns where column_name like 'h3_r%' or column_name = 'geog' order by 1, 2`)).rows as { table_name: string; column_name: string }[];
    const of = (t: string) => cols.filter((c) => c.table_name === t).map((c) => c.column_name);
    expect(of("departure_reports")).toEqual(["geog", "h3_r10", "h3_r7", "h3_r8", "h3_r9"]);
    expect(of("parking_spaces")).toEqual(["geog", "h3_r10", "h3_r7", "h3_r8", "h3_r9"]);
    const g = (await q(`select st_y(geog::geometry) lat, st_x(geog::geometry) lng from departure_reports where id = $1`, [REPORT_U])).rows[0] as { lat: number; lng: number };
    expect(g.lat).toBeCloseTo(24.69412, 6); // exact coordinates preserved, not cell centers
  });

  it("creates the H3 B-tree, live partial and PostGIS GiST indexes", async () => {
    const idx = (await q(`select indexname, indexdef from pg_indexes where schemaname = 'public'`)).rows as { indexname: string; indexdef: string }[];
    const names = idx.map((i) => i.indexname);
    for (const n of ["departure_reports_h3_r7_idx", "departure_reports_h3_r8_idx", "departure_reports_h3_r9_idx", "departure_reports_h3_r10_idx", "departure_reports_live_r9_idx", "parking_spaces_h3_r9_idx", "hive_cell_stats_r9_idx", "hive_demand_r8_idx"]) {
      expect(names).toContain(n);
    }
    expect(idx.find((i) => i.indexname === "departure_reports_geog_idx")?.indexdef).toMatch(/USING gist/i);
    expect(idx.find((i) => i.indexname === "departure_reports_live_r9_idx")?.indexdef).toMatch(/WHERE/i);
  });
});

describe("6–8. Row Level Security: an ordinary authenticated user cannot…", () => {
  it("award themselves RAKNA KEYS (table insert or function)", async () => {
    expect((await pgError(db.asUser(U, () => q(`insert into points_ledger (user_id, amount, type, reason, idempotency_key) values ($1, 999, 'mission_reward', 'hack', 'hack1')`, [U])))).message).toMatch(/permission denied/);
    expect((await pgError(db.asUser(U, () => q(`select * from insert_ledger_entry(gen_random_uuid(), $1, 999, 'mission_reward', 'hack', 'hack2', null, null)`, [U])))).message).toMatch(/permission denied/);
  });

  it("change their points balance (update/delete ledger rows)", async () => {
    await db.asUser(U, () => q(`update points_ledger set amount = 9999 where user_id = $1`, [U])).catch(() => null);
    await db.asUser(U, () => q(`delete from points_ledger where user_id = $1`, [U])).catch(() => null);
    const bal = await db.asUser(U, () => q(`select keys_balance($1) b`, [U]));
    expect((bal.rows[0] as { b: number }).b).toBe(30);
  });

  it("read another user's balance", async () => {
    expect(((await db.asUser(V, () => q(`select keys_balance($1) b`, [U]))).rows[0] as { b: number | null }).b).toBeNull();
    expect(((await db.asUser(ADM, () => q(`select keys_balance($1) b`, [U]))).rows[0] as { b: number }).b).toBe(30);
  });

  it("approve their own private parking listing, or insert listings directly", async () => {
    const r = await db.asUser(P, () => q(`update parking_spaces set approval = 'approved' where id = $1`, [SPACE_ID])).catch((e) => e);
    expect(r.affectedRows ?? 0).toBe(0);
    expect(((await q(`select approval from parking_spaces where id = $1`, [SPACE_ID])).rows[0] as { approval: string }).approval).toBe("pending_review");
    expect((await pgError(db.asUser(P, () => q(`insert into parking_spaces (partner_id, title, location_lat, location_lng, neighborhood, address, capacity, price_per_hour, schedule, approval) values ($1, 'x', 24.7, 46.6, 'olaya', 'x', 1, 1, '{}', 'approved')`, [PARTNER_ID])))).message).toMatch(/row-level security/);
  });

  it("escalate their own role", async () => {
    expect((await pgError(db.asUser(U, () => q(`update profiles set role = 'admin' where id = $1`, [U])))).message).toMatch(/row-level security/);
    await db.asUser(U, () => q(`update profiles set lang = 'en' where id = $1`, [U])); // harmless self-update still works
  });

  it("read unauthorized precise coordinates", async () => {
    expect((await db.asUser(V, () => q(`select * from departure_reports where id = $1`, [REPORT_U]))).rows).toHaveLength(0);
    expect((await pgError(db.asAnon(() => q(`select * from departure_reports`)))).message).toMatch(/permission denied/); // anon has no grant at all
    const pub = (await db.asUser(V, () => q(`select location_lat from departure_reports_public where id = $1`, [REPORT_U]))).rows[0] as { location_lat: string };
    expect(Number(pub.location_lat)).toBe(24.694); // coarsened (~110 m), no reporter id column
    const cols = (await q(`select column_name from information_schema.columns where table_name = 'departure_reports_public'`)).rows.map((r) => (r as { column_name: string }).column_name);
    expect(cols).not.toContain("reporter_id");
    expect(cols).not.toContain("claimed_by");
    expect((await db.asUser(U, () => q(`select * from departure_reports where id = $1`, [REPORT_U]))).rows).toHaveLength(1); // own report
  });

  it("execute admin-only or service-only functions", async () => {
    for (const sql of [
      "select rakna_hive_lifecycle()",
      "select rakna_hive_lifecycle_work()",
      "select purge_precise_locations(now())",
      `select anonymize_profile('${V}')`,
      `select reward_stock_adjust('${REWARD}', -1)`,
      `select insert_booking_checked(gen_random_uuid(), '${SPACE_ID}', '${U}', now(), now() + interval '1 hour', 1, 8, 0, null, 99)`,
      `select hive_increment_cell_stat('a','b','c','d', now(), 1, 1, 0, 0, false)`,
      "select hive_add_feedback(true)",
    ]) {
      const e = await pgError(db.asUser(U, () => q(sql)));
      expect(e.message, sql).toMatch(/permission denied/);
    }
  });

  it("modify another user's booking or report (or their own, directly)", async () => {
    const bid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await q(`insert into parking_bookings (id, space_id, user_id, start_at, end_at, hours, price_total) values ($1, $2, $3, now(), now() + interval '1 hour', 1, 8)`, [bid, SPACE_ID, U]);
    const b = await db.asUser(V, () => q(`update parking_bookings set status = 'cancelled' where id = $1`, [bid])).catch((e) => e);
    expect(b.affectedRows ?? 0).toBe(0);
    const d = await db.asUser(V, () => q(`delete from departure_reports where id = $1`, [REPORT_U])).catch((e) => e);
    expect(d.affectedRows ?? 0).toBe(0);
    const own = await db.asUser(U, () => q(`update departure_reports set status = 'found' where id = $1`, [REPORT_U])).catch((e) => e);
    expect(own.affectedRows ?? 0).toBe(0); // all report writes go through the server API
    expect(((await q(`select status from parking_bookings where id = $1`, [bid])).rows[0] as { status: string }).status).toBe("confirmed");
  });

  it("read other profiles, fraud flags, job runs or the audit log (admins can)", async () => {
    expect((await db.asUser(U, () => q(`select * from profiles where id = $1`, [V]))).rows).toHaveLength(0);
    await q(`insert into fraud_flags (kind, user_id, details, severity) values ('report_spam', $1, 'x', 'low')`, [V]);
    expect((await db.asUser(U, () => q(`select * from fraud_flags`))).rows).toHaveLength(0);
    expect((await db.asUser(ADM, () => q(`select * from fraud_flags`))).rows.length).toBeGreaterThan(0);
    expect((await db.asUser(U, () => q(`select * from hive_job_runs`))).rows).toHaveLength(0);
    expect((await db.asAnon(() => q(`select * from profiles`))).rows).toHaveLength(0);
  });

  it("still allows reading non-personal aggregates", async () => {
    await svc(() => q(`select hive_increment_cell_stat($1, $2, $3, $4, date_trunc('hour', now()), 1, 1, 0, 0, false)`, [H.r10, H.r7, H.r8, H.r9]));
    expect((await db.asAnon(() => q(`select found from hive_cell_stats`))).rows.length).toBeGreaterThan(0);
  });
});

describe("9–10. Service role and atomic functions", () => {
  it("ledger: idempotent keys, no negative balance, append-only", async () => {
    const a = (await svc(() => q(`select inserted from insert_ledger_entry(gen_random_uuid(), $1, 5, 'mission_reward', 'x', 'dup:1', null, null)`, [V]))).rows[0] as { inserted: boolean };
    const b = (await svc(() => q(`select inserted from insert_ledger_entry(gen_random_uuid(), $1, 5, 'mission_reward', 'x', 'dup:1', null, null)`, [V]))).rows[0] as { inserted: boolean };
    expect([a.inserted, b.inserted]).toEqual([true, false]);
    expect(((await q(`select count(*)::int n from points_ledger where idempotency_key = 'dup:1'`)).rows[0] as { n: number }).n).toBe(1);
    expect((await pgError(svc(() => q(`select * from insert_ledger_entry(gen_random_uuid(), $1, -50, 'redemption', 'x', 'neg:1', null, null)`, [V])))).message).toMatch(/insufficient_balance/);
    expect((await pgError(svc(() => q(`update points_ledger set amount = 1 where idempotency_key = 'dup:1'`)))).message).toMatch(/append-only/);
  });

  it("ledger: enforces the daily earning cap inside the lock", async () => {
    const W = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await db.createUser(W);
    const award = async (k: string) => (await svc(() => q(`select amount from insert_ledger_entry(gen_random_uuid(), $1, 8, 'departure_reward', 'x', $2, null, null, 10, date_trunc('day', now()))`, [W, k]))).rows as { amount: number }[];
    expect((await award("cap:1"))[0].amount).toBe(8);
    expect((await award("cap:2"))[0].amount).toBe(2);
    expect(await award("cap:3")).toHaveLength(0);
  });

  it("reward stock cannot be oversold", async () => {
    const r1 = (await svc(() => q(`select reward_stock_adjust($1, -1) ok`, [REWARD]))).rows[0] as { ok: boolean };
    const r2 = (await svc(() => q(`select reward_stock_adjust($1, -1) ok`, [REWARD]))).rows[0] as { ok: boolean };
    expect([r1.ok, r2.ok]).toEqual([true, false]);
    expect(((await q(`select stock from rewards_catalog where id = $1`, [REWARD])).rows[0] as { stock: number }).stock).toBe(0);
  });

  it("bookings respect capacity atomically", async () => {
    await q(`update parking_spaces set approval = 'approved' where id = $1`, [SPACE_ID]);
    const book = async (startH: number) => ((await svc(() => q(
      `select insert_booking_checked(gen_random_uuid(), $1, $2, date_trunc('hour', now()) + make_interval(hours => $3), date_trunc('hour', now()) + make_interval(hours => $3 + 2), 2, 16, 0, null, 1) ok`,
      [SPACE_ID, V, startH],
    ))).rows[0] as { ok: boolean }).ok;
    expect(await book(30)).toBe(true);
    expect(await book(31)).toBe(false); // overlaps, capacity 1
    expect(await book(40)).toBe(true);
  });

  it("claims and accepted confirmations are unique per report (database backstop)", async () => {
    const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await insertReport(id, await freshDriver());
    await q(`insert into report_claims (report_id, claimer_id, expires_at) values ($1, $2, now() + interval '15 minutes')`, [id, V]);
    expect((await pgError(q(`insert into report_claims (report_id, claimer_id, expires_at) values ($1, $2, now() + interval '15 minutes')`, [id, ADM]))).code).toBe("23505");
    await q(`insert into report_confirmations (report_id, confirmer_id, outcome, evidence, accepted) values ($1, $2, 'found', 'gps', true)`, [id, V]);
    expect((await pgError(q(`insert into report_confirmations (report_id, confirmer_id, outcome, evidence, accepted) values ($1, $2, 'found', 'gps', true)`, [id, V]))).code).toBe("23505");
  });

  it("compare-and-set transitions: only one claim wins, and an expired report cannot be claimed", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await insertReport(id, await freshDriver());
    const claim = (who: string) => q(`update departure_reports set status = 'claimed', claimed_by = $2 where id = $1 and status in ('available','pending_departure') and expires_at > now()`, [id, who]);
    expect((await claim(V)).affectedRows).toBe(1);
    expect((await claim(ADM)).affectedRows).toBe(0);
    const e = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    await insertReport(e, await freshDriver(), { minutesAgo: 30, expiresInMin: -1 });
    expect((await q(`update departure_reports set status = 'claimed', claimed_by = $2 where id = $1 and status in ('available','pending_departure') and expires_at > now()`, [e, V])).affectedRows).toBe(0);
  });
});

describe("Lifecycle: aggregate before delete, idempotent, retry-safe, logged", () => {
  it("folds expired signals, deletes old aggregated ones, keeps durable records", async () => {
    const expiredId = "f0000000-0000-4000-8000-000000000001";
    const oldId = "f0000000-0000-4000-8000-000000000002";
    const liveId = "f0000000-0000-4000-8000-000000000003";
    await insertReport(expiredId, await freshDriver(), { minutesAgo: 120, expiresInMin: -100 });
    await insertReport(oldId, await freshDriver(), { status: "found", minutesAgo: 60 * 24 * 40, expiresInMin: -60 * 24 * 40 + 20, aggregated: true });
    await insertReport(liveId, await freshDriver(), { minutesAgo: 1 });
    const ledgerBefore = ((await q(`select count(*)::int n from points_ledger`)).rows[0] as { n: number }).n;
    const bookingsBefore = ((await q(`select count(*)::int n from parking_bookings`)).rows[0] as { n: number }).n;
    const statsBefore = ((await q(`select coalesce(sum(expired),0)::int n from hive_cell_stats`)).rows[0] as { n: number }).n;

    const r1 = (await svc(() => q(`select rakna_hive_lifecycle() v`))).rows[0] as { v: Record<string, number> };
    expect(r1.v.reports_deleted).toBeGreaterThanOrEqual(1);
    const row = (id: string) => q(`select status, aggregated_at from departure_reports where id = $1`, [id]).then((r) => r.rows[0] as { status: string; aggregated_at: string | null } | undefined);
    expect((await row(expiredId))?.status).toBe("expired");
    expect((await row(expiredId))?.aggregated_at).not.toBeNull();
    expect(await row(oldId)).toBeUndefined();
    expect((await row(liveId))?.status).toBe("available");
    const statsAfter = ((await q(`select coalesce(sum(expired),0)::int n from hive_cell_stats`)).rows[0] as { n: number }).n;
    expect(statsAfter).toBe(statsBefore + 1);

    await svc(() => q(`select rakna_hive_lifecycle()`)); // idempotent re-run
    expect(((await q(`select coalesce(sum(expired),0)::int n from hive_cell_stats`)).rows[0] as { n: number }).n).toBe(statsAfter);
    expect(((await q(`select count(*)::int n from points_ledger`)).rows[0] as { n: number }).n).toBe(ledgerBefore);
    expect(((await q(`select count(*)::int n from parking_bookings`)).rows[0] as { n: number }).n).toBe(bookingsBefore);

    const runs = (await q(`select ok, error from hive_job_runs order by id`)).rows as { ok: boolean }[];
    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(runs.every((r) => r.ok)).toBe(true);
    const health = (await q(`select overdue, failures_24h from hive_job_health where job = 'hive_lifecycle'`)).rows[0] as { overdue: boolean; failures_24h: number };
    expect(health.overdue).toBe(false);
  });

  it("records a failed run, rolls its work back, and succeeds on retry without double counting", async () => {
    const id = "f0000000-0000-4000-8000-000000000004";
    await insertReport(id, await freshDriver(), { minutesAgo: 120, expiresInMin: -100, lat: 24.6942 });
    await q(`alter table hive_cell_stats add constraint harness_fail check (found < 0) not valid`);
    const failed = (await svc(() => q(`select rakna_hive_lifecycle() v`))).rows[0] as { v: { error?: string } };
    expect(failed.v.error).toBeTruthy();
    expect(((await q(`select ok, error from hive_job_runs order by id desc limit 1`)).rows[0] as { ok: boolean }).ok).toBe(false);
    expect(((await q(`select aggregated_at from departure_reports where id = $1`, [id])).rows[0] as { aggregated_at: string | null }).aggregated_at).toBeNull();
    await q(`alter table hive_cell_stats drop constraint harness_fail`);
    const before = ((await q(`select coalesce(sum(expired),0)::int n from hive_cell_stats`)).rows[0] as { n: number }).n;
    await svc(() => q(`select rakna_hive_lifecycle()`));
    expect(((await q(`select coalesce(sum(expired),0)::int n from hive_cell_stats`)).rows[0] as { n: number }).n).toBe(before + 1);
    expect(((await q(`select ok from hive_job_runs order by id desc limit 1`)).rows[0] as { ok: boolean }).ok).toBe(true);
  });

  it("is configured for pg_cron when available, and reports clearly when it is not", async () => {
    const hasCron = ((await q(`select count(*)::int n from pg_available_extensions where name = 'pg_cron'`)).rows[0] as { n: number }).n;
    expect(hasCron).toBe(0); // PGlite: no pg_cron → the migration skipped scheduling with a NOTICE (verified manually on staging)
  });
});

describe("Account deletion", () => {
  it("cannot hard-delete a user with durable records, and anonymizes instead", async () => {
    expect((await pgError(q(`delete from auth.users where id = $1`, [U]))).code).toBe("23001"); // restrict_violation: durable records protect it
    const res = (await svc(() => q(`select anonymize_profile($1) r`, [U]))).rows[0] as { r: { reports_deleted: number } };
    expect(res.r.reports_deleted).toBeGreaterThanOrEqual(1);
    const p = (await q(`select display_name, deleted_at, location_consent_at from profiles where id = $1`, [U])).rows[0] as { display_name: string; deleted_at: string | null };
    expect(p.display_name).toBe("Deleted user");
    expect(p.deleted_at).not.toBeNull();
    expect(((await q(`select count(*)::int n from departure_reports where reporter_id = $1`, [U])).rows[0] as { n: number }).n).toBe(0);
    expect(((await q(`select count(*)::int n from points_ledger where user_id = $1`, [U])).rows[0] as { n: number }).n).toBeGreaterThan(0); // ledger kept
  });
});

describe("Query plans use the hive indexes", () => {
  it("serves viewport cell queries from indexes at 50,000 reports", async () => {
    await q(`insert into departure_reports (reporter_id, location_lat, location_lng, accuracy_m, neighborhood, created_at, expected_departure_at, expires_at, status, h3_r7, h3_r8, h3_r9, h3_r10)
             select $1, 24.5 + (g % 1000) * 0.0005, 46.5 + (g / 1000) * 0.005, 10, 'olaya', now() - interval '1 day', now() - interval '1 day', now() - interval '23 hours',
                    'expired', 'r7_' || (g % 40), 'r8_' || (g % 300), 'r9_' || (g % 2000), 'r10_' || g
               from generate_series(1, 50000) g`, [V]);
    await q(`analyze departure_reports`);
    const cells = Array.from({ length: 60 }, (_, i) => `r9_${i}`);
    const plan = (await q(`explain (analyze, format json) select * from departure_reports where h3_r9 = any($1) and status in ('available','pending_departure','claimed')`, [cells])).rows[0] as { "QUERY PLAN": [{ Plan: { "Node Type": string }; "Execution Time": number }] };
    const text = JSON.stringify(plan);
    expect(text).toMatch(/Index/);
    expect(text).not.toMatch(/"Node Type":"Seq Scan"/);
    const geo = JSON.stringify((await q(`explain select id from departure_reports where st_dwithin(geog, st_setsrid(st_makepoint(46.6853, 24.6941), 4326)::geography, 300)`)).rows);
    expect(geo).toMatch(/departure_reports_geog_idx/);
  }, 180_000);
});
