import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const RC_SERVER = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';

/**
 * GET /api/auth/ringcentral/tokens
 * Returns the current user's RingCentral OAuth tokens.
 * If access_token is expired, refreshes it and updates the profile, then returns new tokens.
 * Requires Supabase auth.
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey!);
    const { data: profile, error: profileError } = await supabaseAdmin
      .from('user_profiles')
      .select('rc_access_token, rc_refresh_token, rc_token_expires_at, rc_refresh_token_expires_at')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.rc_refresh_token) {
      return NextResponse.json({ linked: false }, { status: 200 });
    }

    let access_token = profile.rc_access_token;
    let refresh_token = profile.rc_refresh_token;
    let expires_at = profile.rc_token_expires_at;
    let refresh_token_expires_in_from_refresh: number | undefined;

    const now = new Date();
    const expiresAt = profile.rc_token_expires_at ? new Date(profile.rc_token_expires_at) : null;
    if (expiresAt && expiresAt.getTime() - now.getTime() < 60 * 1000) {
      const clientId = process.env.NEXT_PUBLIC_RC_CLIENT_ID;
      const clientSecret = process.env.NEXT_PUBLIC_RC_CLIENT_SECRET;
      if (!clientId || !serviceKey || !clientSecret) {
        return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
      }
      const tokenUrl = RC_SERVER.replace(/\/$/, '') + '/restapi/oauth/token';
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: profile.rc_refresh_token,
      });
      const refreshRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: 'Basic ' + Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        },
        body: body.toString(),
      });
      if (!refreshRes.ok) {
        const errText = await refreshRes.text();
        console.error('RC token refresh failed:', refreshRes.status, errText);
        return NextResponse.json({ error: 'Token refresh failed', linked: false }, { status: 401 });
      }
      const data = await refreshRes.json();
      access_token = data.access_token;
      refresh_token = data.refresh_token ?? profile.rc_refresh_token;
      const expires_in = data.expires_in ?? 3600;
      expires_at = new Date(Date.now() + expires_in * 1000).toISOString();
      const refresh_expires_in = data.refresh_token_expires_in;
      if (typeof refresh_expires_in === 'number' && refresh_expires_in > 0) {
        refresh_token_expires_in_from_refresh = refresh_expires_in;
      }
      const rc_refresh_token_expires_at =
        typeof refresh_expires_in === 'number' && refresh_expires_in > 0
          ? new Date(Date.now() + refresh_expires_in * 1000).toISOString()
          : null;

      const refreshUpdate: Record<string, string | null> = {
        rc_access_token: access_token,
        rc_refresh_token: refresh_token,
        rc_token_expires_at: expires_at,
      };
      if (rc_refresh_token_expires_at) refreshUpdate.rc_refresh_token_expires_at = rc_refresh_token_expires_at;
      await supabaseAdmin
        .from('user_profiles')
        .update(refreshUpdate)
        .eq('id', user.id);
    }

    let refresh_token_expires_in: number | undefined;
    if (refresh_token_expires_in_from_refresh !== undefined) {
      refresh_token_expires_in = refresh_token_expires_in_from_refresh;
    } else if (profile.rc_refresh_token_expires_at) {
      const secs = Math.floor((new Date(profile.rc_refresh_token_expires_at).getTime() - Date.now()) / 1000);
      if (secs > 0) refresh_token_expires_in = secs;
    }

    const payload: { linked: true; access_token: string; refresh_token: string; expires_at: string; refresh_token_expires_in?: number } = {
      linked: true,
      access_token,
      refresh_token,
      expires_at,
    };
    if (refresh_token_expires_in !== undefined) payload.refresh_token_expires_in = refresh_token_expires_in;

    return NextResponse.json(payload);
  } catch (e) {
    console.error('RingCentral tokens error:', e);
    return NextResponse.json({ error: 'Failed to get tokens' }, { status: 500 });
  }
}
