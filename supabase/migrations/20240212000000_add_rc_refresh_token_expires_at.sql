/*
  Store when the RingCentral refresh token expires (from RC token response).
  Used to return refresh_token_expires_in to the SDK without hardcoding.
*/

ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS rc_refresh_token_expires_at timestamptz;

COMMENT ON COLUMN public.user_profiles.rc_refresh_token_expires_at IS 'When rc_refresh_token expires (UTC), from RingCentral token response';