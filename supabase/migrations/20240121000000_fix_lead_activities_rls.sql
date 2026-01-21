/*
  # Fix RLS Policies for lead_activities
  
  Ensure all authenticated users can insert activities for any lead.
  This is needed because all users can view all leads, so they should
  be able to create activities (status changes, calls, etc.) for any lead.
*/

-- Drop all existing INSERT policies for lead_activities
DROP POLICY IF EXISTS "Admins can insert activities for any lead" ON public.lead_activities;
DROP POLICY IF EXISTS "Users can insert activities for their leads" ON public.lead_activities;
DROP POLICY IF EXISTS "All users can insert activities for any lead" ON public.lead_activities;

-- Create a single, simple policy: All authenticated users can insert activities
CREATE POLICY "All authenticated users can insert activities"
  ON public.lead_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

-- Ensure SELECT policy allows all authenticated users to view all activities
DROP POLICY IF EXISTS "All users can view all activities" ON public.lead_activities;
CREATE POLICY "All authenticated users can view all activities"
  ON public.lead_activities
  FOR SELECT
  TO authenticated
  USING (true);

-- Ensure UPDATE policy (if needed for editing activities)
DROP POLICY IF EXISTS "Users can update their own activities" ON public.lead_activities;
CREATE POLICY "Users can update activities they created"
  ON public.lead_activities
  FOR UPDATE
  TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- Ensure DELETE policy (if needed)
DROP POLICY IF EXISTS "Users can delete their own activities" ON public.lead_activities;
CREATE POLICY "Users can delete activities they created"
  ON public.lead_activities
  FOR DELETE
  TO authenticated
  USING (created_by = auth.uid());

