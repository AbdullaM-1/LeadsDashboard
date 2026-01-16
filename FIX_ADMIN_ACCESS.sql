-- ============================================
-- FIX ADMIN ACCESS - Run these queries in order
-- ============================================

-- Step 1: Verify your role is set correctly
SELECT 
  id,
  role,
  created_at,
  updated_at
FROM public.user_profiles 
WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

-- Step 2: Force update the role (in case of any issues)
UPDATE public.user_profiles 
SET role = 'admin', updated_at = now()
WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

-- Step 3: Check if RLS policies exist and are correct
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
WHERE tablename = 'user_profiles';

-- Step 4: Drop and recreate the "Users can view their own profile" policy to ensure it works
DROP POLICY IF EXISTS "Users can view their own profile" ON public.user_profiles;

CREATE POLICY "Users can view their own profile"
  ON public.user_profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

-- Step 5: Verify you can read your profile (this should work now)
-- Run this while logged in as that user
SELECT * FROM public.user_profiles WHERE id = auth.uid();

-- Step 6: Double-check the role is admin
SELECT 
  u.id,
  u.email,
  up.role,
  up.updated_at
FROM auth.users u
JOIN public.user_profiles up ON u.id = up.id
WHERE u.id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

-- ============================================
-- ALTERNATIVE: If RLS is still blocking, use this
-- ============================================
-- Temporarily disable RLS, update, then re-enable

ALTER TABLE public.user_profiles DISABLE ROW LEVEL SECURITY;

UPDATE public.user_profiles 
SET role = 'admin', updated_at = now()
WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Verify
SELECT * FROM public.user_profiles WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

