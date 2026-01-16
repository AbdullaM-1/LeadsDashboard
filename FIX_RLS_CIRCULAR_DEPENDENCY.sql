-- ============================================
-- FIX CIRCULAR DEPENDENCY IN RLS POLICIES
-- ============================================
-- The "Admins can view all profiles" policy creates a circular dependency
-- because it tries to check if user is admin by querying user_profiles
-- but the user needs to be able to read their profile first!

-- Step 1: Drop the problematic admin policy
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.user_profiles;

-- Step 2: Ensure the basic "Users can view their own profile" policy exists and works
DROP POLICY IF EXISTS "Users can view their own profile" ON public.user_profiles;

CREATE POLICY "Users can view their own profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

-- Step 3: Test if you can read your own profile (CRITICAL TEST)
-- Run this while logged in - it MUST return your profile
SELECT * FROM public.user_profiles WHERE id = auth.uid();

-- Step 4: Verify your admin role
SELECT 
  id,
  role,
  created_at,
  updated_at
FROM public.user_profiles 
WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

-- Step 5: Re-create the admin policy using a function to avoid circular dependency
-- First, create a function that checks admin status
CREATE OR REPLACE FUNCTION public.is_user_admin(user_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.user_profiles 
    WHERE id = user_id 
    AND role = 'admin'
  );
$$;

-- Step 6: Now create the admin policy using the function
CREATE POLICY "Admins can view all profiles"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (public.is_user_admin(auth.uid()));

-- Step 7: Verify all policies exist
SELECT 
  policyname,
  cmd,
  qual
FROM pg_policies 
WHERE tablename = 'user_profiles'
ORDER BY policyname;

-- Step 8: Final test - check if you can read your profile
SELECT * FROM public.user_profiles WHERE id = auth.uid();

