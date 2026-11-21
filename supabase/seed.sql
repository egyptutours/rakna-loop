-- ════════════════════════════════════════════════════════════════════
-- RAKNA LOOP — DEMO seed for a Supabase project (all rows is_demo = true).
-- Illustrative Riyadh points; NOT real, currently available parking.
--
-- Prerequisite: create these four users in Supabase Auth first (Dashboard →
-- Authentication → Add user), then replace the UUIDs below with theirs, or
-- run with the same UUIDs via the Admin API. The on_auth_user_created trigger
-- creates driver profiles; this script upgrades roles and names.
-- ════════════════════════════════════════════════════════════════════

update profiles set display_name = 'Sara (Demo Driver A)', display_name_ar = 'سارة (سائقة تجريبية أ)', neighborhood = 'olaya', is_demo = true
 where id = '00000000-0000-4000-a000-00000000000a';
update profiles set display_name = 'Faisal (Demo Driver B)', display_name_ar = 'فيصل (سائق تجريبي ب)', neighborhood = 'wurud', is_demo = true
 where id = '00000000-0000-4000-a000-00000000000b';
update profiles set display_name = 'Olaya Business Tower (Demo Partner)', display_name_ar = 'برج العليا للأعمال (شريك تجريبي)', role = 'partner', is_demo = true
 where id = '00000000-0000-4000-a000-0000000000c1';
update profiles set display_name = 'Demo Administrator', display_name_ar = 'مشرف تجريبي', role = 'admin', is_demo = true
 where id = '00000000-0000-4000-a000-0000000000ad';

insert into parking_partners (id, owner_id, name, name_ar, kind, contact_email, cr_number_provided, status, is_demo, reviewed_at) values
  ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-a000-0000000000c1', 'Olaya Business Tower (Demo)', 'برج العليا للأعمال (تجريبي)', 'office', 'partner@demo.rakna.invalid', true, 'approved', true, now());

insert into parking_spaces (id, partner_id, title, title_ar, location_lat, location_lng, neighborhood, address, address_ar, capacity, price_per_hour, schedule, conditions, conditions_ar, reward_eligible, approval, is_demo) values
  ('00000000-0000-4000-f000-000000000001', '00000000-0000-4000-b000-000000000001', 'Olaya Tower — Basement P2 (Demo)', 'برج العليا — القبو P2 (تجريبي)', 24.69610, 46.68420, 'olaya', 'Olaya St (illustrative)', 'شارع العليا (توضيحي)', 12, 8, '{"days":[0,1,2,3,4,5,6],"openHour":6,"closeHour":24}', 'Demo listing.', 'إعلان تجريبي.', true, 'approved', true),
  ('00000000-0000-4000-f000-000000000002', '00000000-0000-4000-b000-000000000001', 'Olaya Tower — Visitor Deck (Demo)', 'برج العليا — مواقف الزوار (تجريبي)', 24.69350, 46.68650, 'olaya', 'Off Olaya St (illustrative)', 'متفرع من شارع العليا (توضيحي)', 6, 12, '{"days":[0,1,2,3,4],"openHour":7,"closeHour":20}', 'Demo listing.', 'إعلان تجريبي.', true, 'approved', true),
  ('00000000-0000-4000-f000-000000000004', '00000000-0000-4000-b000-000000000001', 'King Fahd Rd Plaza (Demo)', 'ساحة طريق الملك فهد (تجريبي)', 24.73560, 46.65580, 'kfr', 'King Fahd Rd service lane (illustrative)', 'الطريق الخدمي (توضيحي)', 20, 10, '{"days":[0,1,2,3,4,5,6],"openHour":6,"closeHour":24}', 'Demo listing.', 'إعلان تجريبي.', true, 'approved', true);

insert into rewards_catalog (id, title, title_ar, description, description_ar, category, keys_required, partner_id, discount_percent, eligibility, eligibility_ar, terms, terms_ar, active, stock, is_demo) values
  ('00000000-0000-4000-9000-000000000001', '20% off a partner parking booking', 'خصم 20% على حجز موقف شريك', 'Apply when booking an eligible private space.', 'يُطبق عند حجز موقف خاص مؤهل.', 'parking_discount', 15, null, 20, 'Eligible partner spaces only', 'مواقف الشركاء المؤهلة فقط', 'Simulated. No cash value.', 'محاكاة. لا قيمة نقدية.', true, null, true),
  ('00000000-0000-4000-9000-000000000003', 'Free car-wash voucher (sponsored)', 'قسيمة غسيل سيارة مجانية (برعاية)', 'Sponsored voucher from a demo partner.', 'قسيمة برعاية شريك تجريبي.', 'sponsored_voucher', 25, null, null, 'Drivers in good standing', 'السائقون ذوو السجل الجيد', 'Simulated. Requires admin approval.', 'محاكاة. تتطلب موافقة المشرف.', true, 20, true);

insert into neighborhood_challenges (title, title_ar, description, description_ar, metric, target, neighborhood, is_demo) values
  ('Help one driver today', 'ساعد سائقًا واحدًا اليوم', 'One verified handoff.', 'تسليم موثق واحد.', 'handoffs_today', 1, null, true),
  ('Three successful handoffs', 'ثلاثة تسليمات ناجحة', 'Three verified reports this week.', 'ثلاثة بلاغات موثقة هذا الأسبوع.', 'handoffs_week', 3, null, true),
  ('Five verified reports this week', 'خمسة بلاغات موثقة هذا الأسبوع', 'Confirmed on site by another driver.', 'أكدها سائق آخر في الموقع.', 'verified_reports_week', 5, null, true),
  ('Al Olaya community week', 'أسبوع مجتمع العليا', '10 verified handoffs in Al Olaya.', '10 تسليمات موثقة في العليا.', 'neighborhood_handoffs_week', 10, 'olaya', true),
  ('Complete a Park & Connect mission', 'أكمل مهمة اركن واتصل', 'Simulated mission.', 'مهمة محاكاة.', 'missions_approved', 1, null, true);

insert into app_config (key, value) values
  ('reward_rules', '{"departureReward":8,"confirmationReward":2,"streakEvery":3,"streakBonus":5,"missionReward":10,"dailyEarnLimit":40,"dailyReportLimit":8,"reportTtlMinutes":20,"claimTtlMinutes":15,"maxConfirmDistanceM":120,"maxReportAccuracyM":100,"minClaimToConfirmSeconds":20,"locationRetentionHours":24}')
on conflict (key) do update set value = excluded.value, updated_at = now();
