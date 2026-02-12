import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const RC_SERVER = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';
const PRODUCTION_ORIGIN = 'https://staged.d2cieh88reo0fp.amplifyapp.com';
const REDIRECT_URI = `${PRODUCTION_ORIGIN}/api/auth/ringcentral/callback`;

const ACCESS_TOKEN_TTL = 86400; // 24 hours (RingCentral max)
const REFRESH_TOKEN_TTL = 604800; // 7 days (RingCentral max; longer values are capped)

/**
 * GET /api/auth/ringcentral/callback
 * RingCentral redirects here with ?code=...&state=...
 * We exchange code for tokens and save them to the user's profile.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const errorParam = searchParams.get('error');

  const dashboardUrl = new URL('/dashboard', PRODUCTION_ORIGIN);

  if (errorParam) {
    dashboardUrl.searchParams.set('rc_error', errorParam);
    return NextResponse.redirect(dashboardUrl.toString());
  }

  if (!code || !state) {
    dashboardUrl.searchParams.set('rc_error', 'missing_code_or_state');
    return NextResponse.redirect(dashboardUrl.toString());
  }

  try {
    const stateSecret = process.env.RINGCENTRAL_OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'rc-oauth-state';
    const [payloadB64, sig] = state.split('.');
    if (!payloadB64 || !sig) {
      dashboardUrl.searchParams.set('rc_error', 'invalid_state');
      return NextResponse.redirect(dashboardUrl.toString());
    }
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    const expectedSig = crypto.createHmac('sha256', stateSecret).update(JSON.stringify({ userId: payload.userId, ts: payload.ts })).digest('base64url');
    if (sig !== expectedSig || !payload.userId) {
      dashboardUrl.searchParams.set('rc_error', 'invalid_state');
      return NextResponse.redirect(dashboardUrl.toString());
    }
    const userId = payload.userId;

    const clientId = process.env.NEXT_PUBLIC_RC_CLIENT_ID;
    const clientSecret = process.env.NEXT_PUBLIC_RC_CLIENT_SECRET;
    const redirectUri = REDIRECT_URI;
    if (!clientId || !clientSecret) {
      dashboardUrl.searchParams.set('rc_error', 'server_config');
      return NextResponse.redirect(dashboardUrl.toString());
    }

    const tokenUrl = RC_SERVER.replace(/\/$/, '') + '/restapi/oauth/token';
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      access_token_ttl: String(ACCESS_TOKEN_TTL),
      refresh_token_ttl: String(REFRESH_TOKEN_TTL),
    });
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
      },
      body: body.toString(),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('RingCentral token exchange failed:', tokenRes.status, errText, 'redirect_uri sent:', redirectUri);
      dashboardUrl.searchParams.set('rc_error', 'token_exchange_failed');
      dashboardUrl.searchParams.set('rc_redirect_uri', encodeURIComponent(redirectUri));
      return NextResponse.redirect(dashboardUrl.toString());
    }

    const data = await tokenRes.json();
    const access_token = data.access_token;
    const refresh_token = data.refresh_token;
    const expires_in = data.expires_in ?? 3600;
    const expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
    const refresh_expires_in = data.refresh_token_expires_in;
    const refresh_token_expires_at =
      typeof refresh_expires_in === 'number' && refresh_expires_in > 0
        ? new Date(Date.now() + refresh_expires_in * 1000).toISOString()
        : null;

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      dashboardUrl.searchParams.set('rc_error', 'server_config');
      return NextResponse.redirect(dashboardUrl.toString());
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const upsertPayload: Record<string, unknown> = {
      id: userId,
      rc_access_token: access_token,
      rc_refresh_token: refresh_token,
      rc_token_expires_at: expires_at,
    };
    if (refresh_token_expires_at) upsertPayload.rc_refresh_token_expires_at = refresh_token_expires_at;
    // Upsert so we create the profile row if it doesn't exist (e.g. user created before trigger existed).
    const { error: upsertError } = await supabase
      .from('user_profiles')
      .upsert(upsertPayload, { onConflict: 'id' });

    if (upsertError) {
      console.error('[RC callback] Failed to save tokens to user_profiles:', {
        userId,
        code: upsertError.code,
        message: upsertError.message,
        details: upsertError.details,
        hint: upsertError.hint,
        full: upsertError,
      });
      dashboardUrl.searchParams.set('rc_error', 'save_failed');
      return NextResponse.redirect(dashboardUrl.toString());
    }

    console.log('[RC callback] Tokens saved for user:', userId);
    dashboardUrl.searchParams.set('rc_linked', '1');
    return NextResponse.redirect(dashboardUrl.toString());
  } catch (e) {
    console.error('[RC callback] Error:', e);
    console.error('[RC callback] Full error (stack, etc.):', e instanceof Error ? { message: e.message, stack: e.stack, name: e.name } : e);
    dashboardUrl.searchParams.set('rc_error', 'callback_error');
    return NextResponse.redirect(dashboardUrl.toString());
  }
}
