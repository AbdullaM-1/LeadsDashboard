/*
  # Update RLS Policies to Allow All Users to Create Activities

  Since leads are accessible to all users, all users should be able to create activities
  (like status changes) for any lead. This allows tracking who made each change.
*/

-- Drop existing activity insert policies
DROP POLICY IF EXISTS "Admins can insert activities for any lead" ON public.lead_activities;
DROP POLICY IF EXISTS "Users can insert activities for their leads" ON public.lead_activities;

-- Policy: All authenticated users can insert activities for any lead
-- This allows any user to change status and have their name tracked
CREATE POLICY "All users can insert activities for any lead"
  ON public.lead_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

