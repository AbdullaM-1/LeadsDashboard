/*
  # Create Call Recordings Schema

  1. New Table
    - `call_recordings`
      - `id` (uuid, primary key)
      - `user_id` (uuid, references auth.users)
      - `lead_id` (uuid, references leads, nullable)
      - `call_id` (text) - RingCentral call ID
      - `session_id` (text) - RingCentral telephony session ID
      - `record_id` (text) - RingCentral recording ID
      - `direction` (text) - 'Inbound' or 'Outbound'
      - `from_number` (text)
      - `from_name` (text)
      - `to_number` (text)
      - `to_name` (text)
      - `start_time` (timestamptz)
      - `duration` (integer) - duration in seconds
      - `transcription` (jsonb) - full transcript segments
      - `summary` (text) - call summary if available
      - `speaker_info` (jsonb) - speaker information
      - `insights` (jsonb) - full insights data from RingSense
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - Enable RLS on the table
    - Add policies for authenticated users to manage their own call recordings
*/

-- Create call_recordings table
CREATE TABLE IF NOT EXISTS public.call_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) NOT NULL DEFAULT auth.uid(),
  lead_id uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  
  -- RingCentral identifiers
  call_id text NOT NULL,
  session_id text,
  record_id text NOT NULL,
  
  -- Call metadata
  direction text, -- 'Inbound' or 'Outbound'
  from_number text,
  from_name text,
  to_number text,
  to_name text,
  start_time timestamptz,
  duration integer, -- duration in seconds
  
  -- RingSense insights data
  transcription jsonb, -- Array of transcript segments
  summary text,
  speaker_info jsonb, -- Speaker information mapping
  insights jsonb, -- Full insights object from RingSense
  
  -- Timestamps
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  
  -- Ensure unique call recordings by record_id
  UNIQUE(record_id)
);

-- Enable Row Level Security
ALTER TABLE public.call_recordings ENABLE ROW LEVEL SECURITY;

-- Policies for Call Recordings
CREATE POLICY "Users can view their own call recordings"
  ON public.call_recordings
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own call recordings"
  ON public.call_recordings
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own call recordings"
  ON public.call_recordings
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own call recordings"
  ON public.call_recordings
  FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_call_recordings_user_id ON public.call_recordings(user_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_lead_id ON public.call_recordings(lead_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_call_id ON public.call_recordings(call_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_record_id ON public.call_recordings(record_id);
CREATE INDEX IF NOT EXISTS idx_call_recordings_start_time ON public.call_recordings(start_time DESC);
CREATE INDEX IF NOT EXISTS idx_call_recordings_created_at ON public.call_recordings(created_at DESC);

-- Function to automatically update updated_at timestamp
CREATE TRIGGER update_call_recordings_updated_at
    BEFORE UPDATE ON public.call_recordings
    FOR EACH ROW
    EXECUTE PROCEDURE update_updated_at_column();

