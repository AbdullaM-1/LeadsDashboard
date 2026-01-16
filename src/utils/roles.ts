import { supabase } from './supabase/client';

export type UserRole = 'admin' | 'user';

/**
 * Get the current user's role
 * @returns Promise resolving to the user's role ('admin' or 'user')
 */
export async function getCurrentUserRole(): Promise<UserRole> {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return 'user';

    console.log('[getCurrentUserRole] Checking role for user:', user.id);
    const { data: profile, error } = await supabase
      .from('user_profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    if (error) {
      console.error('[getCurrentUserRole] Error fetching profile:', error);
      // If profile doesn't exist, try to create it
      if (error.code === 'PGRST116') {
        console.log('[getCurrentUserRole] Profile not found, creating default user profile');
        const { error: insertError } = await supabase
          .from('user_profiles')
          .insert({ id: user.id, role: 'user' });
        if (insertError) {
          console.error('[getCurrentUserRole] Error creating profile:', insertError);
        }
      }
      return 'user';
    }

    if (!profile) {
      console.log('[getCurrentUserRole] No profile found');
      return 'user';
    }

    console.log('[getCurrentUserRole] Role found:', profile.role);
    return (profile.role as UserRole) || 'user';
  } catch (err) {
    console.error('Error fetching user role:', err);
    return 'user';
  }
}

/**
 * Check if the current user is an admin
 * @returns Promise resolving to true if user is admin, false otherwise
 */
export async function isAdmin(): Promise<boolean> {
  const role = await getCurrentUserRole();
  return role === 'admin';
}

/**
 * Set a user's role (admin only)
 * @param userId The user ID to update
 * @param role The role to set ('admin' or 'user')
 * @returns Promise resolving to true if successful, false otherwise
 */
export async function setUserRole(userId: string, role: UserRole): Promise<boolean> {
  try {
    const currentRole = await getCurrentUserRole();
    if (currentRole !== 'admin') {
      console.error('Only admins can set user roles');
      return false;
    }

    const { error } = await supabase
      .from('user_profiles')
      .upsert({ id: userId, role }, { onConflict: 'id' });

    if (error) {
      console.error('Error setting user role:', error);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Error setting user role:', err);
    return false;
  }
}

