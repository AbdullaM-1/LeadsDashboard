import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * Leads Delete API
 *
 * Uses Supabase Service Role to bypass RLS, which can fail in production
 * due to session/cookie differences. Auth and permission checks are done
 * server-side before performing the delete.
 *
 * Supports:
 * 1. Delete by lead IDs (selected leads)
 * 2. Delete by status filter (bulk delete modal)
 */
const STATUS_QUERY_MAP: Record<string, string[]> = {
  All: [],
  New: ['New'],
  'No Answer': ['No Answer'],
  'Voice Mail': ['Voice Mail'],
  'Left Voice Mail': ['Left Voice Mail', 'Left Voicemail'],
  'Call Back': ['Call Back'],
  'Do Not Call': ['Do Not Call'],
  'W# (Wrong Number)': ['W# (Wrong Number)'],
  'Not Interested': ['Not Interested'],
  Qualified: ['Qualified', 'Qualified Lead'],
};

export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!authHeader) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    if (!serviceRoleKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    // Verify user with anon key + their token
    const supabaseClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const { data: { user }, error: authError } = await supabaseClient.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    // Check if user is admin
    const { data: profile } = await supabaseClient
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    const isAdmin = profile?.role === 'admin';

    // Service role client for the actual delete (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const body = await request.json();
    const { leadIds, statusFilter } = body;

    // Case 1: Delete by specific lead IDs
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      let query = supabaseAdmin.from('leads').delete().in('id', leadIds);

      if (!isAdmin) {
        query = query.eq('user_id', user.id);
      }

      const { error: deleteError } = await query;

      if (deleteError) {
        console.error('Error deleting leads by IDs:', deleteError);
        return NextResponse.json(
          { error: deleteError.message || 'Failed to delete leads' },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        message: `Successfully deleted ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}`,
      });
    }

    // Case 2: Delete by status filter
    if (statusFilter) {
      let query = supabaseAdmin.from('leads').delete();

      if (!isAdmin) {
        query = query.eq('user_id', user.id);
      }

      const statusesToDelete = STATUS_QUERY_MAP[statusFilter] ?? [statusFilter];

      if (statusFilter === 'All' || statusesToDelete.length === 0) {
        // Delete all (for user: only their own; for admin: all)
        query = query.neq('id', '00000000-0000-0000-0000-000000000000');
      } else if (statusesToDelete.length === 1) {
        query = query.eq('status', statusesToDelete[0]);
      } else {
        query = query.in('status', statusesToDelete);
      }

      const { error: deleteError } = await query;

      if (deleteError) {
        console.error('Error deleting leads by status:', deleteError);
        return NextResponse.json(
          { error: deleteError.message || 'Failed to delete leads' },
          { status: 400 }
        );
      }

      return NextResponse.json({
        success: true,
        message: 'Leads deleted successfully',
      });
    }

    return NextResponse.json(
      { error: 'Provide either leadIds or statusFilter' },
      { status: 400 }
    );
  } catch (error: unknown) {
    console.error('Error in leads delete route:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}
