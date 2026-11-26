-- Supabase's default privileges grant new functions to anon/authenticated; the hash helper is internal.
revoke execute on function public.sync_key_hash(text) from anon, authenticated;
