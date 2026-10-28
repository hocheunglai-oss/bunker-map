-- A certified recipient refresh changes derived evidence, not the template
-- body. Preserve one audit row with its existing protections, complete recipient before/after
-- evidence, context and the unchanged bodies' SHA-256/byte lengths, without
-- serializing and storing the same large bodies twice on every certification.
-- Ordinary user edits, inserts and deletes retain their original full rows.
-- No existing history, table columns, certification proof or ACL is changed.
set local lock_timeout = '3s';
set local statement_timeout = '15s';

do $migration$
declare
  definition text;
  old_fragment text;
  new_fragment text;
begin
  if (select md5(prosrc) from pg_catalog.pg_proc where oid =
      'public.email_templates_manage_version()'::regprocedure)
      is distinct from '4646ac8be4bf19845802454e9c9221d6'
    or (select md5(prosrc) from pg_catalog.pg_proc where oid =
      'public.audit_table_changes()'::regprocedure)
      is distinct from '8f4cd3a68bb9e7b1d3cb2f84dbb4b2d6'
    or (select md5(prosrc) from pg_catalog.pg_proc where oid =
      'public.undo_audit_log_noncredential(uuid,text,text)'::regprocedure)
      is distinct from '98da2629147c14082a89e2f4a5abcb98'
  then
    raise exception 'Outlook certification audit repair requires the reviewed trigger and undo definitions.';
  end if;

  -- Typed copies let us clear the bodies before JSON serialization. Compare
  -- those bodies with exact C-collation equality, then retain the original
  -- JSON semantics for every other current/future column (including types
  -- without a native equality operator, such as json).
  definition := pg_catalog.pg_get_functiondef('public.email_templates_manage_version()'::regprocedure);
  definition := replace(definition, E'\nbegin\n', $replacement$
declare
  previous_template public.email_templates%rowtype;
  next_template public.email_templates%rowtype;
begin
$replacement$);
  old_fragment := E'  new.created_at := old.created_at;\n';
  new_fragment := $replacement$  new.created_at := old.created_at;

  if public.audit_text_setting('app.audit_actor_id') = 'system:outlook-template-recipient-truth'
    and public.audit_json_setting('app.audit_context')->>'action' = 'certified-projection-reconcile'
    and nullif(public.audit_text_setting('app.audit_undo_of_log_id'), '') is null
  then
    previous_template := old;
    next_template := new;
    previous_template.recipient_resolution := null;
    next_template.recipient_resolution := null;
    previous_template.revision := null;
    next_template.revision := null;
    previous_template.updated_at := null;
    next_template.updated_at := null;
    previous_template.body_html := null;
    previous_template.body_text := null;
    next_template.body_html := null;
    next_template.body_text := null;
    if old.body_html collate pg_catalog."C" is not distinct from new.body_html collate pg_catalog."C"
      and old.body_text collate pg_catalog."C" is not distinct from new.body_text collate pg_catalog."C"
      and to_jsonb(previous_template) is not distinct from to_jsonb(next_template)
    then
      if new.recipient_resolution is distinct from old.recipient_resolution then
        new.revision := old.revision + 1;
        new.updated_at := clock_timestamp();
      else
        new.revision := old.revision;
        new.updated_at := old.updated_at;
      end if;
      return new;
    end if;
  end if;
$replacement$;
  definition := replace(definition, old_fragment, new_fragment);
  execute definition;

  definition := pg_catalog.pg_get_functiondef('public.audit_table_changes()'::regprocedure);
  definition := replace(definition, E'  correlation_id uuid;\n', $replacement$  correlation_id uuid;
  previous_template public.email_templates%rowtype;
  next_template public.email_templates%rowtype;
  certification_refresh boolean := false;
  unchanged_bodies jsonb;
$replacement$);
  old_fragment := $replacement$  before_payload := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
  after_payload := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;$replacement$;
  new_fragment := $replacement$  if tg_table_schema = 'public' and tg_table_name = 'email_templates' and tg_op = 'UPDATE'
    and public.audit_text_setting('app.audit_actor_id') = 'system:outlook-template-recipient-truth'
    and public.audit_json_setting('app.audit_context')->>'action' = 'certified-projection-reconcile'
    and nullif(public.audit_text_setting('app.audit_undo_of_log_id'), '') is null
  then
    previous_template := old;
    next_template := new;
    -- Never trust caller labels alone. Every non-derived column must match.
    previous_template.recipient_resolution := null;
    next_template.recipient_resolution := null;
    previous_template.revision := null;
    next_template.revision := null;
    previous_template.updated_at := null;
    next_template.updated_at := null;
    previous_template.body_html := null;
    previous_template.body_text := null;
    next_template.body_html := null;
    next_template.body_text := null;
    certification_refresh := old.body_html collate pg_catalog."C" is not distinct from new.body_html collate pg_catalog."C"
      and old.body_text collate pg_catalog."C" is not distinct from new.body_text collate pg_catalog."C"
      and to_jsonb(previous_template) is not distinct from to_jsonb(next_template)
      and old.recipient_resolution is distinct from new.recipient_resolution
      and new.revision = old.revision + 1
      and new.recipient_resolution->>'certificationRunId'
        = public.audit_json_setting('app.audit_context')->>'certificationRunId'
      and new.recipient_resolution->>'sourceFingerprint'
        = public.audit_json_setting('app.audit_context')->>'sourceFingerprint';
    if certification_refresh then
      unchanged_bodies := jsonb_build_object(
        'body_html', jsonb_build_object('isNull', old.body_html is null,
          'byteLength', octet_length(old.body_html),
          'sha256', encode(sha256(convert_to(old.body_html, 'UTF8')), 'hex')),
        'body_text', jsonb_build_object('isNull', old.body_text is null,
          'byteLength', octet_length(old.body_text),
          'sha256', encode(sha256(convert_to(old.body_text, 'UTF8')), 'hex'))
      );
      previous_template := old;
      next_template := new;
      previous_template.body_html := null;
      previous_template.body_text := null;
      next_template.body_html := null;
      next_template.body_text := null;
      before_payload := to_jsonb(previous_template) - array['body_html', 'body_text'];
      after_payload := to_jsonb(next_template) - array['body_html', 'body_text'];
    end if;
  end if;

  if not coalesce(certification_refresh, false) then
    before_payload := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end;
    after_payload := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end;
  end if;$replacement$;
  definition := replace(definition, old_fragment, new_fragment);
  old_fragment := E'  undo_of := public.audit_uuid_setting(\'app.audit_undo_of_log_id\');';
  new_fragment := $replacement$  -- This reserved representation is generated here, never supplied by a
  -- request header/context. It cannot disguise an ordinary edit as compact.
  context_payload := context_payload - 'auditRepresentation';
  if certification_refresh then
    context_payload := context_payload || jsonb_build_object('auditRepresentation', jsonb_build_object(
      'kind', 'outlook-certification-refresh-v1',
      'omittedUnchangedFields', unchanged_bodies,
      'undoable', false
    ));
  end if;
  undo_of := public.audit_uuid_setting('app.audit_undo_of_log_id');$replacement$;
  definition := replace(definition, old_fragment, new_fragment);
  execute definition;

  -- Restoring an obsolete certificate independently is not a valid business
  -- undo. Explicitly refuse this new representation; old full-row history is
  -- untouched and ordinary optimistic-concurrency undo retains its behavior.
  definition := pg_catalog.pg_get_functiondef('public.undo_audit_log_noncredential(uuid,text,text)'::regprocedure);
  old_fragment := E'  where_sql := public.audit_pk_where(audit_record.record_pk);';
  new_fragment := $replacement$  if audit_record.table_schema = 'public'
    and audit_record.table_name = 'email_templates'
    and audit_record.request_context #>> '{auditRepresentation,kind}' = 'outlook-certification-refresh-v1'
  then
    raise exception 'Certified recipient refresh evidence cannot be undone independently. Refresh the current certification instead.';
  end if;

  where_sql := public.audit_pk_where(audit_record.record_pk);$replacement$;
  definition := replace(definition, old_fragment, new_fragment);
  execute definition;
end;
$migration$;
