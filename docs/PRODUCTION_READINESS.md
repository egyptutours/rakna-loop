# Production readiness

## What works today without credentials

Everything in demo mode: every screen, the handoff verification, the ledger, rewards, the marketplace, partner and admin dashboards, challenges, the rule-based AI assistant, and AR/EN with RTL.

## What needs credentials (implemented, not yet verified live)

| Integration | Configure | Verify |
|---|---|---|
| **Supabase** (Postgres + Auth) | Create a project. Run `supabase/migrations/0001…0007` in order. Create demo users in Auth and run `supabase/seed.sql`. Set `RAKNA_DATA_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` (server only). | (1) Run the handoff flow, then confirm `points_ledger` rows have the unique keys. (2) Call `insert_ledger_entry` twice with the same key and check it returns `inserted=false`. (3) Attempt a debit beyond the balance and check it raises. (4) Use the anon key to query `departure_reports` and get only your own rows, while `departure_reports_public` returns rounded coordinates. (5) Using the anon key, inserting into `points_ledger` is denied. |
| **Supabase Auth UI** | The MVP ships the demo switcher only. Add a sign-in screen (email OTP or phone OTP) that stores the session and calls `setAuthToken()` in `src/lib/client/api.ts`. | Requests carry `Authorization: Bearer …`; `/api/session` returns the profile. |
| **Anthropic API** | `ANTHROPIC_API_KEY` (server only). Optionally set `ANTHROPIC_MODEL` (default `claude-opus-5-5`). Uses structured outputs with server-side refusal fallback. | The assistant page shows "Claude-assisted understanding" and the result chips show "Understood by Claude". |
| **Map tiles** | For production traffic, use a commercial or self-hosted tile provider via `NEXT_PUBLIC_MAP_STYLE_URL`. OSM's public tile servers are not meant for heavy production use. | Attribution is visible; tiles load under expected load. |

## Go-live checklist

### Security & infrastructure
- [ ] Replace the demo switcher with Supabase Auth. Remove or disable `/api/demo` and `/api/session` POST (already 403 outside demo mode).
- [x] Shared rate limiting (B2, Phase 3): `check_rate_limit()` + `rate_limits` table (0007); every API route `await`s `rateLimit()`, which uses the DB counter in Supabase mode and falls back to the in-process limiter if the DB call fails (never unlimited). Verified in `tests/db/phase3-sql.test.ts` and `tests/security-phase3.test.ts`. **Verify on staging.**
- [x] ~~Replace `withLock` best effort~~: compare-and-set transitions plus atomic SQL functions (Phase 2 audit, verified in tests).
- [x] Location purge scheduled: it runs inside `rakna_hive_lifecycle()` (pg_cron via 0006). **Verify on staging.**
- [ ] Run the staging checklist in `docs/STAGING.md` §9 end to end (nothing live has been verified yet), now including 0007.
- [x] Local JWT verification (optional): set `SUPABASE_JWKS_URL` (ES256/RS256 keys). `src/lib/auth/jwt.ts` checks signature, kid, exp/nbf, issuer and `aud=authenticated`; an invalid token is rejected outright, and only a JWKS *fetch* failure falls back to `auth.getUser()`. HS256 (legacy shared secret) projects keep the remote check.
- [x] Auth-identity soft-deletion after `anonymize_profile` (`auth.admin.deleteUser(id, true)` in `SupabaseRepo.anonymizeProfile`); failures are logged for manual follow-up. 0007's `anonymize_profile` also revokes the user's live access credentials.
- [x] Paginated admin and partner lists (B7): `GET /api/admin/list?entity=profiles|partners|spaces|bookings&limit&cursor`, `GET /api/partner/bookings?limit&cursor` (keyset on `created_at,id`). The admin overview caps profiles at 100 (pending deletions always included).
- [x] PII stripped before the optional AI parser (`src/lib/security/pii.ts`: emails, Saudi phones, national ID/Iqama, IBAN, cards, plates; Arabic-Indic digits normalised).
- [ ] PSP integration: `POST /api/webhooks/psp` verifies `x-rakna-signature` (HMAC-SHA256 over `t.body`, 5-minute replay window) with `RAKNA_PSP_WEBHOOK_SECRET`. Adapt the header format to the chosen licensed PSP and add the checkout redirect. With the secret set, new schedule bookings start `pending` and access stays locked until `paid`.
- [ ] Load test against a real Postgres with concurrent connections and Supavisor pooling; profile browser memory on low-end phones.
- [ ] Add a Content-Security-Policy (allow the tile host, the Supabase host and self).
- [ ] Error monitoring (e.g. Sentry) with PII scrubbing; structured audit export.
- [ ] Backups, point-in-time recovery, and choice of data residency region (see legal questions).
- [ ] Penetration test and RLS review by a third party.

### RAKNA HOME / PARTNERS / PARK & CONNECT (Phase 3)
- [ ] Apply `0007_rakna_home_phase3.sql` on staging; run `tests/db/phase3-sql.test.ts`-equivalent checks against it (entitlement constraints, privacy point, credential RLS, buffered booking, `hive_viewport()`). Rollback: `supabase/rollback/0007_down.sql` (destroys Phase 3 data — back up first).
- [ ] Entitlement review runbook for admins: title deed (صك), owner's wakalah, Ejar contract + written landlord consent, owners' association resolution, CR. Documents are reviewed out-of-band and **never stored**; only the type and the consent timestamp are.
- [ ] Villa bookings stay **off** (`villaBookingsEnabled=false`, waitlist-only) until the municipal pilot approval. Admin → Rules → "Enable villa bookings" flips it (audited, same transaction in SQL).
- [ ] ZATCA review of the fee split before real money moves: 5% driver fee + 15% host commission = platform fee; VAT 15% on the platform fee (after any Keys discount); host payout = 85% of base. E-invoicing (Fatoora) for the platform fee.
- [ ] Gate integrations per site (PIN pads, QR scanners, guard apps). Today credentials are generated and revealed but not pushed to hardware.
- [ ] Replace the illustrative Metro anchors (`DEMO_METRO_STATIONS`) with official Riyadh Metro station data.
- [ ] Incident handling SLA for `bay_blocked_reported` (support contact, rebooking, refunds).

### Hive Intelligence
- [ ] Apply `0004_hive.sql`; back-fill `h3_r7…h3_r10` for existing rows (h3-js script or `h3-pg`).
- [x] `rakna_hive_lifecycle()` scheduled with pg_cron every 5 minutes (migration 0006), with run log and health view. **Verify on staging** (`cron.job`, `hive_job_health`).
- [ ] Replace demo transit points with an authoritative transit feed, or remove them.
- [ ] Calibrate state thresholds, half-lives and retention with real usage (see docs/HIVE.md §4).
- [ ] Move cell-summary caching to a shared store for multi-instance deployments (rate limiting is shared since 0007).
- [x] One database round trip per map viewport in Supabase mode: `hive_viewport()` (0007).
- [ ] Establish a measured baseline (survey or control group) before reporting any "search time saved".

### Product & trust
- [ ] Real partner onboarding: verify the Commercial Registration (CR) and proof of authority over the parking; signed partner agreement.
- [ ] Real reward fulfilment with partners (codes, expiry, reconciliation). Today redemptions are simulated.
- [ ] Payment provider integration for bookings (Mada, Apple Pay, STC Pay via a licensed PSP). Today bookings are simulated.
- [ ] Calibrate fraud thresholds with real data; add device attestation and anomaly scoring.
- [ ] Moderation tooling for notes; abuse reporting.
- [ ] Accessibility audit (WCAG 2.2 AA) in both languages; real-device QA on iOS and Android.
- [ ] Load test map and confirmation endpoints.

### Data & analytics
- [ ] Privacy-preserving analytics (aggregated, no precise location).
- [ ] Data retention schedule for all tables, signed off by counsel.

## Saudi legal & operational questions for professional review

**Loyalty points & financial regulation**
1. Do RAKNA KEYS, as non-transferable, non-cashable loyalty points redeemable for third-party discounts, fall under any SAMA rules (e-money, stored value, payment services) or Ministry of Commerce rules on loyalty and promotional programs?
2. Are there consumer-protection requirements for loyalty terms (expiry, forfeiture on account deletion, changes to earn and burn rates, disclosure language in Arabic)?
3. If partners fund discounts, how should settlement between the platform and partners be structured and taxed (VAT treatment of discounted bookings and of points)?
4. Do sponsored vouchers or prize-like challenges trigger rules on commercial competitions or promotions (licensing or approval)?

**Parking & municipal**
5. Is sharing informational "I'm leaving" signals about public street parking permissible under Riyadh municipality and Remat Al Riyadh (parking operator) regulations? Is coordination or a data partnership needed?
6. What rules apply to commercially listing private parking (building permits, land-use and zoning, commercial activity licensing for hotels and offices offering paid parking)?
7. Liability allocation: incidents at private spaces, signals that were wrong, fines incurred by users, and disputes between drivers.
8. Is integration with transit (Riyadh Metro, RCRC) or Park & Ride programs possible, and what approvals or data-sharing agreements does it need?

**RAKNA HOME (residential sharing)**
17. Does renting out a residential parking bay require a municipal (Balady) permit or a commercial activity licence for the host or the platform? Is the villa pilot best run under a municipal sandbox?
18. Ejar: is a tenant's sub-letting of a parking bay lawful with the landlord's written consent, and what evidence should the platform retain without storing the contract?
19. Owners' associations (Mullak): what resolution is needed to rent common-property bays, and who receives the income?
20. Host income: VAT registration thresholds and withholding obligations for individual hosts; ZATCA treatment of the platform fee and of RAKNA KEYS discounts on it.
21. Liability and insurance for damage, theft or towing in a residential bay; overstay charges (1.5×) and blocked-bay disputes.

**Data protection (PDPL)**
9. Lawful basis and consent wording for collecting precise location, and whether location counts as sensitive data under the PDPL and its implementing regulations.
10. Data residency: must personal data (including location) be stored and processed in the Kingdom? Is a Supabase or Vercel region outside KSA acceptable, and are SDAIA transfer approvals required?
11. Retention limits and data-subject rights handling (access, correction, deletion timelines), plus breach-notification obligations.
12. Is processing by the AI provider (Anthropic) for request parsing a cross-border transfer requiring safeguards? Should the AI feature be opt-in?

**Platform operations**
13. Commercial registration and licensing for the operating entity (e-commerce law, a Maroof or Saudi Business Center listing).
14. App store and telecom requirements (Arabic-first terms, CITC/CST obligations if applicable).
15. Safety duty of care: in-app warnings against using the app while driving, and whether a "passenger mode" or speed lockout is advisable.
16. Content rules for user notes and display names (anti-harassment, prohibited content).
