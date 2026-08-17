create or replace function public.is_bunker_map_verified_backup_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.bunker_map_backup_lock as backup_lock
    where backup_lock.lock_name = 'daily-supabase-drive-v2'
      and backup_lock.expires_at > clock_timestamp()
  );
$$;

revoke all on function public.is_bunker_map_verified_backup_active()
from public, anon, authenticated;

grant execute on function public.is_bunker_map_verified_backup_active()
to service_role;
