/*
  # Update RLS Policies for Role-Based Access

  1. Update Leads Policies
    - Admins can view/update/delete all leads
    - Users can view/update/delete their own leads
    - All authenticated users can view all leads (as per requirement)

  2. Update Lead Activities Policies
    - Admins can view all activities
    - Users can view activities for their own leads
*/

-- Drop existing policies
DROP POLICY IF EXISTS "Users can view their own leads" ON public.leads;
DROP POLICY IF EXISTS "Users can insert their own leads" ON public.leads;
DROP POLICY IF EXISTS "Users can update their own leads" ON public.leads;
DROP POLICY IF EXISTS "Users can delete their own leads" ON public.leads;

DROP POLICY IF EXISTS "Users can view activities for their leads" ON public.lead_activities;
DROP POLICY IF EXISTS "Users can insert activities for their leads" ON public.lead_activities;

-- Helper function to check if user is admin
CREATE OR REPLACE FUNCTION public.is_admin(user_id uuid)
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = user_id
    AND role = 'admin'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Leads Policies

-- Policy: All authenticated users can view all leads
CREATE POLICY "All users can view all leads"
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (true);

-- Policy: Admins can insert leads for any user
CREATE POLICY "Admins can insert any lead"
  ON public.leads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin(auth.uid())
  );

-- Policy: Users can insert their own leads
CREATE POLICY "Users can insert their own leads"
  ON public.leads
  FOR INSERT
  TO authenticated
  WITH CHECK (
    auth.uid() = user_id
    AND NOT public.is_admin(auth.uid())
  );

-- Policy: Admins can update any lead
CREATE POLICY "Admins can update any lead"
  ON public.leads
  FOR UPDATE
  TO authenticated
  USING (public.is_admin(auth.uid()))
  WITH CHECK (public.is_admin(auth.uid()));

-- Policy: Users can update their own leads
CREATE POLICY "Users can update their own leads"
  ON public.leads
  FOR UPDATE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND NOT public.is_admin(auth.uid())
  )
  WITH CHECK (
    auth.uid() = user_id
    AND NOT public.is_admin(auth.uid())
  );

-- Policy: Admins can delete any lead
CREATE POLICY "Admins can delete any lead"
  ON public.leads
  FOR DELETE
  TO authenticated
  USING (public.is_admin(auth.uid()));

-- Policy: Users can delete their own leads
CREATE POLICY "Users can delete their own leads"
  ON public.leads
  FOR DELETE
  TO authenticated
  USING (
    auth.uid() = user_id
    AND NOT public.is_admin(auth.uid())
  );

-- Lead Activities Policies

-- Policy: All users can view activities for all leads (since all can view leads)
CREATE POLICY "All users can view all activities"
  ON public.lead_activities
  FOR SELECT
  TO authenticated
  USING (true);

-- Policy: Admins can insert activities for any lead
CREATE POLICY "Admins can insert activities for any lead"
  ON public.lead_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_activities.lead_id
      AND leads.user_id = auth.uid()
    )
  );

-- Policy: Users can insert activities for their own leads
CREATE POLICY "Users can insert activities for their leads"
  ON public.lead_activities
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.leads
      WHERE leads.id = lead_activities.lead_id
      AND leads.user_id = auth.uid()
      AND NOT public.is_admin(auth.uid())
    )
  );

