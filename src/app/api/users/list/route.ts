import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

// This route requires Supabase Service Role key for admin operations

export async function GET(request: NextRequest) {
  try {
    // Get the service role key from environment variables
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set');
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl) {
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    // Create admin client with service role key
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // List all users
    const { data, error } = await supabaseAdmin.auth.admin.listUsers();

    if (error) {
      console.error('Error listing users:', error);
      return NextResponse.json(
        { error: error.message || 'Failed to list users' },
        { status: 400 }
      );
    }

    // Format users for response
    const users = data.users.map((user) => ({
      id: user.id,
      email: user.email,
      name: user.user_metadata?.name || '',
      created_at: user.created_at,
      last_sign_in_at: user.last_sign_in_at,
    }));

    return NextResponse.json({
      success: true,
      users,
    });
  } catch (error: any) {
    console.error('Error in list users route:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}

