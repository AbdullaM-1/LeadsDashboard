-- Run this SQL in your Supabase SQL Editor to apply the migration
-- This adds the activity_type and created_by columns to lead_activities table

-- Step 1: Add activity_type column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'lead_activities' 
    AND column_name = 'activity_type'
  ) THEN
    ALTER TABLE public.lead_activities 
    ADD COLUMN activity_type VARCHAR(50);
  END IF;
END $$;

-- Step 2: Add created_by column if it doesn't exist
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_schema = 'public' 
    AND table_name = 'lead_activities' 
    AND column_name = 'created_by'
  ) THEN
    ALTER TABLE public.lead_activities 
    ADD COLUMN created_by UUID REFERENCES auth.users(id);
  END IF;
END $$;

-- Step 3: Migrate existing data from 'type' to 'activity_type' (convert to lowercase)
UPDATE public.lead_activities 
SET activity_type = LOWER(type)
WHERE activity_type IS NULL AND type IS NOT NULL;

-- Step 4: Set default for any remaining nulls
UPDATE public.lead_activities 
SET activity_type = 'unknown'
WHERE activity_type IS NULL;

-- Step 5: Make activity_type NOT NULL (only if column exists and is nullable)
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

-- Step 6: Create indexes for efficient queries (if they don't exist)
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON public.lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON public.lead_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activities_activity_type ON public.lead_activities(activity_type);

-- Verify the migration
SELECT 
  column_name, 
  data_type, 
  is_nullable
FROM information_schema.columns 
WHERE table_schema = 'public' 
AND table_name = 'lead_activities'
ORDER BY ordinal_position;

