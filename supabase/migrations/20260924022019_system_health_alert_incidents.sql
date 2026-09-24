-- Operational notification state, not business data. Keep it outside public so
-- it does not change the verified business-backup inventory/export fence. A
-- disaster recovery may reset deduplication and send one fresh incident notice.
create schema if not exists private;
create table private.system_health_alert_incidents (
  check_id text not null check (check_id ~ '^[a-z0-9-]{1,100}$'),
  recipient_key text not null check (recipient_key ~ '^[a-f0-9]{64}$'),
  incident_open boolean not null default false,
  notified_level integer not null default 0 check (notified_level between 0 and 2),
  last_observed_at timestamptz not null default '-infinity',
  claimed_by uuid,
  claimed_level integer check (claimed_level between 1 and 2),
  claim_expires_at timestamptz,
  last_notified_at timestamptz,
  resolved_at timestamptz,
  primary key (check_id, recipient_key)
);
alter table private.system_health_alert_incidents enable row level security;
revoke all on private.system_health_alert_incidents from public, anon, authenticated, service_role;
grant usage on schema private to service_role;
grant select, insert, update on private.system_health_alert_incidents to service_role;

-- Invoker security: only service_role has both EXECUTE and table permissions.
create function public.claim_system_health_alerts(p_observations jsonb, p_token uuid, p_recipient_key text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  observation jsonb;
  state private.system_health_alert_incidents%rowtype;
  check_key text;
  level_value integer;
  observed_at_value timestamptz;
  now_value timestamptz := clock_timestamp();
  claims jsonb := '[]'::jsonb;
begin
  if p_token is null or p_recipient_key is null or p_recipient_key !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(p_observations) is distinct from 'array'
    or jsonb_array_length(p_observations) > 100 then
    raise exception 'A token, recipient key and at most 100 health observations are required.';
  end if;
  -- Serializes manual/cron calls including the initial empty-table case.
  perform pg_advisory_xact_lock(hashtextextended('fcuno.system-health-alerts', 0));
  for observation in select value from jsonb_array_elements(p_observations) loop
    check_key := observation->>'check_id';
    level_value := (observation->>'alert_level')::integer;
    observed_at_value := (observation->>'observed_at')::timestamptz;
    if check_key is null or check_key !~ '^[a-z0-9-]{1,100}$'
      or observed_at_value is null or not isfinite(observed_at_value)
      or observed_at_value > now_value + interval '5 minutes'
      or (level_value is not null and level_value not between 0 and 2) then
      raise exception 'Invalid health observation.';
    end if;
    insert into private.system_health_alert_incidents(check_id, recipient_key)
      values (check_key, p_recipient_key) on conflict do nothing;
    select * into state from private.system_health_alert_incidents
      where check_id = check_key and recipient_key = p_recipient_key for update;
    if observed_at_value <= state.last_observed_at then continue; end if;

    update private.system_health_alert_incidents set last_observed_at = observed_at_value
      where check_id = check_key and recipient_key = p_recipient_key;
    -- Pending/unknown results must not close an existing incident.
    if level_value is null then continue; end if;
    if level_value = 0 then
      update private.system_health_alert_incidents set
        incident_open = false, notified_level = 0, claimed_by = null,
        claimed_level = null, claim_expires_at = null,
        resolved_at = case when incident_open then now_value else resolved_at end
        where check_id = check_key and recipient_key = p_recipient_key;
      continue;
    end if;
    update private.system_health_alert_incidents set incident_open = true, resolved_at = null
      where check_id = check_key and recipient_key = p_recipient_key;
    if level_value > state.notified_level
      and (state.claimed_by is null or state.claim_expires_at <= now_value) then
      update private.system_health_alert_incidents set claimed_by = p_token,
        claimed_level = level_value, claim_expires_at = now_value + interval '10 minutes'
        where check_id = check_key and recipient_key = p_recipient_key;
      claims := claims || jsonb_build_array(check_key);
    end if;
  end loop;
  return claims;
end;
$$;

create function public.finish_system_health_alerts(p_token uuid, p_delivered boolean)
returns void language plpgsql security invoker set search_path = '' as $$
begin
  if p_token is null or p_delivered is null then raise exception 'Token and delivery result required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended('fcuno.system-health-alerts', 0));
  update private.system_health_alert_incidents set
    notified_level = case when p_delivered then greatest(notified_level, claimed_level) else notified_level end,
    last_notified_at = case when p_delivered then clock_timestamp() else last_notified_at end,
    claimed_by = null, claimed_level = null, claim_expires_at = null
    where claimed_by = p_token;
end;
$$;

revoke all on function public.claim_system_health_alerts(jsonb, uuid, text) from public, anon, authenticated;
revoke all on function public.finish_system_health_alerts(uuid, boolean) from public, anon, authenticated;
grant execute on function public.claim_system_health_alerts(jsonb, uuid, text) to service_role;
grant execute on function public.finish_system_health_alerts(uuid, boolean) to service_role;
