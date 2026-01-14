-- Update lead_activities table to add activity_type column and created_by
-- The table already exists from the initial migration (20240106000000_create_leads_schema.sql)
-- which uses 'type' instead of 'activity_type'

-- Add activity_type column
ALTER TABLE public.lead_activities 
ADD COLUMN IF NOT EXISTS activity_type VARCHAR(50);

-- Add created_by column
ALTER TABLE public.lead_activities 
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- Migrate existing data from 'type' to 'activity_type' (convert to lowercase for consistency)
UPDATE public.lead_activities 
SET activity_type = LOWER(type)
WHERE activity_type IS NULL AND type IS NOT NULL;

-- Set default for any remaining nulls
UPDATE public.lead_activities 
SET activity_type = 'unknown'
WHERE activity_type IS NULL;

-- Make activity_type NOT NULL
DO $$ 
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'lead_activities' 
    AND column_name = 'activity_type'
    AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE public.lead_activities 
    ALTER COLUMN activity_type SET NOT NULL;
  END IF;
END $$;

-- Create indexes for efficient queries (if they don't exist)
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON public.lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON public.lead_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activities_activity_type ON public.lead_activities(activity_type);

