import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import crypto from 'crypto';

/**
 * GET /api/auth/ringcentral
 * Redirects the logged-in user to RingCentral OAuth authorize URL.
 * State is signed and contains the Supabase user id so we can associate tokens on callback.
 */
export async function GET(request: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json({ error: 'Server configuration error' }, { status: 500 });
    }

    const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll() {},
      },
    });
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error || !user) {
      return NextResponse.redirect(new URL('/login', request.url));
    }

    const clientId = process.env.NEXT_PUBLIC_RC_CLIENT_ID;
    const server = process.env.NEXT_PUBLIC_RC_SERVER || 'https://platform.ringcentral.com';
    // OAU-109: redirect_uri must EXACTLY match a URI registered in RingCentral.
    // Prefer env so production always uses production URL (not localhost).
    const fromEnv = (process.env.NEXT_PUBLIC_RINGCENTRAL_REDIRECT_URI || process.env.RINGCENTRAL_REDIRECT_URI)?.trim().replace(/\/$/, '');
    const baseOrigin = request.nextUrl.origin;
    const redirectUri = fromEnv || `${baseOrigin}/api/auth/ringcentral/callback`;
    const stateSecret = process.env.RINGCENTRAL_OAUTH_STATE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'rc-oauth-state';

    if (!clientId) {
      return NextResponse.json({ error: 'RingCentral app not configured' }, { status: 500 });
    }

    const payload = JSON.stringify({ userId: user.id, ts: Date.now() });
    const sig = crypto.createHmac('sha256', stateSecret).update(payload).digest('base64url');
    const state = Buffer.from(payload).toString('base64url') + '.' + sig;

    const authUrl = new URL('/restapi/oauth/authorize', server);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('state', state);

    return NextResponse.redirect(authUrl.toString());
  } catch (e) {
    console.error('RingCentral OAuth start error:', e);
    return NextResponse.json({ error: 'OAuth start failed' }, { status: 500 });
  }
}
