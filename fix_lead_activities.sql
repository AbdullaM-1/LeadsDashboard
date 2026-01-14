-- Fix lead_activities table to add activity_type column
-- Run this in your Supabase SQL Editor

-- Add activity_type column if it doesn't exist
ALTER TABLE public.lead_activities 
ADD COLUMN IF NOT EXISTS activity_type VARCHAR(50);

-- Add created_by column if it doesn't exist
ALTER TABLE public.lead_activities 
ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- Migrate existing data from 'type' to 'activity_type' (convert to lowercase)
UPDATE public.lead_activities 
SET activity_type = LOWER(type)
WHERE activity_type IS NULL AND type IS NOT NULL;

-- Set default for any remaining nulls
UPDATE public.lead_activities 
SET activity_type = 'unknown'
WHERE activity_type IS NULL;

-- Make activity_type NOT NULL
ALTER TABLE public.lead_activities 
ALTER COLUMN activity_type SET NOT NULL;

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead_id ON public.lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_created_at ON public.lead_activities(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_activities_activity_type ON public.lead_activities(activity_type);

