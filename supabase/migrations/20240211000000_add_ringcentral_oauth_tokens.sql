/*
  # RingCentral OAuth tokens per user

  When users sign in with RingCentral OAuth, we store tokens here.
  Used for WebPhone so each user uses their own RC account.

  - rc_access_token (text): OAuth access token
  - rc_refresh_token (text): OAuth refresh token
  - rc_token_expires_at (timestamptz): When the access token expires
*/

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS rc_access_token text,
  ADD COLUMN IF NOT EXISTS rc_refresh_token text,
  ADD COLUMN IF NOT EXISTS rc_token_expires_at timestamptz;

COMMENT ON COLUMN public.user_profiles.rc_access_token IS 'RingCentral OAuth access token (per-user)';
COMMENT ON COLUMN public.user_profiles.rc_refresh_token IS 'RingCentral OAuth refresh token (per-user)';
COMMENT ON COLUMN public.user_profiles.rc_token_expires_at IS 'When rc_access_token expires (UTC)';
