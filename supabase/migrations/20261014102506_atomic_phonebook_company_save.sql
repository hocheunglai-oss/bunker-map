-- Keep company identity, inherited details and linked card work in one commit.
-- No historical contact/source IDs are rewritten or backfilled.
create unique index phonebook_companies_normalized_name_key
  on public.phonebook_companies (upper(btrim(name)));

create or replace function private.guard_phonebook_company_identity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare undo_id uuid;
begin
  undo_id := public.audit_uuid_setting('app.audit_undo_of_log_id');
  if undo_id is not null and exists (select 1 from public.audit_logs l where l.id=undo_id
    and l.table_name in ('phonebook_companies','phonebook_contacts')
    and l.request_context->>'action'='phonebook_company_save'
    and (l.changed_fields && array['name','company'])) then
    raise exception using errcode='23514',message='Use the company editor to reverse a company rename and its contacts together.';
  end if;
  if tg_table_name='phonebook_companies' and tg_op='UPDATE' then
    if new.source_key is distinct from old.source_key then
      raise exception using errcode='23514',message='A company source identity cannot be changed.';
    end if;
    if new.name is distinct from old.name and current_setting('app.phonebook_company_save',true) is distinct from old.id::text then
      raise exception using errcode='23514',message='Reopen Phonebook to save the company and its contacts together.';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
revoke all on function private.guard_phonebook_company_identity() from public,anon,authenticated,service_role;
create trigger guard_phonebook_company_identity before insert or update or delete on public.phonebook_companies
  for each row execute function private.guard_phonebook_company_identity();
create trigger guard_phonebook_company_identity before insert or update or delete on public.phonebook_contacts
  for each row execute function private.guard_phonebook_company_identity();

create or replace function private.canonicalize_phonebook_contact_company()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare canonical_name text;
begin
  -- Owner-level pg_dump restores install triggers after loading the rows.
  -- Trusted raw historical imports also retain their original labels/keys;
  -- signed-in application writes still resolve and validate the company.
  if tg_op='INSERT' and nullif(public.audit_request_header('x-bunker-admin-user'),'') is null
    and nullif(public.audit_text_setting('app.audit_actor_id'),'') is null then return new; end if;
  if tg_op='UPDATE' and new.company is not distinct from old.company
    and new.company_source_id is not distinct from old.company_source_id then return new; end if;
  -- Modern source keys survive a rename. Legacy unmatched source IDs remain
  -- intact and resolve through the unique company name while it still exists.
  select c.name into canonical_name from public.phonebook_companies c
    where c.source_key=new.company_source_id for key share;
  if not found then
    select c.name into canonical_name from public.phonebook_companies c
      where upper(btrim(c.name))=upper(btrim(new.company)) for key share;
  end if;
  if not found then
    raise exception using errcode='23503',message='The selected company changed or was removed. Reopen the contact.';
  end if;
  new.company := canonical_name;
  new.search_text := lower(concat_ws(' ',new.full_name,new.company,new.title,new.name_remark,new.position,new.department,
    new.tel_ext,new.direct_line,new.mobile_area,new.mobile_1,new.mobile_2,new.personal_email,new.general_email,
    new.private_email,new.instant_messaging,new.others,new.area_of_responsibility,new.notes));
  return new;
end $$;
revoke all on function private.canonicalize_phonebook_contact_company() from public,anon,authenticated,service_role;
create trigger canonicalize_phonebook_contact_company before insert or update of company,company_source_id on public.phonebook_contacts
  for each row execute function private.canonicalize_phonebook_contact_company();

create or replace function private.advance_phonebook_company_version()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin new.updated_at := greatest(clock_timestamp(),old.updated_at+interval '1 microsecond'); return new; end $$;
revoke all on function private.advance_phonebook_company_version() from public,anon,authenticated,service_role;
drop trigger set_phonebook_companies_updated_at on public.phonebook_companies;
create trigger set_phonebook_companies_updated_at before update on public.phonebook_companies
  for each row execute function private.advance_phonebook_company_version();

create or replace function public.save_phonebook_company(p_id uuid,p_expected_updated_at timestamptz,p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  company public.phonebook_companies%rowtype;
  edited public.phonebook_companies%rowtype;
  saved public.phonebook_companies%rowtype;
  prior_headers jsonb; prior_context jsonb; prior_save text; prior_timeout text;
  contact_ids jsonb;
  allowed text[] := array['name','other_name','phone','address','country','tel_country','tel_area','tel_no_1','tel_no_2','tel_speed_dial','fax_no_1','website','email','contact_type','stem_management','company_status','company_info','seller_term','seller_credit_limit','seller_credit_limit_flexibility','seller_classification','seller_remark_1','seller_remark_2','seller_remark_3','seller_remark_4','buyer_term','buyer_credit_limit','buyer_credit_limit_flexibility','buyer_classification','buyer_remark_1','buyer_remark_2','buyer_remark_3','buyer_remark_4','notes'];
begin
  if coalesce(nullif(btrim(public.audit_text_setting('app.audit_actor_id')),''),nullif(btrim(public.audit_request_header('x-bunker-admin-user')),'')) is null then
    raise exception using errcode='42501',message='A signed-in audit actor is required.';
  end if;
  if p_id is null or p_expected_updated_at is null or not isfinite(p_expected_updated_at)
    or jsonb_typeof(p_patch) is distinct from 'object' or not p_patch ? 'name'
    or exists(select 1 from jsonb_each(p_patch) e where not e.key=any(allowed)
      or (jsonb_typeof(e.value) not in ('string','null')) or octet_length(e.value::text)>80002)
    or jsonb_typeof(p_patch->'name') is distinct from 'string'
    or nullif(btrim(p_patch->>'name'),'') is null or char_length(btrim(p_patch->>'name'))>200
    or (p_patch->>'name') ~ '[[:cntrl:]]' then
    raise exception using errcode='22023',message='Valid company details and a saved version are required.';
  end if;
  prior_timeout:=current_setting('lock_timeout'); perform set_config('lock_timeout','5s',true);
  perform pg_advisory_xact_lock_shared(730261052372033133::bigint);
  lock table public.phonebook_companies in share row exclusive mode;
  lock table public.phonebook_contacts in share row exclusive mode;
  select * into company from public.phonebook_companies where id=p_id for no key update;
  if not found or company.updated_at is distinct from p_expected_updated_at then
    raise exception using errcode='40001',message='The company changed or was removed. Reopen it.';
  end if;
  edited:=jsonb_populate_record(company,p_patch);
  edited.name:=upper(btrim(edited.name));
  if exists(select 1 from public.phonebook_companies c where c.id<>p_id and upper(btrim(c.name))=edited.name) then
    raise exception using errcode='23505',message='Another company already uses this name.';
  end if;
  if edited.name is distinct from company.name and exists(
    select 1 from public.phonebook_contacts p join public.phonebook_companies c on c.source_key=p.company_source_id
    where upper(btrim(p.company)) in (upper(btrim(company.name)),edited.name) and c.id<>p_id
  ) then raise exception using errcode='23514',message='Some contacts have conflicting company links.'; end if;
  prior_headers:=public.audit_json_setting('request.headers'); prior_context:=public.audit_json_setting('app.audit_context');
  prior_save:=current_setting('app.phonebook_company_save',true);
  perform set_config('app.phonebook_company_save',p_id::text,true);
  perform set_config('request.headers',(prior_headers||jsonb_build_object('x-bunker-audit-action','phonebook_company_save'))::text,true);
  perform set_config('app.audit_context',(prior_context||jsonb_build_object('action','phonebook_company_save','companyId',p_id))::text,true);
  update public.phonebook_companies set
    name=edited.name,other_name=edited.other_name,phone=edited.phone,address=edited.address,country=edited.country,
    tel_country=edited.tel_country,tel_area=edited.tel_area,tel_no_1=edited.tel_no_1,tel_no_2=edited.tel_no_2,
    tel_speed_dial=edited.tel_speed_dial,fax_no_1=edited.fax_no_1,website=edited.website,email=edited.email,
    contact_type=edited.contact_type,stem_management=edited.stem_management,company_status=edited.company_status,
    company_info=edited.company_info,seller_term=edited.seller_term,seller_credit_limit=edited.seller_credit_limit,
    seller_credit_limit_flexibility=edited.seller_credit_limit_flexibility,seller_classification=edited.seller_classification,
    seller_remark_1=edited.seller_remark_1,seller_remark_2=edited.seller_remark_2,seller_remark_3=edited.seller_remark_3,
    seller_remark_4=edited.seller_remark_4,buyer_term=edited.buyer_term,buyer_credit_limit=edited.buyer_credit_limit,
    buyer_credit_limit_flexibility=edited.buyer_credit_limit_flexibility,buyer_classification=edited.buyer_classification,
    buyer_remark_1=edited.buyer_remark_1,buyer_remark_2=edited.buyer_remark_2,buyer_remark_3=edited.buyer_remark_3,
    buyer_remark_4=edited.buyer_remark_4,notes=edited.notes where id=p_id returning * into saved;
  -- A valid source key also identifies older alias labels. Canonicalize those
  -- on a phone-only save so inherited details and durable queue work agree.
  update public.phonebook_contacts p set company=saved.name
  where (p.company_source_id=company.source_key and p.company is distinct from saved.name)
    or (saved.name is distinct from company.name and upper(btrim(p.company))=upper(btrim(company.name)));
  select coalesce(jsonb_agg(p.id order by p.id),'[]'::jsonb) into contact_ids from public.phonebook_contacts p
    where p.company_source_id=company.source_key or upper(btrim(p.company))=upper(btrim(saved.name));
  perform set_config('app.phonebook_company_save',coalesce(prior_save,''),true);
  perform set_config('request.headers',prior_headers::text,true); perform set_config('app.audit_context',prior_context::text,true);
  perform set_config('lock_timeout',prior_timeout,true);
  return jsonb_build_object('company',to_jsonb(saved),'contactIds',contact_ids);
end $$;
revoke all on function public.save_phonebook_company(uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.save_phonebook_company(uuid,timestamptz,jsonb) to service_role;
