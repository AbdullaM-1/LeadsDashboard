import { createBrowserClient } from '@supabase/ssr';

export const supabaseUrl = 'https://yiicekljygipqdcqxouu.supabase.co';
export const supabaseAnonKey = 'sb_publishable_TQIVUqqHPz1uhWhg8YOXFQ_LqCjSROr';

export const supabase = createBrowserClient(supabaseUrl, supabaseAnonKey);
