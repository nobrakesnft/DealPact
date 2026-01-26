-- TrustLock Admin Panel Database Schema
-- Run this in Supabase SQL Editor

-- 1. Moderators table
CREATE TABLE IF NOT EXISTS public.moderators (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  added_by TEXT,
  added_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true
);

-- 2. Admin action logs for audit trail
CREATE TABLE IF NOT EXISTS public.admin_logs (
  id SERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  deal_id TEXT,
  admin_telegram_id BIGINT,
  admin_username TEXT,
  target_user TEXT,
  details TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Add columns to deals table for assignment
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS assigned_to_telegram_id BIGINT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS assigned_to_username TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS assigned_by TEXT;

-- 4. Add ALL dispute-related columns to deals table
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS disputed_by TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS disputed_by_telegram_id BIGINT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS dispute_reason TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS resolved_by TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS funded_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP WITH TIME ZONE;

-- 5. Evidence table (if not exists)
CREATE TABLE IF NOT EXISTS public.evidence (
  id SERIAL PRIMARY KEY,
  deal_id TEXT NOT NULL,
  submitted_by TEXT,
  role TEXT,
  content TEXT,
  file_id TEXT,
  file_type TEXT,
  telegram_id BIGINT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_moderators_telegram_id ON public.moderators(telegram_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_deal_id ON public.admin_logs(deal_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_created_at ON public.admin_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_deals_status ON public.deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_assigned_to ON public.deals(assigned_to_telegram_id);
CREATE INDEX IF NOT EXISTS idx_evidence_deal_id ON public.evidence(deal_id);

-- Enable RLS
ALTER TABLE public.moderators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;

-- Policies (allow all for service role - bot uses service key)
CREATE POLICY "moderators_all" ON public.moderators FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "admin_logs_all" ON public.admin_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "evidence_all" ON public.evidence FOR ALL USING (true) WITH CHECK (true);
