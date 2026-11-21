import { beforeAll, describe, expect, it } from "vitest";
import { createDb, pgError, type Db } from "./harness";

/**
 * Migration 0007 (RAKNA HOME / Phase 3) on real PostgreSQL 18 (PGlite) with Supabase roles.
 * Covers the storage-layer backstops: Saudi entitlement rules, the residential privacy
 * point, villa waitlist switch, the buffered booking function, the RAKNA KEYS value
 * firewall, strict credential RLS, the shared rate limiter and hive_viewport().
 */

const HOST = "a0000000-0000-4000-8000-000000000001";
const GUEST = "a0000000-0000-4000-8000-000000000002";
const OTHER = "a0000000-0000-4000-8000-000000000003";
const ADMIN = "a0000000-0000-4000-8000-000000000004";
const HOST_PARTNER = "b0000000-0000-4000-8000-000000000001";
const OP = "a0000000-0000-4000-8000-000000000005";
const OP_PARTNER = "b0000000-0000-4000-8000-000000000002";
const CONDO = "c0000000-0000-4000-8000-000000000001";
const VILLA = "c0000000-0000-4000-8000-000000000002";
const COMMERCIAL = "c0000000-0000-4000-8000-000000000003";
const H = { r7: "87537369bffffff", r8: "88537369b7fffff", r9: "89537369b6bffff", r10: "8a537369b69ffff" };
const EXACT = { lat: 24.69611, lng: 46.68423 };

let db: Db;
const q = (sql: string, params: unknown[] = []) => db.pg.query(sql, params);
let n = 0;
const uuid = () => `d0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const at = (minutesFromNow: number) => new Date(Math.floor(Date.now() / 60_000) * 60_000 + minutesFromNow * 60_000).toISOString();

/** Integer-halalas fare consistent with HOME_FEES (5% driver fee, 15% commission, 15% VAT on the platform fee). */
function fare(base: number, keys = 0) {
  const driverFee = Math.round(base * 0.05);
  const commission = Math.round(base * 0.15);
  const vat = Math.round((driverFee + commission - keys) * 0.15);
  return {
    base_fare_halalas: base, driver_fee_halalas: driverFee, host_commission_halalas: commission, vat_on_platform_fee_halalas: vat,
    keys_discount_halalas: keys, host_net_payout_halalas: base - commission, driver_total_halalas: base + driverFee + vat - keys,
  };
}

function booking(space: string, user: string, startMin: number, endMin: number, extra: Record<string, unknown> = {}) {
  const f = fare(1000);
  return {
    id: uuid(), space_id: space, user_id: user, start_at: at(startMin), end_at: at(endMin), hours: Math.max(1, Math.ceil((endMin - startMin) / 60)),
    price_total: f.driver_total_halalas / 100, discount_applied: 0, redemption_id: null, status: "confirmed", simulated_payment: true,
    ...f, payment_status: "simulated", ...extra,
  };
}

async function book(b: Record<string, unknown>, capacity = 1, buffer = 0, credential: unknown = null): Promise<string> {
  const r = await db.asService(() => q("select insert_booking_checked($1::jsonb, $2, $3, $4::jsonb) as r", [JSON.stringify(b), capacity, buffer, credential === null ? null : JSON.stringify(credential)]));
  return (r.rows[0] as { r: string }).r;
}

async function insertResidential(id: string, category: string, entitlement: string, o: { consent?: boolean; approval?: string; verification?: string; access?: string; buffer?: number } = {}) {
  await q(
    `insert into parking_spaces (id, partner_id, host_id, title, location_lat, location_lng, neighborhood, address, capacity, price_per_hour, schedule,
       approval, verification_status, space_category, entitlement_type, landlord_consent_at, access_mode, buffer_minutes, h3_r7, h3_r8, h3_r9, h3_r10)
     values ($1, $2, $3, 'Bay', $4, $5, 'olaya', '12 Private St', 1, 10, '{"days":[0,1,2,3,4,5,6],"openHour":0,"closeHour":24}',
       $6, $7, $8, $9, case when $10::boolean then now() end, $11, $12, $13, $14, $15, $16)`,
    [id, HOST_PARTNER, HOST, EXACT.lat, EXACT.lng, o.approval ?? "approved", o.verification ?? "verified", category, entitlement, o.consent ?? false, o.access ?? "ephemeral_pin", o.buffer ?? 30, H.r7, H.r8, H.r9, H.r10],
  );
}

beforeAll(async () => {
  db = await createDb();
  await db.createUser(HOST, { name: "Host" });
  await db.createUser(GUEST, { name: "Guest" });
  await db.createUser(OTHER, { name: "Other" });
  await db.createUser(ADMIN, { role: "admin" });
  await db.createUser(OP, { role: "partner" });
  await q(`insert into parking_partners (id, owner_id, name, kind, contact_email, status) values ($1, $2, 'Host (RAKNA HOME host)', 'residential', '', 'approved')`, [HOST_PARTNER, HOST]);
  await q(`insert into parking_partners (id, owner_id, name, kind, contact_email, status) values ($1, $2, 'KAFD Garage', 'operator', 'op@test.invalid', 'approved')`, [OP_PARTNER, OP]);
  await insertResidential(CONDO, "condo_deeded", "deed_owner");
  await insertResidential(VILLA, "villa_shaded", "deed_owner", { access: "unobstructed", buffer: 0 });
  await q(
    `insert into parking_spaces (id, partner_id, title, location_lat, location_lng, neighborhood, address, capacity, price_per_hour, schedule, approval, h3_r7, h3_r8, h3_r9, h3_r10)
     values ($1, $2, 'KAFD P1', 24.7672, 46.6436, 'kfr', 'KAFD', 5, 10, '{"days":[0,1,2,3,4,5,6],"openHour":0,"closeHour":24}', 'approved', $3, $4, $5, $6)`,
    [COMMERCIAL, OP_PARTNER, H.r7, H.r8, H.r9, H.r10],
  );
}, 120_000);

describe("0007 · schema and defaults", () => {
  it("applies on top of 0001–0006 and seeds platform settings (villa bookings off)", async () => {
    expect(db.applied.at(-1)).toBe("0007_rakna_home_phase3.sql");
    const r = await q("select value from app_config where key = 'platform_settings'");
    expect((r.rows[0] as { value: { villaBookingsEnabled: boolean } }).value.villaBookingsEnabled).toBe(false);
  });

  it("treats an approved commercial space as verified and publishes its exact point", async () => {
    const r = await q("select verification_status, public_lat, location_lat from parking_spaces where id = $1", [COMMERCIAL]);
    const row = r.rows[0] as { verification_status: string; public_lat: number; location_lat: number };
    expect(row.verification_status).toBe("verified");
    expect(row.public_lat).toBe(row.location_lat);
  });
});

describe("0007 · Saudi entitlement rules (storage backstop)", () => {
  it("rejects a building common-property bay listed by anyone but the owners' association", async () => {
    const e = await pgError(insertResidential(uuid(), "condo_association", "deed_owner"));
    expect(e.code).toBe("23514");
    await expect(insertResidential(uuid(), "condo_association", "owners_association")).resolves.toBeUndefined();
  });

  it("rejects an Ejar tenant listing without landlord consent", async () => {
    expect((await pgError(insertResidential(uuid(), "villa_open", "ejar_authorized"))).code).toBe("23514");
    await expect(insertResidential(uuid(), "villa_open", "ejar_authorized", { consent: true })).resolves.toBeUndefined();
  });

  it("rejects a commercial CR on a residential category and vice versa", async () => {
    expect((await pgError(insertResidential(uuid(), "villa_garage", "commercial_cr"))).code).toBe("23514");
  });

  it("refuses to approve an unverified residential space", async () => {
    expect((await pgError(insertResidential(uuid(), "condo_deeded", "deed_owner", { verification: "pending" }))).code).toBe("23514");
  });
});

describe("0007 · residential privacy point and RLS", () => {
  it("stores a coarsened (~150 m) public point that is never the exact location", async () => {
    const r = await q("select public_lat, public_lng from parking_spaces where id = $1", [CONDO]);
    const p = r.rows[0] as { public_lat: number; public_lng: number };
    expect(p.public_lat === EXACT.lat && p.public_lng === EXACT.lng).toBe(false);
    const dLatM = Math.abs(p.public_lat - EXACT.lat) * 111_000;
    const dLngM = Math.abs(p.public_lng - EXACT.lng) * 101_000;
    expect(Math.hypot(dLatM, dLngM)).toBeLessThan(200);
  });

  it("hides residential rows (exact point, address) from other users; the public view has no address", async () => {
    const direct = await db.asUser(OTHER, () => q("select id from parking_spaces where id = $1", [CONDO]));
    expect(direct.rows).toHaveLength(0);
    const pub = await db.asUser(OTHER, () => q("select location_lat, address from parking_spaces_public where id = $1", [CONDO]));
    const row = pub.rows[0] as { location_lat: number; address: string };
    expect(row.address).toBe("");
    expect(row.location_lat).not.toBe(EXACT.lat);
    const anon = await db.asAnon(() => q("select address from parking_spaces_public where id = $1", [COMMERCIAL]));
    expect((anon.rows[0] as { address: string }).address).toBe("KAFD");
  });

  it("lets the host and admins read the full residential row", async () => {
    expect((await db.asUser(HOST, () => q("select address from parking_spaces where id = $1", [CONDO]))).rows).toHaveLength(1);
    expect((await db.asUser(ADMIN, () => q("select address from parking_spaces where id = $1", [CONDO]))).rows).toHaveLength(1);
  });

  it("does not publish a residential host's partner record (display name)", async () => {
    const r = await db.asUser(OTHER, () => q("select id from parking_partners where id = $1", [HOST_PARTNER]));
    expect(r.rows).toHaveLength(0);
  });
});

describe("0007 · villa waitlist switch", () => {
  it("onboards villas as waitlist-only and flips them with set_platform_settings()", async () => {
    const before = await q("select waitlist_only from parking_spaces where id = $1", [VILLA]);
    expect((before.rows[0] as { waitlist_only: boolean }).waitlist_only).toBe(true);
    const condo = await q("select waitlist_only from parking_spaces where id = $1", [CONDO]);
    expect((condo.rows[0] as { waitlist_only: boolean }).waitlist_only).toBe(false);

    // Clients cannot flip it.
    expect((await pgError(db.asUser(HOST, () => q(`select set_platform_settings('{"villaBookingsEnabled":true}')`)))).code).toBe("42501");

    await db.asService(() => q(`select set_platform_settings('{"villaBookingsEnabled":true}')`));
    expect((await q("select waitlist_only from parking_spaces where id = $1", [VILLA])).rows[0]).toEqual({ waitlist_only: false });
    await db.asService(() => q(`select set_platform_settings('{"villaBookingsEnabled":false}')`));
    expect((await q("select waitlist_only from parking_spaces where id = $1", [VILLA])).rows[0]).toEqual({ waitlist_only: true });
  });

  it("refuses to book a waitlisted villa", async () => {
    const e = await pgError(book(booking(VILLA, GUEST, 600, 660)));
    expect(e.message).toContain("space_not_bookable");
  });
});

describe("0007 · insert_booking_checked(): buffers, firewall, credentials", () => {
  it("books, auto-provisions a 6-digit PIN, and counts the 30-minute turnaround buffer", async () => {
    const first = booking(CONDO, GUEST, 24 * 60, 24 * 60 + 120);
    expect(await book(first)).toBe("ok");
    const cred = await q("select credential_type, secret_payload, valid_from, valid_until from booking_access_credentials where booking_id = $1", [first.id]);
    const c = cred.rows[0] as { credential_type: string; secret_payload: string; valid_from: Date; valid_until: Date };
    expect(c.credential_type).toBe("pin");
    expect(c.secret_payload).toMatch(/^\d{6}$/);
    expect(new Date(c.valid_from).getTime()).toBe(Date.parse(first.start_at) - 10 * 60_000);

    // Starts 15 min after the first ends: inside the 30-min buffer → refused, even though the raw times don't overlap.
    expect(await book(booking(CONDO, OTHER, 24 * 60 + 135, 24 * 60 + 200), 1, 0)).toBe("capacity_full");
    // Starts 30 min after → allowed.
    expect(await book(booking(CONDO, OTHER, 24 * 60 + 150, 24 * 60 + 210))).toBe("ok");
  });

  it("serializes many attempts at the same slot: exactly one wins", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => book(booking(CONDO, OTHER, 48 * 60, 48 * 60 + 60))));
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
  });

  it("refuses a host booking their own space", async () => {
    expect((await pgError(book(booking(CONDO, HOST, 72 * 60, 72 * 60 + 60)))).message).toContain("cannot_book_own_space");
  });

  it("RAKNA KEYS firewall: host payout cannot be reduced and Keys cap at 20% of the platform fee", async () => {
    const cut = booking(CONDO, GUEST, 96 * 60, 96 * 60 + 60, { host_net_payout_halalas: 800 }); // should be 850
    expect((await pgError(book(cut))).code).toBe("23514");
    const tooMuchKeys = booking(CONDO, GUEST, 96 * 60, 96 * 60 + 60, fare(1000, 41)); // platform fee 200 → max 40
    expect((await pgError(book(tooMuchKeys))).code).toBe("23514");
    expect(await book(booking(CONDO, GUEST, 96 * 60, 96 * 60 + 60, fare(1000, 40)))).toBe("ok");
  });

  it("allows bookings up to 30 days (hours ≤ 720)", async () => {
    expect(await book(booking(COMMERCIAL, GUEST, 10 * 24 * 60, 10 * 24 * 60 + 600 * 60), 5)).toBe("ok");
  });

  it("legacy insert_booking_checked() also honours the space buffer", async () => {
    const r = await db.asService(() =>
      q("select insert_booking_checked(gen_random_uuid(), $1, $2, $3, $4, 1, 10, 0, null, 1) as ok", [CONDO, OTHER, at(24 * 60 + 220), at(24 * 60 + 280)]),
    );
    expect((r.rows[0] as { ok: boolean }).ok).toBe(false); // 10 min after a booking ending at +210 with a 30-min buffer
  });
});

describe("0007 · credential RLS (strict)", () => {
  let live: string;
  let future: string;
  let unpaid: string;

  beforeAll(async () => {
    const b1 = booking(CONDO, GUEST, -5, 90);
    const b2 = booking(CONDO, GUEST, 200 * 60, 200 * 60 + 60);
    const b3 = booking(CONDO, OTHER, 300 * 60, 300 * 60 + 60, { payment_status: "pending" });
    expect(await book(b1)).toBe("ok");
    expect(await book(b2)).toBe("ok");
    expect(await book(b3)).toBe("ok");
    [live, future, unpaid] = [b1.id, b2.id, b3.id];
    // Make the unpaid credential's window current, to prove payment (not time) is what hides it.
    await q("update booking_access_credentials set valid_from = now() - interval '1 minute', valid_until = now() + interval '1 hour' where booking_id = $1", [unpaid]);
  });

  const sees = (uid: string, booking: string) => db.asUser(uid, () => q("select secret_payload from booking_access_credentials where booking_id = $1", [booking])).then((r) => r.rows.length === 1);

  it("the confirmed guest sees the credential only inside its active window", async () => {
    expect(await sees(GUEST, live)).toBe(true);
    expect(await sees(GUEST, future)).toBe(false);
  });

  it("other drivers and anonymous callers never see it", async () => {
    expect(await sees(OTHER, live)).toBe(false);
    expect((await pgError(db.asAnon(() => q("select * from booking_access_credentials")))).code).toBe("42501");
  });

  it("an unpaid (pending) booking reveals nothing to the guest", async () => {
    expect(await sees(OTHER, unpaid)).toBe(false);
  });

  it("the host and admins can see it; a revoked credential disappears for the guest", async () => {
    expect(await sees(HOST, future)).toBe(true);
    expect(await sees(ADMIN, live)).toBe(true);
    await q("update booking_access_credentials set revoked_at = now() where booking_id = $1", [live]);
    expect(await sees(GUEST, live)).toBe(false);
  });

  it("clients cannot write credentials or events", async () => {
    expect((await pgError(db.asUser(GUEST, () => q("update booking_access_credentials set valid_until = now() + interval '9 days'")))).code).toBe("42501");
    expect((await pgError(db.asUser(GUEST, () => q("insert into booking_events (booking_id, actor_id, event_type) values ($1, $2, 'arrived')", [live, GUEST])))).code).toBe("42501");
  });
});

describe("0007 · extend_booking_checked()", () => {
  it("refuses an extension into the next booking's buffer and allows it otherwise", async () => {
    const a = booking(CONDO, GUEST, 500 * 60, 500 * 60 + 60);
    const b = booking(CONDO, OTHER, 500 * 60 + 120, 500 * 60 + 180);
    expect(await book(a)).toBe("ok");
    expect(await book(b)).toBe("ok");
    const extend = (endMin: number) =>
      db.asService(() => q("select extend_booking_checked($1, $2, $3::jsonb, 1, 30, $4) as r", [a.id, at(endMin), JSON.stringify({ hours: 2, ...fare(2000), price_total: 21.6 }), at(endMin + 15)]));
    expect((await extend(500 * 60 + 120)).rows[0]).toEqual({ r: null }); // would end where b starts (buffer 30)
    const ok = (await extend(500 * 60 + 90)).rows[0] as { r: { end_at: string; base_fare_halalas: number } };
    expect(ok.r.base_fare_halalas).toBe(2000);
    const cred = await q("select valid_until from booking_access_credentials where booking_id = $1", [a.id]);
    expect(new Date((cred.rows[0] as { valid_until: Date }).valid_until).toISOString()).toBe(at(500 * 60 + 105));
  });
});

describe("0007 · replace_availability_rules()", () => {
  it("replaces the weekly set atomically and validates every rule", async () => {
    const rules = [
      { weekday_mask: 31, start_minute: 420, end_minute: 1080, hourly_rate_halalas: 800, daily_cap_halalas: 5000, multi_day_discount_bps: 1000 },
      { weekday_mask: 96, start_minute: 0, end_minute: 1440, hourly_rate_halalas: 600, daily_cap_halalas: null, multi_day_discount_bps: 0 },
    ];
    const r = await db.asService(() => q("select * from replace_availability_rules($1, $2::jsonb)", [CONDO, JSON.stringify(rules)]));
    expect(r.rows).toHaveLength(2);
    await db.asService(() => q("select * from replace_availability_rules($1, $2::jsonb)", [CONDO, JSON.stringify([rules[0]])]));
    expect((await q("select count(*)::int as c from space_availability_rules where space_id = $1", [CONDO])).rows[0]).toEqual({ c: 1 });
    const bad = [{ ...rules[0], end_minute: 300 }];
    expect((await pgError(db.asService(() => q("select * from replace_availability_rules($1, $2::jsonb)", [CONDO, JSON.stringify(bad)]))))).toMatchObject({ code: "23514" });
    // The failed call rolled back: the previous rule survives.
    expect((await q("select count(*)::int as c from space_availability_rules where space_id = $1", [CONDO])).rows[0]).toEqual({ c: 1 });
  });

  it("other users can read the pricing of a listed residential space, but never write it", async () => {
    expect((await db.asUser(OTHER, () => q("select hourly_rate_halalas from space_availability_rules where space_id = $1", [CONDO]))).rows).toHaveLength(1);
    expect((await pgError(db.asUser(HOST, () => q("delete from space_availability_rules where space_id = $1", [CONDO])))).code).toBe("42501");
  });

  it("one exception per space and date; blocked rows carry no override hours", async () => {
    await q("insert into space_availability_exceptions (space_id, exception_date, is_blocked) values ($1, '2026-12-02', true)", [CONDO]);
    expect((await pgError(q("insert into space_availability_exceptions (space_id, exception_date, is_blocked) values ($1, '2026-12-02', true)", [CONDO]))).code).toBe("23505");
    expect((await pgError(q("insert into space_availability_exceptions (space_id, exception_date, is_blocked, override_start_minute, override_end_minute) values ($1, '2026-12-03', true, 60, 120)", [CONDO]))).code).toBe("23514");
  });
});

describe("0007 · check_rate_limit() (shared across instances)", () => {
  it("counts per key and fixed window in the database", async () => {
    const call = (key: string, nowIso: string) => db.asService(() => q("select check_rate_limit($1, 3, 60, $2) as ok", [key, nowIso])).then((r) => (r.rows[0] as { ok: boolean }).ok);
    const t = "2026-11-20T10:00:05Z";
    expect([await call("booking:u1", t), await call("booking:u1", t), await call("booking:u1", t), await call("booking:u1", t)]).toEqual([true, true, true, false]);
    expect(await call("booking:u2", t)).toBe(true);
    expect(await call("booking:u1", "2026-11-20T10:01:01Z")).toBe(true);
  });

  it("is not callable by clients and its table is not readable", async () => {
    expect((await pgError(db.asUser(GUEST, () => q("select check_rate_limit('x', 1, 60)")))).code).toBe("42501");
    expect((await pgError(db.asUser(GUEST, () => q("select * from rate_limits")))).code).toBe("42501");
  });
});

describe("0007 · hive_viewport() single round trip", () => {
  it("returns reports, spaces, cell stats and demand for a viewport", async () => {
    await q(
      `insert into departure_reports (id, reporter_id, location_lat, location_lng, accuracy_m, neighborhood, expected_departure_at, expires_at, status, h3_r7, h3_r8, h3_r9, h3_r10)
       values (gen_random_uuid(), $1, 24.6941, 46.6853, 8, 'olaya', now(), now() + interval '20 minutes', 'available', $2, $3, $4, $5)`,
      [GUEST, H.r7, H.r8, H.r9, H.r10],
    );
    await db.asService(() => q("select hive_increment_cell_stat($1, $2, $3, $4, date_trunc('hour', now()), 1, 1, 0, 0, false)", [H.r10, H.r7, H.r8, H.r9]));
    await db.asService(() => q("select hive_increment_demand($1, date_trunc('hour', now()), 2, false, $2, $3)", [H.r9, H.r8, H.r7]));
    const r = await db.asService(() =>
      q("select hive_viewport(9, $1, array['available'], 100, 9, $1, 9, $1, now() - interval '1 day') as v", [[H.r9]]),
    );
    const v = (r.rows[0] as { v: { reports: unknown[]; spaces: { geog?: unknown }[]; cell_stats: { cell: string }[]; demand: { searches: number }[] } }).v;
    expect(v.reports.length).toBeGreaterThanOrEqual(1);
    expect(v.spaces.length).toBeGreaterThanOrEqual(2);
    expect(v.spaces[0].geog).toBeUndefined();
    expect(v.cell_stats[0].cell).toBe(H.r10);
    expect(v.demand[0].searches).toBe(2);
  });

  it("exact coordinates never reach clients through it", async () => {
    const e = await pgError(db.asUser(GUEST, () => q("select hive_viewport(9, array[]::text[], array['available'], 10, 9, array[]::text[], 9, array[]::text[], now())")));
    expect(e.code).toBe("42501");
  });
});

describe("0007 · account deletion", () => {
  it("anonymize_profile() revokes the user's live access credentials", async () => {
    const b = booking(CONDO, OTHER, 900 * 60, 900 * 60 + 60);
    expect(await book(b)).toBe("ok");
    await q("update profiles set deletion_requested_at = now() where id = $1", [OTHER]);
    const r = await db.asService(() => q("select anonymize_profile($1) as r", [OTHER]));
    expect((r.rows[0] as { r: { credentials_revoked: number } }).r.credentials_revoked).toBeGreaterThanOrEqual(1);
    const c = await q("select revoked_at from booking_access_credentials where booking_id = $1", [b.id]);
    expect((c.rows[0] as { revoked_at: Date | null }).revoked_at).not.toBeNull();
  });
});
