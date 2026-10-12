-- HK/Taiwan report roots include implicit Taiwan basis dependencies. A price
-- save must not rename a root away or turn it into a divider. AFTER UPDATE
-- also checks changes made by BEFORE triggers when name/type were not in SET.
-- Keep the existing save RPC and its complete transaction/replay semantics.
create function public.protect_required_report_port_identity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  old_name text := pg_catalog.lower(pg_catalog.btrim(old.name));
begin
  if old.type is distinct from 'divider'
    and old_name = any(array['hong kong', 'kaohsiung', 'keelung', 'taichung', 'suao', 'hualien'])
    and (pg_catalog.lower(pg_catalog.btrim(new.name)) is distinct from old_name
      or (new.type is not null and new.type <> 'port')) then
    raise exception using errcode = '23503', message = 'PORT_REQUIRED_NAME';
  end if;
  return new;
end;
$$;

-- Trigger execution needs no public Data API entry point or elevated rights.
revoke all on function public.protect_required_report_port_identity()
  from public, anon, authenticated, service_role;

create trigger protect_required_report_port_identity
after update on public.ports
for each row execute function public.protect_required_report_port_identity();
