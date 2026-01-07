/*
  # Create Leads Schema

  1. New Tables
    - `leads`
      - `id` (uuid, primary key)
      - `user_id` (uuid, references auth.users)
      - `first_name` (text)
      - `last_name` (text)
      - `email` (text)
      - `phone` (text)
      - `source` (text)
      - `status` (text)
      - `estimated_debt` (numeric)
      - `unfiled_years` (text[])
      - `monthly_income` (numeric)
      - `tags` (text[])
      - `address_line1` (text)
      - `address_line2` (text)
      - `city` (text)
      - `state` (text)
      - `postal_code` (text)
      - `ai_score` (integer)
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)
    
    - `lead_activities`
      - `id` (uuid, primary key)
      - `lead_id` (uuid, references leads)
      - `type` (text) - e.g., 'call', 'email', 'note', 'status_change'
      - `description` (text)
      - `metadata` (jsonb)
      - `created_at` (timestamptz)

  2. Security
    - Enable RLS on both tables
    - Add policies for authenticated users to manage their own leads
*/

-- Create leads table
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  first_name text,
  last_name text,
  email text,
  phone text,
  source text DEFAULT 'Manual',
  status text DEFAULT 'New',
  
  -- Financial Info
  estimated_debt numeric,
  unfiled_years text[], -- Array of strings e.g., ['2018', '2019']
  monthly_income numeric,
  
  -- Marketing / Scoring
  tags text[] DEFAULT '{}',
  ai_score integer DEFAULT 0,
  
  -- Location
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Create lead activities table for timeline
CREATE TABLE IF NOT EXISTS public.lead_activities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE CASCADE NOT NULL,
  type text NOT NULL, -- 'CALL', 'EMAIL', 'SMS', 'NOTE', 'STATUS_CHANGE'
  description text,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

-- Enable Row Level Security
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lead_activities ENABLE ROW LEVEL SECURITY;

-- Policies for Leads
CREATE POLICY "Users can view their own leads"
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own leads"
  ON public.leads
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own leads"
  ON public.leads
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own leads"
  ON public.leads
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Policies for Lead Activities
-- Users can view activities for leads they own
CREATE POLICY "Users can view activities for their leads"
  ON public.lead_activities
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_activities.lead_id
      AND leads.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert activities for their leads"
  ON public.lead_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_activities.lead_id
      AND leads.user_id = auth.uid()
    )
  );

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_leads_updated_at
    BEFORE UPDATE ON public.leads
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();

