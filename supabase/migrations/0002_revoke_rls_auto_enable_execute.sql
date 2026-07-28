-- rls_auto_enable() is a platform-provided event trigger that enables RLS on
-- newly created public tables. Event triggers fire as the function owner via
-- the DDL event system, so no role needs EXECUTE on it. Revoking removes it
-- from the exposed PostgREST RPC surface without affecting its behaviour.
revoke execute on function public.rls_auto_enable() from anon;
revoke execute on function public.rls_auto_enable() from authenticated;
revoke execute on function public.rls_auto_enable() from public;
