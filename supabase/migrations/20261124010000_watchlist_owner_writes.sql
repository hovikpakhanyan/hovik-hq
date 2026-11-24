-- NOT APPLIED by this repository change. Review and run only after the owner
-- approves the merge. Does not run against the live database from this PR.
--
-- The bound owner may insert, update, and delete their own public.watchlist
-- rows. The check is the existing hq_private.is_bound_owner() gate. No other
-- table changes. The service-role key is not used and is not granted here.
--
-- public.hq_is_bound_owner() is the same check, exposed for the page. The
-- browser API does not expose the hq_private schema, so the page cannot call
-- hq_private.is_bound_owner() directly.

do $$ begin
  if to_regclass('public.watchlist') is null
     or to_regprocedure('hq_private.is_bound_owner()') is null then
    raise exception 'preflight abort: watchlist or owner check is missing';
  end if;
end $$;

grant insert, update, delete on table public.watchlist to authenticated;

create policy owner_insert on public.watchlist for insert to authenticated
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());

create policy owner_update on public.watchlist for update to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner())
  with check (owner_id = auth.uid() and hq_private.is_bound_owner());

create policy owner_delete on public.watchlist for delete to authenticated
  using (owner_id = auth.uid() and hq_private.is_bound_owner());

create or replace function public.hq_is_bound_owner()
returns boolean
language sql
stable
security invoker
set search_path = hq_private, public, pg_temp
as $$
  select hq_private.is_bound_owner();
$$;

revoke all on function public.hq_is_bound_owner() from public, anon;
grant execute on function public.hq_is_bound_owner() to authenticated;
