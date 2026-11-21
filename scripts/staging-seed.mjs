// STAGING seed (never production). Idempotent: safe to re-run.
//
//   node --env-file=.env.staging.local scripts/staging-seed.mjs
//   node --env-file=.env.staging.local scripts/staging-seed.mjs --make-admin you@yourdomain.com
//
// Creates 4 demo auth users with fixed ids (example.com addresses — they cannot receive
// email; they exist so demo data has owners), upgrades their profiles, and upserts the demo
// partner, spaces (with H3 indexes), rewards, challenges and reward rules. Every row is
// is_demo = true. `--make-admin <email>` promotes YOUR real account (sign in once on the
// staging site first) so you can test the admin dashboard.
import { latLngToCell, cellToParent } from "h3-js";
import { stagingClients } from "./_staging-guard.mjs";

const { admin: db, ref } = stagingClients();
console.log(`Seeding STAGING project ${ref}`);

const must = (res, what) => {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data;
};
const h3 = (lat, lng) => {
  const r10 = latLngToCell(lat, lng, 10);
  return { h3_r10: r10, h3_r9: cellToParent(r10, 9), h3_r8: cellToParent(r10, 8), h3_r7: cellToParent(r10, 7) };
};

const USERS = [
  { id: "00000000-0000-4000-a000-00000000000a", email: "demo-driver-a@example.com", name: "Sara (Demo Driver A)", nameAr: "سارة (سائقة تجريبية أ)", role: "driver", hood: "olaya" },
  { id: "00000000-0000-4000-a000-00000000000b", email: "demo-driver-b@example.com", name: "Faisal (Demo Driver B)", nameAr: "فيصل (سائق تجريبي ب)", role: "driver", hood: "wurud" },
  { id: "00000000-0000-4000-a000-0000000000c1", email: "demo-partner@example.com", name: "Olaya Business Tower (Demo Partner)", nameAr: "برج العليا للأعمال (شريك تجريبي)", role: "partner", hood: "olaya" },
  { id: "00000000-0000-4000-a000-0000000000ad", email: "demo-admin@example.com", name: "Demo Administrator", nameAr: "مشرف تجريبي", role: "admin", hood: "olaya" },
];

// 1) Auth users (the on_auth_user_created trigger creates driver profiles).
for (const u of USERS) {
  const existing = await db.auth.admin.getUserById(u.id);
  if (existing.data?.user) {
    console.log(`  user ${u.email}: exists`);
    continue;
  }
  must(await db.auth.admin.createUser({ id: u.id, email: u.email, email_confirm: true, user_metadata: { display_name: u.name } }), `create ${u.email}`);
  console.log(`  user ${u.email}: created`);
}

// 2) Profiles: names, roles, demo flag.
for (const u of USERS) {
  must(await db.from("profiles").update({ display_name: u.name, display_name_ar: u.nameAr, role: u.role, neighborhood: u.hood, is_demo: true }).eq("id", u.id), `profile ${u.email}`);
}

// 3) Partner, spaces, rewards, challenges, rules.
const PARTNER = "00000000-0000-4000-b000-000000000001";
must(await db.from("parking_partners").upsert({ id: PARTNER, owner_id: USERS[2].id, name: "Olaya Business Tower (Demo)", name_ar: "برج العليا للأعمال (تجريبي)", kind: "office", contact_email: "partner@example.com", cr_number_provided: true, status: "approved", is_demo: true, reviewed_at: new Date().toISOString() }), "partner");

const allWeek = { days: [0, 1, 2, 3, 4, 5, 6], openHour: 6, closeHour: 24 };
const workWeek = { days: [0, 1, 2, 3, 4], openHour: 7, closeHour: 20 };
const spaces = [
  ["00000000-0000-4000-f000-000000000001", "Olaya Tower — Basement P2 (Demo)", "برج العليا — القبو P2 (تجريبي)", 24.6961, 46.6842, "olaya", 12, 8, allWeek, true, 2],
  ["00000000-0000-4000-f000-000000000002", "Olaya Tower — Visitor Deck (Demo)", "برج العليا — مواقف الزوار (تجريبي)", 24.6935, 46.6865, "olaya", 6, 12, workWeek, true, 0],
  ["00000000-0000-4000-f000-000000000003", "Wurud Office Annex (Demo)", "ملحق مكاتب الورود (تجريبي)", 24.7248, 46.6681, "wurud", 8, 6, workWeek, false, 1],
  ["00000000-0000-4000-f000-000000000004", "King Fahd Rd Plaza (Demo)", "ساحة طريق الملك فهد (تجريبي)", 24.7356, 46.6558, "kfr", 20, 10, allWeek, true, 3],
].map(([id, title, title_ar, lat, lng, hood, capacity, price, schedule, reward, bays]) => ({
  id, partner_id: PARTNER, title, title_ar, location_lat: lat, location_lng: lng, neighborhood: hood, address: "Illustrative address (demo)", address_ar: "عنوان توضيحي (تجريبي)",
  capacity, price_per_hour: price, schedule, conditions: "Demo listing. Max vehicle height 2.1 m.", conditions_ar: "إعلان تجريبي. أقصى ارتفاع 2.1 م.",
  reward_eligible: reward, approval: "approved", is_demo: true, accessible_bays: bays, ...h3(lat, lng),
}));
must(await db.from("parking_spaces").upsert(spaces), "spaces");

must(await db.from("rewards_catalog").upsert([
  { id: "00000000-0000-4000-9000-000000000001", title: "20% off a partner parking booking", title_ar: "خصم 20% على حجز موقف شريك", description: "Apply when booking an eligible private space.", description_ar: "يُطبق عند حجز موقف خاص مؤهل.", category: "parking_discount", keys_required: 15, discount_percent: 20, eligibility: "Eligible partner spaces only", eligibility_ar: "مواقف الشركاء المؤهلة فقط", terms: "Simulated. No cash value.", terms_ar: "محاكاة. لا قيمة نقدية.", active: true, stock: null, is_demo: true },
  { id: "00000000-0000-4000-9000-000000000003", title: "Free car-wash voucher (sponsored)", title_ar: "قسيمة غسيل سيارة مجانية (برعاية)", description: "Sponsored voucher from a demo partner.", description_ar: "قسيمة برعاية شريك تجريبي.", category: "sponsored_voucher", keys_required: 25, eligibility: "Drivers in good standing", eligibility_ar: "السائقون ذوو السجل الجيد", terms: "Simulated. Requires admin approval.", terms_ar: "محاكاة. تتطلب موافقة المشرف.", active: true, stock: 20, is_demo: true },
]), "rewards");

must(await db.from("neighborhood_challenges").upsert([
  { id: "00000000-0000-4000-8000-000000000001", title: "Help one driver today", title_ar: "ساعد سائقًا واحدًا اليوم", description: "One verified handoff.", description_ar: "تسليم موثق واحد.", metric: "handoffs_today", target: 1, is_demo: true },
  { id: "00000000-0000-4000-8000-000000000002", title: "Three successful handoffs", title_ar: "ثلاثة تسليمات ناجحة", description: "Three verified reports this week.", description_ar: "ثلاثة بلاغات موثقة هذا الأسبوع.", metric: "handoffs_week", target: 3, is_demo: true },
  { id: "00000000-0000-4000-8000-000000000003", title: "Five verified reports this week", title_ar: "خمسة بلاغات موثقة هذا الأسبوع", description: "Confirmed on site by another driver.", description_ar: "أكدها سائق آخر في الموقع.", metric: "verified_reports_week", target: 5, is_demo: true },
  { id: "00000000-0000-4000-8000-000000000004", title: "Al Olaya community week", title_ar: "أسبوع مجتمع العليا", description: "10 verified handoffs in Al Olaya.", description_ar: "10 تسليمات موثقة في العليا.", metric: "neighborhood_handoffs_week", target: 10, neighborhood: "olaya", is_demo: true },
  { id: "00000000-0000-4000-8000-000000000005", title: "Complete a Park & Connect mission", title_ar: "أكمل مهمة اركن واتصل", description: "Simulated mission.", description_ar: "مهمة محاكاة.", metric: "missions_approved", target: 1, is_demo: true },
]), "challenges");

must(await db.from("app_config").upsert({ key: "reward_rules", value: { departureReward: 8, confirmationReward: 2, streakEvery: 3, streakBonus: 5, missionReward: 10, dailyEarnLimit: 40, dailyReportLimit: 8, reportTtlMinutes: 20, claimTtlMinutes: 15, maxConfirmDistanceM: 120, maxReportAccuracyM: 100, minClaimToConfirmSeconds: 20, locationRetentionHours: 24 } }), "rules");

// 4) Optional: promote the operator's own (real) account to admin.
const i = process.argv.indexOf("--make-admin");
if (i > 0) {
  const email = (process.argv[i + 1] ?? "").toLowerCase();
  let found = null;
  for (let page = 1; page <= 20 && !found; page++) {
    const list = must(await db.auth.admin.listUsers({ page, perPage: 200 }), "list users");
    found = list.users.find((u) => (u.email ?? "").toLowerCase() === email) ?? null;
    if (list.users.length < 200) break;
  }
  if (!found) {
    console.error(`  No auth user with that email. Sign in once on the staging site (/signin), then re-run.`);
    process.exit(1);
  }
  must(await db.from("profiles").update({ role: "admin" }).eq("id", found.id), "promote admin");
  console.log(`  promoted your account (${found.id.slice(0, 8)}…) to admin`);
}
console.log("Done. All seeded rows are is_demo = true.");
