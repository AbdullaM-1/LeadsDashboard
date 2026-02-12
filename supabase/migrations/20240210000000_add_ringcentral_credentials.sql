/*
  # Add RingCentral Credentials per User

  Each user can have their own RingCentral JWT for making calls.
  Stored in user_profiles so the logged-in user's account is used for WebPhone.

  - rc_jwt (text, nullable): User's RingCentral JWT token
  - rc_server (text, nullable): User's RingCentral server URL (production/sandbox override)
*/

-- Add RingCentral columns to user_profiles
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS rc_jwt text,
  ADD COLUMN IF NOT EXISTS rc_server text;

-- Add comment for documentation
COMMENT ON COLUMN public.user_profiles.rc_jwt IS 'RingCentral JWT for this user (per-user calling)';
COMMENT ON COLUMN public.user_profiles.rc_server IS 'RingCentral server URL override (e.g. https://platform.ringcentral.com or sandbox)';
