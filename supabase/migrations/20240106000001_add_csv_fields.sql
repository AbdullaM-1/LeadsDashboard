/*
  # Add CSV Import Fields to Leads Table

  1. New Columns
    - `middle_name` (text)
    - `ip_address` (text)
    - `date_of_birth` (date)
    - `lead_age` (date) - Matches 'Lead Age' from CSV which appears to be a date
    - `fulfill_date` (timestamptz)
*/

ALTER TABLE public.leads
ADD COLUMN IF NOT EXISTS middle_name text,
ADD COLUMN IF NOT EXISTS ip_address text,
ADD COLUMN IF NOT EXISTS date_of_birth date,
ADD COLUMN IF NOT EXISTS lead_age date,
ADD COLUMN IF NOT EXISTS fulfill_date timestamptz;

