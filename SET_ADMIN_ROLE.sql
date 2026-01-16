-- ============================================
-- SET ADMIN ROLE FOR USER
-- ============================================
-- Run this in Supabase SQL Editor
-- Replace 'YOUR_EMAIL_HERE' with your actual email address

-- Option 1: Set admin by EMAIL (Easiest)
INSERT INTO public.user_profiles (id, role)
SELECT id, 'admin'
FROM auth.users
WHERE email = 'YOUR_EMAIL_HERE'
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- Option 2: Set admin by USER ID (if you know the ID)
-- Replace 'YOUR_USER_ID_HERE' with your user ID from auth.users
INSERT INTO public.user_profiles (id, role)
VALUES ('YOUR_USER_ID_HERE', 'admin')
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- ============================================
-- VERIFY IT WORKED
-- ============================================
-- Run this to check your role
SELECT 
  u.id,
  u.email,
  up.role,
  CASE 
    WHEN up.role = 'admin' THEN '✅ ADMIN'
    WHEN up.role = 'user' THEN '👤 USER'
    ELSE '❌ NO ROLE'
  END as status,
  up.created_at as profile_created,
  up.updated_at as profile_updated
FROM auth.users u
LEFT JOIN public.user_profiles up ON u.id = up.id
WHERE u.email = 'YOUR_EMAIL_HERE';

-- ============================================
-- LIST ALL USERS AND THEIR ROLES
-- ============================================
SELECT 
  u.id,
  u.email,
  up.role,
  CASE 
    WHEN up.role = 'admin' THEN '✅ Admin'
    WHEN up.role = 'user' THEN '👤 User'
    ELSE '❌ No Role'
  END as status,
  u.created_at as user_created,
  up.updated_at as role_updated
FROM auth.users u
LEFT JOIN public.user_profiles up ON u.id = up.id
ORDER BY u.created_at DESC;

-- ============================================
-- CHECK RLS POLICIES (Make sure you can read your profile)
-- ============================================
-- This should return your profile if RLS is working
-- Run this while logged in (it uses auth.uid())
SELECT * FROM public.user_profiles WHERE id = auth.uid();

-- ============================================
-- FIX: If RLS is blocking, temporarily disable to set admin
-- ============================================
-- ONLY RUN THIS IF THE ABOVE QUERIES DON'T WORK
-- This temporarily allows you to set admin without RLS restrictions

-- Step 1: Temporarily disable RLS (CAREFUL - only for setup)
ALTER TABLE public.user_profiles DISABLE ROW LEVEL SECURITY;

-- Step 2: Set your admin role
INSERT INTO public.user_profiles (id, role)
SELECT id, 'admin'
FROM auth.users
WHERE email = 'YOUR_EMAIL_HERE'
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- Step 3: Re-enable RLS
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- ============================================
-- QUICK FIX: Set admin for your specific user ID
-- ============================================
-- Based on your user ID: 1ab7daf1-0c42-4f42-b01e-0e62cf30105e
INSERT INTO public.user_profiles (id, role)
VALUES ('1ab7daf1-0c42-4f42-b01e-0e62cf30105e', 'admin')
ON CONFLICT (id) DO UPDATE SET role = 'admin';

-- Verify it worked
SELECT * FROM public.user_profiles WHERE id = '1ab7daf1-0c42-4f42-b01e-0e62cf30105e';

