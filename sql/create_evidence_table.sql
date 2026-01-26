-- Create evidence table for dispute evidence tracking
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

-- Add index for faster lookups by deal_id
CREATE INDEX IF NOT EXISTS idx_evidence_deal_id ON public.evidence(deal_id);

-- Enable RLS (Row Level Security)
ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;

-- Allow all operations for authenticated users (bot uses service key)
CREATE POLICY "Allow all for service role" ON public.evidence
  FOR ALL USING (true) WITH CHECK (true);
