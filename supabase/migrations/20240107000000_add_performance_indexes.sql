CREATE INDEX IF NOT EXISTS leads_created_at_id_idx ON public.leads (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx ON public.leads (status);
CREATE INDEX IF NOT EXISTS leads_user_id_idx ON public.leads (user_id);

