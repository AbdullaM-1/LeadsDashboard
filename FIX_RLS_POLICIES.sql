-- ============================================
-- FIX RLS POLICIES FOR USER_PROFILES
-- ============================================
-- Run this to ensure RLS policies allow users to read their own profile

-- Step 1: Drop existing policies (if they exist)
DROP POLICY IF EXISTS "Users can view their own profile" ON public.user_profiles;
DROP POLICY IF EXISTS "Admins can view all profiles" ON public.user_profiles;
DROP POLICY IF EXISTS "Users can update their own profile" ON public.user_profiles;

-- Step 2: Create policy that allows users to view their own profile
-- This is CRITICAL - without this, users can't read their own role
CREATE POLICY "Users can view their own profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

-- Step 3: Create policy that allows admins to view all profiles
CREATE POLICY "Admins can view all profiles"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = auth.uid()
      AND role = 'admin'
    )
  );

-- Step 4: Create policy that allows users to update their own profile
CREATE POLICY "Users can update their own profile"
  ON public.user_profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Step 5: Verify the policies exist
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
FROM pg_policies 
WHERE tablename = 'user_profiles'
ORDER BY policyname;

-- Step 6: Test if you can read your profile (run while logged in)
-- This should return your profile
SELECT * FROM public.user_profiles WHERE id = auth.uid();

-- Step 7: Verify your admin role is set
SELECT 
  id,
  role,
  created_at,
  updated_at
FROM public.user_profiles 
WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

-- ============================================
-- ALTERNATIVE: If RLS is still blocking, check these
-- ============================================

-- Check if RLS is enabled
SELECT tablename, rowsecurity 
FROM pg_tables 
WHERE schemaname = 'public' 
AND tablename = 'user_profiles';

-- If rowsecurity is false, enable it:
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Check current user context (should show your user ID)
SELECT auth.uid() as current_user_id;

-- Test query with explicit user ID
SELECT * FROM public.user_profiles 
WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

