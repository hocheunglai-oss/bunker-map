alter table public.spc_fixtures
  add column if not exists vessel_imo text;

alter table public.spc_fixtures
  drop constraint if exists spc_fixtures_vessel_imo_check;

alter table public.spc_fixtures
  add constraint spc_fixtures_vessel_imo_check
  check (vessel_imo is null or vessel_imo ~ '^[0-9]{7}$');

comment on column public.spc_fixtures.vessel_imo is
  'IMO snapshot copied from the enquiry when the fixture is created; legacy fixtures remain null.';

create index if not exists spc_fixtures_vessel_imo_idx
  on public.spc_fixtures(vessel_imo)
  where vessel_imo is not null;
