/*
  # Add Business Name Field to Leads Table

  1. New Columns
    - `business_name` (text) - Matches 'Business Name', 'Company', 'Company Name' from CSV imports
*/

ALTER TABLE public.leads
ADD COLUMN IF NOT EXISTS business_name text;
