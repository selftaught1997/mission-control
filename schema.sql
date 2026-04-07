-- SKC Platform Schema v2 — Opus-reviewed
-- Run this in Supabase SQL Editor (one-shot)

-- ═══════════════════════════════════════════════════════════════════
-- EXTENSIONS
-- ═══════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ═══════════════════════════════════════════════════════════════════
-- HELPER: auto-update updated_at trigger
-- ═══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════
-- 1. PROFILES (core identity — people, not accounts)
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  parent_profile_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  date_of_birth DATE,
  phone TEXT,
  email TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  postcode TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  medical_notes TEXT,
  belt_grade_id UUID,  -- FK added after belt_grades table exists
  photo_consent BOOLEAN DEFAULT FALSE,
  social_media_consent BOOLEAN DEFAULT FALSE,
  gdpr_consent BOOLEAN DEFAULT FALSE,
  gdpr_consented_at TIMESTAMPTZ,
  liability_waiver_signed_at TIMESTAMPTZ,
  role TEXT CHECK (role IN ('admin','instructor','assistant_instructor','member','parent')) DEFAULT 'member',
  status TEXT CHECK (status IN ('pending','active','suspended','inactive','trial')) DEFAULT 'pending',
  avatar_url TEXT,
  gocardless_customer_id TEXT,
  dbs_status TEXT CHECK (dbs_status IN ('none','pending','cleared','expired')),
  dbs_expiry_date DATE,
  notes TEXT,
  joined_at DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ═══════════════════════════════════════════════════════════════════
-- 2. CLASSES & SCHEDULING
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS classes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  location TEXT,
  instructor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  capacity INTEGER DEFAULT 30,
  min_grade_id UUID,  -- FK added later; minimum belt grade to attend
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Holiday / closure dates (classes cancelled on these days)
CREATE TABLE IF NOT EXISTS closures (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- One-off special sessions / seminars
CREATE TABLE IF NOT EXISTS special_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  description TEXT,
  session_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  location TEXT,
  instructor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  capacity INTEGER DEFAULT 30,
  price_pence INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 3. ATTENDANCE
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS attendance (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  class_id UUID REFERENCES classes(id) ON DELETE CASCADE,
  special_session_id UUID REFERENCES special_sessions(id) ON DELETE CASCADE,
  checked_in_at TIMESTAMPTZ DEFAULT NOW(),
  recorded_by TEXT DEFAULT 'kiosk',
  CHECK (class_id IS NOT NULL OR special_session_id IS NOT NULL)
);

-- Unique: one check-in per person per class per day
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_unique
  ON attendance (profile_id, class_id, (checked_in_at::DATE))
  WHERE class_id IS NOT NULL;

-- Kiosk sessions (instructor opens a class for check-in)
CREATE TABLE IF NOT EXISTS kiosk_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  class_id UUID NOT NULL REFERENCES classes(id),
  password_hash TEXT,  -- club-wide kiosk password (bcrypt)
  opened_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT TRUE
);

-- ═══════════════════════════════════════════════════════════════════
-- 4. BELT GRADES & SYLLABUS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS belt_grades (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  japanese_name TEXT,
  order_index INTEGER NOT NULL,
  color TEXT,
  stripe_color TEXT,
  min_classes_required INTEGER DEFAULT 0,
  min_months_at_grade INTEGER DEFAULT 0
);

-- Now add the FK from profiles and classes
ALTER TABLE profiles ADD CONSTRAINT fk_profiles_belt_grade
  FOREIGN KEY (belt_grade_id) REFERENCES belt_grades(id) ON DELETE SET NULL;
ALTER TABLE classes ADD CONSTRAINT fk_classes_min_grade
  FOREIGN KEY (min_grade_id) REFERENCES belt_grades(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS syllabus_elements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  belt_grade_id UUID NOT NULL REFERENCES belt_grades(id) ON DELETE CASCADE,
  category TEXT CHECK (category IN ('Kihon','Kata','Kumite','Theory','Conditioning')) DEFAULT 'Kihon',
  name TEXT NOT NULL,
  description TEXT,
  video_url TEXT,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS member_progress (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  element_id UUID NOT NULL REFERENCES syllabus_elements(id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('not_ready','developing','nearly_ready','ready')) DEFAULT 'not_ready',
  instructor_feedback TEXT,
  overall_feedback TEXT,
  updated_by UUID REFERENCES profiles(id),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(profile_id, element_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- 5. GRADINGS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS gradings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  event_date DATE NOT NULL,
  location TEXT,
  examiner TEXT,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS grading_entries (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  grading_id UUID NOT NULL REFERENCES gradings(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  submitted_by UUID REFERENCES profiles(id),
  current_grade_id UUID REFERENCES belt_grades(id),
  result TEXT CHECK (result IN ('pass','fail','deferred','pending')) DEFAULT 'pending',
  new_grade_id UUID REFERENCES belt_grades(id),
  certificate_url TEXT,
  notes TEXT,
  UNIQUE(grading_id, profile_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- 6. MEMBERSHIPS & PAYMENTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plan_rates (
  plan_name TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  rate_pence INTEGER NOT NULL,
  classes_per_week INTEGER,  -- null = unlimited
  description TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS memberships (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  plan TEXT NOT NULL REFERENCES plan_rates(plan_name),
  status TEXT CHECK (status IN ('active','cancelled','expired','pending','frozen')) DEFAULT 'pending',
  rate_override_pence INTEGER,  -- per-member legacy pricing
  gocardless_mandate_id TEXT,
  gocardless_subscription_id TEXT,
  started_at DATE,
  cancellation_requested_at TIMESTAMPTZ,  -- tracks when they asked to cancel
  cancels_at DATE,                         -- effective end date (14 days from request)
  frozen_until DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  membership_id UUID REFERENCES memberships(id) ON DELETE SET NULL,
  amount_pence INTEGER NOT NULL,
  currency TEXT DEFAULT 'GBP',
  status TEXT CHECK (status IN ('pending','paid','failed','refunded')) DEFAULT 'pending',
  source TEXT CHECK (source IN ('gocardless','manual','cash','card','bank_transfer')) DEFAULT 'manual',
  gocardless_payment_id TEXT,
  receipt_number TEXT,
  notes TEXT,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 7. PRIVATE LESSONS & CREDITS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS private_lessons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  instructor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  lesson_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  location TEXT,
  status TEXT CHECK (status IN ('booked','completed','cancelled','no_show')) DEFAULT 'booked',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lesson_credits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  total_credits INTEGER NOT NULL DEFAULT 0,
  used_credits INTEGER NOT NULL DEFAULT 0,
  pack_name TEXT,  -- e.g. "5+1 Free"
  purchased_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

-- ═══════════════════════════════════════════════════════════════════
-- 8. COMMUNICATION
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS announcements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  is_pinned BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sender_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  subject TEXT,
  body TEXT NOT NULL,
  is_read BOOLEAN DEFAULT FALSE,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- 'reminder','grading_invite','payment_due','milestone','birthday'
  title TEXT NOT NULL,
  body TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  link_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  email_enabled BOOLEAN DEFAULT TRUE,
  push_enabled BOOLEAN DEFAULT TRUE,
  sms_enabled BOOLEAN DEFAULT FALSE,
  UNIQUE(profile_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- 9. CONTENT & VIDEO LIBRARY
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS content_items (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  type TEXT CHECK (type IN ('video','document','image','link')) DEFAULT 'video',
  url TEXT NOT NULL,
  thumbnail_url TEXT,
  min_grade_id UUID REFERENCES belt_grades(id) ON DELETE SET NULL,  -- null = visible to all
  category TEXT,  -- 'Technique', 'Kata Breakdown', 'Home Practice', 'Parent Guide'
  order_index INTEGER DEFAULT 0,
  is_published BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS content_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  content_id UUID NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  marked_practised BOOLEAN DEFAULT FALSE,
  viewed_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 10. BADGES & STREAKS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS badge_definitions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT,
  threshold_type TEXT CHECK (threshold_type IN ('attendance_total','attendance_streak','membership_years','grading_pass')) NOT NULL,
  threshold_value INTEGER NOT NULL,
  certificate_template_url TEXT
);

CREATE TABLE IF NOT EXISTS member_badges (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  badge_id UUID NOT NULL REFERENCES badge_definitions(id) ON DELETE CASCADE,
  awarded_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(profile_id, badge_id)
);

-- ═══════════════════════════════════════════════════════════════════
-- 11. COMPETITIONS & EVENTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title TEXT NOT NULL,
  description TEXT,
  event_type TEXT CHECK (event_type IN ('competition','seminar','social','club_event')) DEFAULT 'club_event',
  event_date DATE NOT NULL,
  start_time TIME,
  end_time TIME,
  location TEXT,
  price_pence INTEGER DEFAULT 0,
  capacity INTEGER,
  created_by UUID REFERENCES profiles(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS event_signups (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('registered','waitlist','cancelled','attended')) DEFAULT 'registered',
  payment_id UUID REFERENCES payments(id),
  signed_up_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(event_id, profile_id)
);

CREATE TABLE IF NOT EXISTS competition_results (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  category TEXT,  -- 'Kata', 'Kumite', 'Team Kata'
  placement TEXT, -- '1st', '2nd', '3rd', 'Semi-final'
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 12. SAFEGUARDING & INCIDENTS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS incidents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  reported_by UUID NOT NULL REFERENCES profiles(id),
  incident_date DATE NOT NULL,
  type TEXT CHECK (type IN ('injury','behavioural','safeguarding','other')) DEFAULT 'injury',
  description TEXT NOT NULL,
  action_taken TEXT,
  is_resolved BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 13. EQUIPMENT INVENTORY
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS equipment (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  category TEXT,  -- 'Pads', 'Belts', 'Uniforms', 'First Aid'
  quantity INTEGER DEFAULT 0,
  size TEXT,
  condition TEXT CHECK (condition IN ('new','good','fair','needs_replacement')) DEFAULT 'good',
  next_check_date DATE,
  notes TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 14. FEEDBACK SURVEYS
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS class_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  class_id UUID NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  attendance_id UUID REFERENCES attendance(id) ON DELETE CASCADE,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  emoji TEXT,
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- 15. AUDIT LOG
-- ═══════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  action TEXT NOT NULL,  -- 'member.created', 'payment.recorded', 'grade.updated'
  target_table TEXT,
  target_id UUID,
  details JSONB,
  ip_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════════════════
-- INDEXES
-- ═══════════════════════════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_profiles_account ON profiles(account_id);
CREATE INDEX IF NOT EXISTS idx_profiles_parent ON profiles(parent_profile_id);
CREATE INDEX IF NOT EXISTS idx_profiles_status ON profiles(status);
CREATE INDEX IF NOT EXISTS idx_profiles_belt ON profiles(belt_grade_id);
CREATE INDEX IF NOT EXISTS idx_attendance_profile ON attendance(profile_id);
CREATE INDEX IF NOT EXISTS idx_attendance_class ON attendance(class_id);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance((checked_in_at::DATE));
CREATE INDEX IF NOT EXISTS idx_payments_profile ON payments(profile_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_memberships_profile ON memberships(profile_id);
CREATE INDEX IF NOT EXISTS idx_memberships_status ON memberships(status);
CREATE INDEX IF NOT EXISTS idx_notifications_profile ON notifications(profile_id);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(profile_id) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_id);
CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(recipient_id) WHERE is_read = FALSE;
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target_table, target_id);
CREATE INDEX IF NOT EXISTS idx_content_grade ON content_items(min_grade_id);

-- ═══════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_lessons ENABLE ROW LEVEL SECURITY;

-- Service role bypasses all RLS (server-side API calls)
CREATE POLICY "service_role_profiles" ON profiles FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_attendance" ON attendance FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_memberships" ON memberships FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_payments" ON payments FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_progress" ON member_progress FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_messages" ON messages FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_notifications" ON notifications FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_incidents" ON incidents FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);
CREATE POLICY "service_role_private_lessons" ON private_lessons FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Members can read own profile + children
CREATE POLICY "members_read_own_profiles" ON profiles FOR SELECT TO authenticated
  USING (account_id = auth.uid() OR parent_profile_id IN (
    SELECT id FROM profiles WHERE account_id = auth.uid()
  ));

-- Members can read own attendance
CREATE POLICY "members_read_own_attendance" ON attendance FOR SELECT TO authenticated
  USING (profile_id IN (
    SELECT id FROM profiles WHERE account_id = auth.uid()
    UNION
    SELECT id FROM profiles WHERE parent_profile_id IN (
      SELECT id FROM profiles WHERE account_id = auth.uid()
    )
  ));

-- Members can read own memberships
CREATE POLICY "members_read_own_memberships" ON memberships FOR SELECT TO authenticated
  USING (profile_id IN (
    SELECT id FROM profiles WHERE account_id = auth.uid()
    UNION
    SELECT id FROM profiles WHERE parent_profile_id IN (
      SELECT id FROM profiles WHERE account_id = auth.uid()
    )
  ));

-- Members can read own notifications
CREATE POLICY "members_read_own_notifications" ON notifications FOR SELECT TO authenticated
  USING (profile_id IN (
    SELECT id FROM profiles WHERE account_id = auth.uid()
  ));

-- Members can read/send own messages
CREATE POLICY "members_read_own_messages" ON messages FOR SELECT TO authenticated
  USING (
    sender_id IN (SELECT id FROM profiles WHERE account_id = auth.uid())
    OR recipient_id IN (SELECT id FROM profiles WHERE account_id = auth.uid())
  );

-- Kiosk check-in: anon can insert attendance (public kiosk — controlled by app)
CREATE POLICY "kiosk_insert_attendance" ON attendance FOR INSERT TO anon
  WITH CHECK (recorded_by = 'kiosk');

-- Public can read classes (for timetable)
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_classes" ON classes FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "service_role_classes" ON classes FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Public can read belt_grades
ALTER TABLE belt_grades ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_grades" ON belt_grades FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "service_role_grades" ON belt_grades FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Public can read plan_rates
ALTER TABLE plan_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_rates" ON plan_rates FOR SELECT TO anon, authenticated USING (TRUE);
CREATE POLICY "service_role_rates" ON plan_rates FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- Public can read published content (grade-locked at app level)
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "public_read_content" ON content_items FOR SELECT TO authenticated USING (is_published = TRUE);
CREATE POLICY "service_role_content" ON content_items FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

-- ═══════════════════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════════════════

-- Plan rates
INSERT INTO plan_rates (plan_name, display_name, rate_pence, classes_per_week, description) VALUES
  ('lite', 'Lite', 4500, 1, '1 class per week'),
  ('standard', 'Standard', 5500, 2, '2 classes per week — recommended'),
  ('premium', 'Premium', 7500, NULL, 'Unlimited classes'),
  ('payg', 'Pay As You Go', 1500, NULL, '£15 per class')
ON CONFLICT (plan_name) DO NOTHING;

-- Belt grades (JKA standard)
INSERT INTO belt_grades (name, japanese_name, order_index, color, min_classes_required) VALUES
  ('White', 'Shiro Obi', 0, '#ffffff', 0),
  ('Red (9th Kyu)', 'Aka Obi', 1, '#ef4444', 20),
  ('Orange (8th Kyu)', 'Daidaiiro Obi', 2, '#f97316', 25),
  ('Yellow (7th Kyu)', 'Kiiro Obi', 3, '#eab308', 30),
  ('Green (6th Kyu)', 'Midori Obi', 4, '#22c55e', 35),
  ('Purple (5th Kyu)', 'Murasaki Obi', 5, '#a855f7', 40),
  ('Purple/White (4th Kyu)', NULL, 6, '#c084fc', 45),
  ('Brown (3rd Kyu)', 'Chairo Obi', 7, '#92400e', 50),
  ('Brown/White (2nd Kyu)', NULL, 8, '#b45309', 55),
  ('Brown/White/White (1st Kyu)', NULL, 9, '#d97706', 60),
  ('Black (1st Dan)', 'Shodan', 10, '#000000', 80),
  ('Black (2nd Dan)', 'Nidan', 11, '#000000', 100),
  ('Black (3rd Dan)', 'Sandan', 12, '#000000', 150)
ON CONFLICT (name) DO NOTHING;

-- Classes
INSERT INTO classes (name, day_of_week, start_time, end_time, location) VALUES
  ('Level 1', 1, '18:00', '19:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Adults', 1, '19:00', '20:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Level 1', 2, '18:00', '19:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Kata', 2, '19:00', '20:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Level 1', 3, '18:00', '19:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Level 2', 3, '19:00', '20:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Level 1', 4, '18:00', '19:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Kumite', 4, '19:00', '20:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Adults & Open Mat', 4, '20:00', '21:00', 'Bryant Street Church & Community Centre, E15 4RU'),
  ('Level 1', 0, '10:00', '11:00', 'Eastlea Community School, E16 4NP'),
  ('Level 2', 0, '11:00', '12:00', 'Eastlea Community School, E16 4NP')
ON CONFLICT DO NOTHING;

-- Milestone badges
INSERT INTO badge_definitions (name, description, icon, threshold_type, threshold_value) VALUES
  ('50 Classes', 'Attended 50 classes', '🥉', 'attendance_total', 50),
  ('100 Classes', 'Attended 100 classes', '🥈', 'attendance_total', 100),
  ('200 Classes', 'Attended 200 classes', '🥇', 'attendance_total', 200),
  ('500 Classes', 'Attended 500 classes', '🏆', 'attendance_total', 500),
  ('1 Year Member', '12 months continuous membership', '⭐', 'membership_years', 1),
  ('3 Year Member', '3 years continuous membership', '🌟', 'membership_years', 3),
  ('10 Week Streak', '10 consecutive weeks attending', '🔥', 'attendance_streak', 10),
  ('20 Week Streak', '20 consecutive weeks attending', '💪', 'attendance_streak', 20)
ON CONFLICT (name) DO NOTHING;
