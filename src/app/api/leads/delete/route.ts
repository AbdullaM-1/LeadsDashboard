import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

/**
 * Leads Delete API
 *
 * Uses only NEXT_PUBLIC Supabase keys with the user's auth token.
 * Runs server-side so it avoids client cookie/session issues in production.
 *
 * Supports:
 * 1. Delete by lead IDs (selected leads)
 * 2. Delete by status filter (bulk delete modal)
 */
// Must match dashboard: BZ, NW#, and W# (Wrong Number) are distinct; do not merge or alias.
const STATUS_QUERY_MAP: Record<string, string[]> = {
  All: [],
  New: ['New'],
  'No Answer': ['No Answer'],
  'Voice Mail': ['Voice Mail'],
  'Left Voice Mail': ['Left Voice Mail', 'Left Voicemail'],
  'Call Back': ['Call Back'],
  'Do Not Call': ['Do Not Call'],
  'NW# (No Working Number)': ['NW# (No Working Number)'],
  'W# (Wrong Number)': ['W# (Wrong Number)'],
  'BZ (Busy Signal)': ['BZ (Busy Signal)'],
  'Not Interested': ['Not Interested'],
  'Not Qualified': ['Not Qualified'],
  'No Tax Debt': ['No Tax Debt'],
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

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
      return NextResponse.json(
        { error: 'Missing Supabase config. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to your environment variables.' },
        { status: 500 }
      );
    }

    // Use anon key + user's token (no service role needed)
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: {
        headers: { Authorization: authHeader },
      },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized. Please log in.' },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { leadIds, statusFilter } = body;

    // Case 1: Delete by specific lead IDs
    if (leadIds && Array.isArray(leadIds) && leadIds.length > 0) {
      const { error: deleteError } = await supabase
        .from('leads')
        .delete()
        .in('id', leadIds);

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
      const statusesToDelete = STATUS_QUERY_MAP[statusFilter] ?? [statusFilter];

      let query = supabase.from('leads').delete();

      if (statusFilter === 'All' || statusesToDelete.length === 0) {
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
