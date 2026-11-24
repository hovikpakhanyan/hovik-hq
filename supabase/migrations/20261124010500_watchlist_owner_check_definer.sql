-- Follow-up to 20261124010000_watchlist_owner_writes.
-- public.hq_is_bound_owner() was security invoker, so the authenticated role
-- (which has no USAGE on schema hq_private) got "permission denied for schema
-- hq_private" and the page could never show the owner's edit controls.
-- Make it security definer so it can call hq_private.is_bound_owner(). It only
-- reports whether the caller (auth.uid()) is the bound owner.

create or replace function public.hq_is_bound_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select hq_private.is_bound_owner();
$$;

revoke all on function public.hq_is_bound_owner() from public, anon;
grant execute on function public.hq_is_bound_owner() to authenticated;
