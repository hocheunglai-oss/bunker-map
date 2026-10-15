-- Durable, service-only notification policy; sync outcomes and queue data are
-- unchanged. Reuse the already backed-up settings store rather than adding a
-- table to the backup inventory. No names, addresses, or raw errors are stored.
create or replace function public.observe_outlook_exchange_alert(
  p_run_id uuid,
  p_scope text,
  p_incidents jsonb,
  p_recovery_proven boolean,
  p_observation_complete boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_store_key text;
  v_now timestamptz;
  v_state jsonb;
  v_incidents jsonb;
  v_item jsonb;
  v_key text;
  v_entry jsonb;
  v_keys jsonb := '[]'::jsonb;
  v_seen_keys text[] := array[]::text[];
  v_claim jsonb;
  v_claim_id uuid;
  v_claim_keys jsonb;
  v_reason text := 'no_current_issue';
begin
  if p_run_id is null or p_scope is null or p_scope not in ('incremental', 'full')
     or p_recovery_proven is null or p_observation_complete is null then
    raise exception 'Invalid Exchange alert observation arguments' using errcode = '22023';
  end if;
  if p_incidents is null or jsonb_typeof(p_incidents) <> 'array' then
    raise exception 'Exchange alert incidents must be an array' using errcode = '22023';
  end if;
  if jsonb_array_length(p_incidents) > 1000 or octet_length(p_incidents::text) > 262144 then
    raise exception 'Exchange alert observation exceeds its size limit' using errcode = '22023';
  end if;
  if p_recovery_proven and jsonb_array_length(p_incidents) <> 0 then
    raise exception 'Recovery cannot include unresolved Exchange incidents' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_incidents) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item -> 'key') is distinct from 'string'
       or (v_item ->> 'key') !~ '^[0-9a-f]{64}$'
       or jsonb_typeof(v_item -> 'kind') is distinct from 'string'
       or (v_item ->> 'kind') not in ('contact_correction', 'sync_delayed', 'service_access', 'verification', 'sync_issue')
       or jsonb_typeof(v_item -> 'immediate') is distinct from 'boolean'
       or (v_item - array['key', 'kind', 'immediate']) <> '{}'::jsonb then
      raise exception 'Invalid Exchange alert incident' using errcode = '22023';
    end if;
    if (v_item ->> 'key') = any(v_seen_keys) then
      raise exception 'Duplicate Exchange alert incident key' using errcode = '22023';
    end if;
    v_seen_keys := array_append(v_seen_keys, v_item ->> 'key');
  end loop;

  v_store_key := 'outlook-addressbook-exchange-alerts:' || p_scope;
  perform pg_advisory_xact_lock(hashtextextended(v_store_key, 0));
  v_now := clock_timestamp();
  select payload into v_state from public.office_calendar_store where key = v_store_key for update;
  if v_state is null then
    v_state := jsonb_build_object('version', 1, 'incidents', '{}'::jsonb);
  end if;
  if v_state ->> 'version' is distinct from '1'
     or jsonb_typeof(v_state -> 'incidents') is distinct from 'object' then
    raise exception 'Exchange alert history is invalid; refusing to reset delivery history';
  end if;

  -- A successful, verified recovery rearms all old hashes. Clearing the claim
  -- also fences off acknowledgements from a prior incident.
  if p_recovery_proven then
    v_state := jsonb_build_object('version', 1, 'incidents', '{}'::jsonb, 'recoveredAt', v_now);
    insert into public.office_calendar_store(key, payload, updated_at)
    values (v_store_key, v_state, v_now)
    on conflict (key) do update set payload = excluded.payload, updated_at = excluded.updated_at;
    return jsonb_build_object('shouldNotify', false, 'claimId', null, 'incidentKeys', '[]'::jsonb, 'reason', 'recovered');
  end if;

  v_incidents := v_state -> 'incidents';
  if p_observation_complete then
    -- Only a verified, complete current observation may resolve absent issues.
    -- Partial/startup failures must leave unrelated history untouched. This
    -- prevents yesterday's transient failure from making a fresh one appear
    -- persistent merely because an unrelated terminal contact is still open.
    select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      into v_incidents
      from jsonb_each(v_incidents) e
      where e.key = any(v_seen_keys);
    v_claim := v_state -> 'claim';
    if v_claim is not null then
      select coalesce(jsonb_agg(k.value), '[]'::jsonb)
        into v_claim_keys
        from jsonb_array_elements_text(v_claim -> 'incidentKeys') k
        where k.value = any(v_seen_keys);
      if jsonb_array_length(v_claim_keys) = 0 then
        v_state := v_state - 'claim';
      else
        -- Preserve the same lease for still-active issues, but remove resolved
        -- keys so its later acknowledgement cannot mark a recurrence delivered.
        v_state := jsonb_set(v_state, '{claim,incidentKeys}', v_claim_keys);
      end if;
    end if;
  end if;
  for v_item in select value from jsonb_array_elements(p_incidents) loop
    v_key := v_item ->> 'key';
    v_entry := v_incidents -> v_key;
    if v_entry is null then
      v_entry := jsonb_build_object(
        'kind', v_item ->> 'kind', 'immediate', (v_item ->> 'immediate')::boolean,
        'firstSeen', v_now, 'lastSeen', v_now, 'firstRunId', p_run_id, 'distinctRuns', 1
      );
    else
      if v_entry ->> 'kind' is distinct from v_item ->> 'kind' then
        raise exception 'Exchange alert kind must be included in its stable incident key' using errcode = '22023';
      end if;
      v_entry := v_entry || jsonb_build_object(
        'lastSeen', v_now,
        'immediate', coalesce((v_entry ->> 'immediate')::boolean, false) or (v_item ->> 'immediate')::boolean,
        'distinctRuns', case when (v_entry ->> 'firstRunId')::uuid <> p_run_id then 2 else (v_entry ->> 'distinctRuns')::int end
      );
    end if;
    v_incidents := jsonb_set(v_incidents, array[v_key], v_entry);
    if not (v_entry ? 'notifiedAt') then
      if (v_entry ->> 'immediate')::boolean
         or ((v_entry ->> 'distinctRuns')::int >= 2 and (v_entry ->> 'firstSeen')::timestamptz <= v_now - interval '45 minutes') then
        v_keys := v_keys || jsonb_build_array(v_key);
      end if;
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(v_incidents)) > 10000 then
    raise exception 'Exchange alert history exceeds its size limit; investigate unresolved incidents';
  end if;
  v_state := jsonb_set(v_state, '{incidents}', v_incidents);
  v_claim := v_state -> 'claim';

  if v_claim is not null and (v_claim ->> 'expiresAt')::timestamptz > v_now then
    -- Observations may add information but must never overwrite an active claim.
    v_keys := '[]'::jsonb;
    v_reason := 'delivery_in_progress';
  else
    v_state := v_state - 'claim';
    if jsonb_array_length(v_keys) > 0 then
      v_claim_id := gen_random_uuid();
      v_state := jsonb_set(v_state, '{claim}', jsonb_build_object(
        'id', v_claim_id, 'incidentKeys', v_keys, 'createdAt', v_now, 'expiresAt', v_now + interval '15 minutes'
      ));
      v_reason := 'notification_claimed';
    elsif jsonb_array_length(p_incidents) > 0 then
      v_reason := case when exists (
        select 1 from jsonb_array_elements(p_incidents) i
        where not ((v_incidents -> (i ->> 'key')) ? 'notifiedAt')
      ) then 'waiting_for_persistence' else 'already_notified' end;
    end if;
  end if;

  insert into public.office_calendar_store(key, payload, updated_at)
  values (v_store_key, v_state, v_now)
  on conflict (key) do update set payload = excluded.payload, updated_at = excluded.updated_at;
  return jsonb_build_object(
    'shouldNotify', v_claim_id is not null, 'claimId', v_claim_id, 'incidentKeys', v_keys, 'reason', v_reason
  );
end;
$$;

create or replace function public.complete_outlook_exchange_alert(
  p_scope text,
  p_claim_id uuid,
  p_delivered boolean
) returns jsonb
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_store_key text;
  v_now timestamptz;
  v_state jsonb;
  v_claim jsonb;
  v_incidents jsonb;
  v_key text;
begin
  if p_scope is null or p_scope not in ('incremental', 'full') or p_claim_id is null or p_delivered is null then
    raise exception 'Invalid Exchange alert completion arguments' using errcode = '22023';
  end if;
  v_store_key := 'outlook-addressbook-exchange-alerts:' || p_scope;
  perform pg_advisory_xact_lock(hashtextextended(v_store_key, 0));
  v_now := clock_timestamp();
  select payload into v_state from public.office_calendar_store where key = v_store_key for update;
  if v_state is null then
    return jsonb_build_object('accepted', false, 'reason', 'claim_not_found');
  end if;
  if v_state ->> 'version' is distinct from '1'
     or jsonb_typeof(v_state -> 'incidents') is distinct from 'object' then
    raise exception 'Exchange alert history is invalid; refusing to change delivery history';
  end if;
  if v_state #>> '{lastCompletion,id}' = p_claim_id::text then
    return jsonb_build_object('accepted', true, 'reason', 'already_completed', 'delivered', (v_state #>> '{lastCompletion,delivered}')::boolean);
  end if;
  v_claim := v_state -> 'claim';
  if v_claim is null or v_claim ->> 'id' is distinct from p_claim_id::text then
    return jsonb_build_object('accepted', false, 'reason', 'claim_not_found');
  end if;
  if (v_claim ->> 'expiresAt')::timestamptz <= v_now then
    return jsonb_build_object('accepted', false, 'reason', 'claim_expired');
  end if;
  v_incidents := v_state -> 'incidents';
  if p_delivered then
    for v_key in select jsonb_array_elements_text(v_claim -> 'incidentKeys') loop
      if v_incidents ? v_key then
        v_incidents := jsonb_set(v_incidents, array[v_key, 'notifiedAt'], to_jsonb(v_now));
      end if;
    end loop;
  end if;
  v_state := (v_state - 'claim') || jsonb_build_object(
    'incidents', v_incidents,
    'lastCompletion', jsonb_build_object('id', p_claim_id, 'delivered', p_delivered, 'at', v_now)
  );
  update public.office_calendar_store set payload = v_state, updated_at = v_now where key = v_store_key;
  return jsonb_build_object('accepted', true, 'reason', case when p_delivered then 'delivered' else 'released' end, 'delivered', p_delivered);
end;
$$;

revoke all on function public.observe_outlook_exchange_alert(uuid, text, jsonb, boolean, boolean) from public, anon, authenticated;
revoke all on function public.complete_outlook_exchange_alert(text, uuid, boolean) from public, anon, authenticated;
grant execute on function public.observe_outlook_exchange_alert(uuid, text, jsonb, boolean, boolean) to service_role;
grant execute on function public.complete_outlook_exchange_alert(text, uuid, boolean) to service_role;

comment on function public.observe_outlook_exchange_alert(uuid, text, jsonb, boolean, boolean) is
  'Service-only notification dedupe. Immediate incidents alert once; temporary incidents require two distinct runs and 45 minutes. Only verified recovery or a complete observation resolves absent issues. Does not modify sync outcomes.';
comment on function public.complete_outlook_exchange_alert(text, uuid, boolean) is
  'Acknowledge an unexpired Exchange email claim after transport delivery; failed transport releases it. Claim IDs fence off stale acknowledgements.';
