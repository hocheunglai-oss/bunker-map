alter table public.spc_mobile_modes
  drop constraint if exists spc_mobile_modes_active_expiry;

update public.spc_mobile_modes
set expires_at = null
where enabled;

drop index if exists public.spc_mobile_modes_active_idx;
create index spc_mobile_modes_active_idx
  on public.spc_mobile_modes(updated_at desc)
  where enabled;

comment on column public.spc_mobile_modes.expires_at is
  'Legacy expiry field. Manual Mobile Mode remains active until the user switches it off.';
