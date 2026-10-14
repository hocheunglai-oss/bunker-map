-- Rename one logical CCINFO folder and its complete subtree in one transaction.
-- Paths are compared literally: punctuation and SQL LIKE wildcards are names.
alter table public.cc_entry_folders add column if not exists implicit boolean not null default false;
create or replace function private.ccinfo_company_folder_path(p_path text)
returns text language sql immutable security invoker set search_path = '' as $$
  with normalized as (select pg_catalog.replace(coalesce(p_path, ''), E'\\', '/') as value),
  relative as (select coalesce(
    substring(value from '- Company Information/[^/]+/(.+)$'),
    substring(value from '(?i)company/[^/]+/(.+)$'), '') as value from normalized),
  segments as (select pg_catalog.array_remove(pg_catalog.string_to_array(value, '/'), '') as parts from relative)
  select coalesce(pg_catalog.array_to_string(parts[1:pg_catalog.cardinality(parts)-1], '/'), '') from segments;
$$;
revoke all on function private.ccinfo_company_folder_path(text) from public, anon, authenticated;
grant execute on function private.ccinfo_company_folder_path(text) to service_role;

create or replace function private.ccinfo_rebase_original_path(p_original text, p_kind text, p_entry_name text, p_folder text, p_file text)
returns text language sql immutable security invoker set search_path = '' as $$
  select coalesce(
    substring(pg_catalog.replace(coalesce(p_original, ''), E'\\', '/') from '^(.*- Company Information/[^/]+)(?:/.*)?$'),
    substring(pg_catalog.replace(coalesce(p_original, ''), E'\\', '/') from ('(?i)^(' || p_kind || '/[^/]+)(?:/.*)?$')),
    p_kind || '/' || p_entry_name
  ) || '/' || case when p_folder = '' then '' else p_folder || '/' end || p_file;
$$;
revoke all on function private.ccinfo_rebase_original_path(text,text,text,text,text) from public, anon, authenticated;
grant execute on function private.ccinfo_rebase_original_path(text,text,text,text,text) to service_role;

create or replace function private.relocate_ccinfo_folder(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text,
  p_expected_updated_at timestamptz, p_parent_path text, p_name text, p_action text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  entry_name text;
  root public.cc_entry_folders%rowtype;
  next_name text := pg_catalog.btrim(p_name);
  next_path text;
  prior_timeout text;
  prior_context jsonb;
  prior_headers jsonb;
  folder_changes jsonb;
  entry_changes jsonb;
  company_changes jsonb := '[]'::jsonb;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode = '42501', message = 'A signed-in audit actor is required.';
  end if;
  if p_entry_kind is null or p_entry_kind not in ('company','country','port') or p_entry_id is null
    or p_folder_path is null or p_folder_path = '' or p_folder_path ~ '(^/|/$|//)'
    or p_parent_path is null or p_parent_path ~ '(^/|/$|//)'
    or next_name is null or next_name = '' or pg_catalog.char_length(next_name) > 200
    or next_name ~ '[[:cntrl:]/\\]'
    or p_action is null or p_action not in ('ccinfo_folder_rename','ccinfo_folder_move') then
    raise exception using errcode = '22023', message = 'A valid entry, folder and single folder name are required.';
  end if;
  prior_timeout := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout', '5s', true);
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  -- Lock the owning entity before file tables, matching entity-delete/FK order.
  if p_entry_kind = 'company' then
    select name into entry_name from public.cc_companies where id = p_entry_id for key share;
  elsif p_entry_kind = 'country' then
    select name into entry_name from public.cc_countries where id = p_entry_id for key share;
  else
    select name into entry_name from public.cc_ports where id = p_entry_id for key share;
  end if;
  if not found then raise exception using errcode = '40001', message = 'This entry was removed. Reopen it.'; end if;
  -- Legacy writers are included before commit, and cannot insert a destination
  -- collision between preflight and the writes. No new tables are introduced.
  lock table public.cc_entry_folders in share row exclusive mode;
  lock table public.cc_entry_files in share row exclusive mode;
  if p_entry_kind = 'company' then lock table public.cc_company_files in share row exclusive mode; end if;
  if p_folder_id is not null then
    select * into root from public.cc_entry_folders
      where id = p_folder_id and entry_kind = p_entry_kind and entry_id = p_entry_id for update;
    if not found or root.updated_at is distinct from p_expected_updated_at
      or pg_catalog.concat_ws('/',nullif(root.folder_path,''),root.name) <> p_folder_path then
      raise exception using errcode = '40001', message = 'This folder changed. Reopen it before renaming.';
    end if;
  elsif exists (select 1 from public.cc_entry_folders where entry_kind = p_entry_kind and entry_id = p_entry_id
      and pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path) then
    raise exception using errcode = '40001', message = 'This folder changed. Reopen it before renaming.';
  elsif not exists (select 1 from public.cc_entry_files where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/')))
    and not exists (select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
      and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/')))
    and not (p_entry_kind = 'company' and exists (select 1 from public.cc_company_files where company_id = p_entry_id
      and (private.ccinfo_company_folder_path(original_path) = p_folder_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path || '/')))) then
    raise exception using errcode = '40001', message = 'This folder changed or was removed. Reopen it.';
  end if;
  if p_parent_path = p_folder_path or pg_catalog.starts_with(p_parent_path,p_folder_path || '/') then
    raise exception using errcode = '22023', message = 'A folder cannot be moved inside itself.';
  end if;
  if p_parent_path <> '' and not exists (select 1 from public.cc_entry_folders where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_parent_path
        or folder_path=p_parent_path or pg_catalog.starts_with(folder_path,p_parent_path || '/')))
    and not exists (select 1 from public.cc_entry_files where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = p_parent_path or pg_catalog.starts_with(folder_path,p_parent_path || '/')))
    and not (p_entry_kind = 'company' and exists (select 1 from public.cc_company_files where company_id = p_entry_id
      and (private.ccinfo_company_folder_path(original_path) = p_parent_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_parent_path || '/')))) then
    raise exception using errcode = '40001', message = 'The destination folder changed or was removed. Reopen it.';
  end if;
  next_path := pg_catalog.concat_ws('/',nullif(p_parent_path,''),next_name);
  if next_path = p_folder_path then raise exception using errcode = '22023', message = 'Enter a different folder name.'; end if;
  -- Reject merging into either an explicit or an implied folder, including
  -- recently deleted files that still occupy the database's unique paths.
  if exists (select 1 from public.cc_entry_folders where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name) = next_path
        or pg_catalog.starts_with(pg_catalog.concat_ws('/',nullif(folder_path,''),name),next_path || '/')))
    or exists (select 1 from public.cc_entry_files where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = next_path or pg_catalog.starts_with(folder_path,next_path || '/')))
    or (p_entry_kind = 'company' and exists (select 1 from public.cc_company_files where company_id = p_entry_id
      and (private.ccinfo_company_folder_path(original_path) = next_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),next_path || '/')))) then
    raise exception using errcode = '23505', message = 'Another folder already uses this name.';
  end if;
  prior_context := public.audit_json_setting('app.audit_context');
  prior_headers := public.audit_json_setting('request.headers');
  perform pg_catalog.set_config('request.headers',(prior_headers || pg_catalog.jsonb_build_object('x-bunker-audit-action',p_action))::text,true);
  perform pg_catalog.set_config('app.audit_context',(prior_context || pg_catalog.jsonb_build_object('action',p_action,'entryId',p_entry_id,'folderPath',p_folder_path))::text,true);
  with changed as (
    update public.cc_entry_folders set
      name = case when pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path then next_name else name end,
      folder_path = case when pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path then p_parent_path
        when folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/')
        then next_path || substring(folder_path from pg_catalog.length(p_folder_path)+1) else folder_path end
    where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name) = p_folder_path
        or folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/'))
    returning id,folder_path,name,updated_at,implicit
  ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)), '[]') into folder_changes from changed;
  with changed as (
    update public.cc_entry_files set
      folder_path = next_path || substring(folder_path from pg_catalog.length(p_folder_path)+1),
      original_path = private.ccinfo_rebase_original_path(original_path,p_entry_kind,entry_name,
        next_path || substring(folder_path from pg_catalog.length(p_folder_path)+1),file_name)
    where entry_kind = p_entry_kind and entry_id = p_entry_id
      and (folder_path = p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path || '/'))
    returning id,folder_path,original_path
  ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)), '[]') into entry_changes from changed;
  if p_entry_kind = 'company' then
    with changed as (
      update public.cc_company_files set original_path = private.ccinfo_rebase_original_path(original_path,'company',entry_name,
        next_path || substring(private.ccinfo_company_folder_path(original_path) from pg_catalog.length(p_folder_path)+1),file_name)
      where company_id = p_entry_id and (private.ccinfo_company_folder_path(original_path) = p_folder_path
        or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path || '/'))
      returning id,original_path,private.ccinfo_company_folder_path(original_path) as folder_path
    ) select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(changed)), '[]') into company_changes from changed;
  end if;
  perform pg_catalog.set_config('app.audit_context',prior_context::text,true);
  perform pg_catalog.set_config('request.headers',prior_headers::text,true);
  perform pg_catalog.set_config('lock_timeout',prior_timeout,true);
  return pg_catalog.jsonb_build_object('entryKind',p_entry_kind,'entryId',p_entry_id,
    'previousPath',p_folder_path,'folderPath',next_path,'folders',folder_changes,'entryFiles',entry_changes,'companyFiles',company_changes);
end;
$$;
revoke all on function private.relocate_ccinfo_folder(text,uuid,uuid,text,timestamptz,text,text,text) from public, anon, authenticated;
grant execute on function private.relocate_ccinfo_folder(text,uuid,uuid,text,timestamptz,text,text,text) to service_role;

create or replace function public.rename_ccinfo_folder(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text,
  p_expected_updated_at timestamptz, p_name text
)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.relocate_ccinfo_folder(p_entry_kind,p_entry_id,p_folder_id,p_folder_path,p_expected_updated_at,
    pg_catalog.regexp_replace(p_folder_path, '(^|/)[^/]+$', ''),p_name,'ccinfo_folder_rename');
$$;
revoke all on function public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text) to service_role;

create or replace function public.move_ccinfo_folder(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text,
  p_expected_updated_at timestamptz, p_target_parent_path text
)
returns jsonb language sql security invoker set search_path = '' as $$
  select private.relocate_ccinfo_folder(p_entry_kind,p_entry_id,p_folder_id,p_folder_path,p_expected_updated_at,
    p_target_parent_path,substring(p_folder_path from '[^/]+$'),'ccinfo_folder_move');
$$;
revoke all on function public.move_ccinfo_folder(text,uuid,uuid,text,timestamptz,text) from public, anon, authenticated;
grant execute on function public.move_ccinfo_folder(text,uuid,uuid,text,timestamptz,text) to service_role;

create or replace function public.delete_ccinfo_folder(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text,
  p_expected_updated_at timestamptz
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  root public.cc_entry_folders%rowtype;
  entry_file_ids jsonb := '[]'::jsonb;
  company_file_ids jsonb := '[]'::jsonb;
  folder_ids jsonb := '[]'::jsonb;
  deleted_time timestamptz := pg_catalog.clock_timestamp();
  prior_timeout text;
  prior_headers jsonb;
  prior_context jsonb;
  delete_contents boolean;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode = '42501', message = 'A signed-in audit actor is required.';
  end if;
  if p_entry_kind is null or p_entry_kind not in ('company','country','port') or p_entry_id is null
    or p_folder_path is null or p_folder_path = '' or p_folder_path ~ '(^/|/$|//)' then
    raise exception using errcode = '22023', message = 'A valid entry and folder are required.';
  end if;
  prior_timeout := pg_catalog.current_setting('lock_timeout');
  perform pg_catalog.set_config('lock_timeout','5s',true);
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  if p_entry_kind = 'company' then perform 1 from public.cc_companies where id=p_entry_id for key share;
  elsif p_entry_kind = 'country' then perform 1 from public.cc_countries where id=p_entry_id for key share;
  else perform 1 from public.cc_ports where id=p_entry_id for key share;
  end if;
  if not found then raise exception using errcode='40001',message='This entry was removed. Reopen it.'; end if;
  lock table public.cc_entry_folders in share row exclusive mode;
  lock table public.cc_entry_files in share row exclusive mode;
  if p_entry_kind='company' then lock table public.cc_company_files in share row exclusive mode; end if;
  if p_folder_id is not null then
    select * into root from public.cc_entry_folders where id=p_folder_id and entry_kind=p_entry_kind and entry_id=p_entry_id for update;
    if not found or root.updated_at is distinct from p_expected_updated_at
      or pg_catalog.concat_ws('/',nullif(root.folder_path,''),root.name)<>p_folder_path then
      raise exception using errcode='40001',message='This folder changed. Reopen it before deleting.';
    end if;
  elsif exists(select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
    and pg_catalog.concat_ws('/',nullif(folder_path,''),name)=p_folder_path) then
    raise exception using errcode='40001',message='This folder changed. Reopen it before deleting.';
  end if;
  delete_contents := p_folder_id is null or root.implicit;
  -- Explicit subfolders must remain accessible and are never silently removed.
  if exists(select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
    and (not delete_contents or not implicit)
    and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
    or (not delete_contents and (
      exists(select 1 from public.cc_entry_files where entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null
        and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
      or (p_entry_kind='company' and exists(select 1 from public.cc_company_files where company_id=p_entry_id and deleted_at is null
        and (private.ccinfo_company_folder_path(original_path)=p_folder_path
          or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path||'/')))))) then
    raise exception using errcode='23514',message='Move or delete files and subfolders inside this folder first.';
  end if;
  prior_headers:=public.audit_json_setting('request.headers');
  prior_context:=public.audit_json_setting('app.audit_context');
  perform pg_catalog.set_config('request.headers',(prior_headers||pg_catalog.jsonb_build_object('x-bunker-audit-action','ccinfo_folder_delete'))::text,true);
  perform pg_catalog.set_config('app.audit_context',(prior_context||pg_catalog.jsonb_build_object('action','ccinfo_folder_delete','entryId',p_entry_id,'folderPath',p_folder_path))::text,true);
  if not delete_contents then
    delete from public.cc_entry_folders where id=p_folder_id;
    folder_ids:=pg_catalog.jsonb_build_array(p_folder_id);
  else
    with changed as (update public.cc_entry_files set deleted_at=deleted_time
      where entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null
        and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')) returning id)
    select coalesce(pg_catalog.jsonb_agg(id),'[]') into entry_file_ids from changed;
    if p_entry_kind='company' then
      with changed as (update public.cc_company_files set deleted_at=deleted_time
        where company_id=p_entry_id and deleted_at is null and (private.ccinfo_company_folder_path(original_path)=p_folder_path
          or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path||'/')) returning id)
      select coalesce(pg_catalog.jsonb_agg(id),'[]') into company_file_ids from changed;
    end if;
    with removed as (delete from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id and implicit
      and (pg_catalog.concat_ws('/',nullif(folder_path,''),name)=p_folder_path
        or folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')) returning id)
    select coalesce(pg_catalog.jsonb_agg(id),'[]') into folder_ids from removed;
    if pg_catalog.jsonb_array_length(entry_file_ids)+pg_catalog.jsonb_array_length(company_file_ids)+pg_catalog.jsonb_array_length(folder_ids)=0 then
      raise exception using errcode='40001',message='This folder changed or was removed. Reopen it.';
    end if;
  end if;
  perform pg_catalog.set_config('request.headers',prior_headers::text,true);
  perform pg_catalog.set_config('app.audit_context',prior_context::text,true);
  perform pg_catalog.set_config('lock_timeout',prior_timeout,true);
  return pg_catalog.jsonb_build_object('entryKind',p_entry_kind,'entryId',p_entry_id,'folderPath',p_folder_path,
    'folderIds',folder_ids,'entryFileIds',entry_file_ids,'companyFileIds',company_file_ids,'deletedAt',deleted_time);
end;
$$;
revoke all on function public.delete_ccinfo_folder(text,uuid,uuid,text,timestamptz) from public, anon, authenticated;
grant execute on function public.delete_ccinfo_folder(text,uuid,uuid,text,timestamptz) to service_role;

-- Uploads and file moves resolve a stable destination ID again at the final
-- write. A request started before A -> B can never recreate a stale A path.
create or replace function public.prepare_ccinfo_file_target(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_folder_path text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  entry_name text;
  target public.cc_entry_folders%rowtype;
begin
  if coalesce(nullif(pg_catalog.btrim(public.audit_text_setting('app.audit_actor_id')), ''),
    nullif(pg_catalog.btrim(public.audit_request_header('x-bunker-admin-user')), '')) is null then
    raise exception using errcode='42501',message='A signed-in audit actor is required.';
  end if;
  if p_entry_kind is null or p_entry_kind not in ('company','country','port') or p_entry_id is null
    or p_folder_path is null or p_folder_path ~ '(^/|/$|//)' then
    raise exception using errcode='22023',message='A valid destination is required.';
  end if;
  perform pg_catalog.pg_advisory_xact_lock_shared(730261052372033133::bigint);
  if p_entry_kind='company' then select name into entry_name from public.cc_companies where id=p_entry_id for key share;
  elsif p_entry_kind='country' then select name into entry_name from public.cc_countries where id=p_entry_id for key share;
  else select name into entry_name from public.cc_ports where id=p_entry_id for key share;
  end if;
  if not found then raise exception using errcode='40001',message='The entry was removed. Reopen it.'; end if;
  lock table public.cc_entry_folders in share row exclusive mode;
  lock table public.cc_entry_files in share row exclusive mode;
  if p_entry_kind='company' then lock table public.cc_company_files in share row exclusive mode; end if;
  if p_folder_id is not null then
    select * into target from public.cc_entry_folders where id=p_folder_id and entry_kind=p_entry_kind and entry_id=p_entry_id for update;
    if not found then raise exception using errcode='40001',message='The destination was removed. Reopen it.'; end if;
  elsif p_folder_path<>'' then
    select * into target from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
      and pg_catalog.concat_ws('/',nullif(folder_path,''),name)=p_folder_path for update;
    if not found then
      if not exists(select 1 from public.cc_entry_folders where entry_kind=p_entry_kind and entry_id=p_entry_id
          and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
        and not exists(select 1 from public.cc_entry_files where entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null
          and (folder_path=p_folder_path or pg_catalog.starts_with(folder_path,p_folder_path||'/')))
        and not (p_entry_kind='company' and exists(select 1 from public.cc_company_files where company_id=p_entry_id and deleted_at is null
          and (private.ccinfo_company_folder_path(original_path)=p_folder_path
            or pg_catalog.starts_with(private.ccinfo_company_folder_path(original_path),p_folder_path||'/')))) then
        raise exception using errcode='40001',message='The destination changed or was removed. Reopen it.';
      end if;
      insert into public.cc_entry_folders(entry_kind,entry_id,folder_path,name,implicit)
      values(p_entry_kind,p_entry_id,pg_catalog.regexp_replace(p_folder_path,'(^|/)[^/]+$',''),substring(p_folder_path from '[^/]+$'),true) returning * into target;
    end if;
  end if;
  return pg_catalog.jsonb_build_object('entryKind',p_entry_kind,'entryId',p_entry_id,'entryName',entry_name,
    'folderId',target.id,'folderPath',case when target.id is null then '' else pg_catalog.concat_ws('/',nullif(target.folder_path,''),target.name) end);
end;
$$;
revoke all on function public.prepare_ccinfo_file_target(text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.prepare_ccinfo_file_target(text,uuid,uuid,text) to service_role;

create or replace function public.register_ccinfo_file(
  p_entry_kind text, p_entry_id uuid, p_folder_id uuid, p_file_name text,
  p_file_type text, p_drive_file_id text, p_drive_url text
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  target jsonb;
  saved public.cc_entry_files%rowtype;
  entry_name text;
  original text;
begin
  if p_file_name is null or p_file_name='' or p_drive_file_id is null or p_drive_file_id='' then
    raise exception using errcode='22023',message='A completed uploaded file is required.';
  end if;
  target:=public.prepare_ccinfo_file_target(p_entry_kind,p_entry_id,p_folder_id,'');
  entry_name:=pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.regexp_replace(target->>'entryName','[\\/]+',' - ','g'),'[[:space:]]+',' ','g'));
  original:=p_entry_kind||'/'||entry_name||'/'||case when target->>'folderPath'='' then '' else (target->>'folderPath')||'/' end||p_file_name;
  insert into public.cc_entry_files(entry_kind,entry_id,folder_path,file_name,file_type,drive_file_id,drive_url,deleted_at,original_path)
    values(p_entry_kind,p_entry_id,target->>'folderPath',p_file_name,p_file_type,p_drive_file_id,p_drive_url,null,original)
  on conflict(entry_kind,entry_id,original_path) do update set folder_path=excluded.folder_path,file_name=excluded.file_name,
    file_type=excluded.file_type,drive_file_id=excluded.drive_file_id,drive_url=excluded.drive_url,deleted_at=null
  returning * into saved;
  return pg_catalog.to_jsonb(saved)||pg_catalog.jsonb_build_object('source','entry');
end;
$$;
revoke all on function public.register_ccinfo_file(text,uuid,uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.register_ccinfo_file(text,uuid,uuid,text,text,text,text) to service_role;

create or replace function public.move_ccinfo_file(
  p_entry_kind text,p_entry_id uuid,p_source text,p_file_id uuid,p_expected_updated_at timestamptz,p_folder_id uuid
)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  target jsonb;
  saved jsonb;
  company_file public.cc_company_files%rowtype;
  entry_file public.cc_entry_files%rowtype;
begin
  target:=public.prepare_ccinfo_file_target(p_entry_kind,p_entry_id,p_folder_id,'');
  if p_source='company' and p_entry_kind='company' then
    select * into company_file from public.cc_company_files where id=p_file_id and company_id=p_entry_id and deleted_at is null for update;
    if not found or company_file.updated_at is distinct from p_expected_updated_at then raise exception using errcode='40001',message='This file changed or was removed. Reopen it.'; end if;
    update public.cc_company_files set original_path=private.ccinfo_rebase_original_path(original_path,'company',target->>'entryName',target->>'folderPath',file_name)
      where id=p_file_id returning pg_catalog.to_jsonb(cc_company_files.*) into saved;
  elsif p_source='entry' then
    select * into entry_file from public.cc_entry_files where id=p_file_id and entry_kind=p_entry_kind and entry_id=p_entry_id and deleted_at is null for update;
    if not found or entry_file.updated_at is distinct from p_expected_updated_at then raise exception using errcode='40001',message='This file changed or was removed. Reopen it.'; end if;
    update public.cc_entry_files set folder_path=target->>'folderPath',original_path=private.ccinfo_rebase_original_path(original_path,p_entry_kind,target->>'entryName',target->>'folderPath',file_name)
      where id=p_file_id returning pg_catalog.to_jsonb(cc_entry_files.*) into saved;
  else raise exception using errcode='22023',message='A valid file source is required.';
  end if;
  return saved||pg_catalog.jsonb_build_object('source',p_source,'folder_path',target->>'folderPath');
end;
$$;
revoke all on function public.move_ccinfo_file(text,uuid,text,uuid,timestamptz,uuid) from public, anon, authenticated;
grant execute on function public.move_ccinfo_file(text,uuid,text,uuid,timestamptz,uuid) to service_role;

-- A tree rename must not be undone as unrelated single-row audit operations.
create or replace function private.guard_ccinfo_folder_rename_undo()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.audit_logs where id = public.audit_uuid_setting('app.audit_undo_of_log_id')
    and table_schema = 'public' and table_name in ('cc_entry_folders','cc_entry_files','cc_company_files')
    and request_context ->> 'action' in ('ccinfo_folder_rename','ccinfo_folder_move')) then
    raise exception using errcode = '23514', message = 'Use Rename or Move to reverse this folder change. Its files cannot be undone separately.';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
revoke all on function private.guard_ccinfo_folder_rename_undo() from public, anon, authenticated, service_role;
create trigger guard_ccinfo_folder_rename_undo before update or delete on public.cc_entry_folders for each row execute function private.guard_ccinfo_folder_rename_undo();
create trigger guard_ccinfo_folder_rename_undo before update or delete on public.cc_entry_files for each row execute function private.guard_ccinfo_folder_rename_undo();
create trigger guard_ccinfo_folder_rename_undo before update or delete on public.cc_company_files for each row execute function private.guard_ccinfo_folder_rename_undo();
