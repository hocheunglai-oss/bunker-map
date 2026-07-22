-- Return only the currently valid Exchange mutation lease, using PostgreSQL's
-- clock so callers never fail open because an application host clock drifted.
create or replace function public.get_active_outlook_exchange_sync_lock()
returns table (
  run_id uuid,
  sync_mode text,
  acquired_at timestamptz,
  heartbeat_at timestamptz,
  expires_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    lock_row.run_id,
    lock_row.sync_mode,
    lock_row.acquired_at,
    lock_row.heartbeat_at,
    lock_row.expires_at
  from public.outlook_exchange_sync_lock as lock_row
  where lock_row.lock_name = 'addressbook'
    and lock_row.expires_at > clock_timestamp()
  limit 1;
$$;

revoke all on function public.get_active_outlook_exchange_sync_lock()
from public, anon, authenticated;

grant execute on function public.get_active_outlook_exchange_sync_lock()
to service_role;
