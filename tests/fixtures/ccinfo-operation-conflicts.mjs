import { readFileSync } from "node:fs"
import { fixtureSql as countryFixture, countryId, managedPortId, initialVersion } from "./ccinfo-country-rename-sql.mjs"
import { setupNativeCcinfo, literal } from "./native-postgres-ccinfo.mjs"
export { countryId, managedPortId, initialVersion, literal }
export const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
export const migrationPath="supabase/migrations/20261022110144_nonretryable_ccinfo_operation_conflicts.sql"
export const companyId="88888888-8888-4888-8888-888888888888",companyFileId="99999999-9999-4999-8999-999999999999",rootId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",targetId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",fileId="cccccccc-cccc-4ccc-8ccc-cccccccccccc",missingId="dddddddd-dddd-4ddd-8ddd-dddddddddddd"
export const signatures=["public.rename_ccinfo_country(uuid,timestamptz,text)","public.delete_ccinfo_record(text,uuid,timestamptz,boolean)","private.relocate_ccinfo_folder(text,uuid,uuid,text,timestamptz,text,text,text)","public.delete_ccinfo_folder(text,uuid,uuid,text,timestamptz)","public.move_ccinfo_file(text,uuid,text,uuid,timestamptz,uuid)","public.prepare_ccinfo_file_target(text,uuid,uuid,text)","public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text)","public.move_ccinfo_folder(text,uuid,uuid,text,timestamptz,text)","public.register_ccinfo_file(text,uuid,uuid,text,text,text,text)"]
export async function setupOperationConflicts({repaired=process.env.CCINFO_CONFLICT_BASELINE!=="1"}={}){
 const f=await setupNativeCcinfo(`${countryFixture()}
 reset role;
 alter table public.cc_entry_folders add column entry_kind text not null default 'country',add column name text not null default 'UNCHANGED',add column updated_at timestamptz not null default now();
 alter table public.cc_entry_files add column entry_kind text not null default 'country',add column folder_path text not null default '',add column file_name text not null default 'unchanged.txt',add column original_path text,add column file_type text,add column drive_file_id text,add column drive_url text,add column deleted_at timestamptz,add column updated_at timestamptz not null default now();
 create unique index folder_path_unique on public.cc_entry_folders(entry_kind,entry_id,folder_path,name);
 create unique index file_path_unique on public.cc_entry_files(entry_kind,entry_id,original_path);
 create table public.cc_company_files(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.cc_companies(id) on delete cascade,file_name text not null,original_path text,drive_file_id text,drive_url text,deleted_at timestamptz,updated_at timestamptz not null default now());
 ${["cc_entry_folders","cc_entry_files","cc_company_files"].map(table=>`alter table public.${table} enable row level security;grant select,insert,update,delete on public.${table} to service_role;select public.audit_enable_table('public.${table}');create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${table} for each statement execute function private.record_bunker_map_backup_mutation();`).join("\n")}
 create function public.fixture_folder_version() returns trigger language plpgsql as $$begin new.updated_at:=greatest(clock_timestamp(),old.updated_at+interval '1 microsecond');return new;end$$;
 ${["cc_entry_folders","cc_entry_files","cc_company_files"].map(table=>`create trigger fixture_folder_version before update on public.${table} for each row execute function public.fixture_folder_version();`).join("\n")}
 insert into public.cc_companies(id,name,notes,updated_at)values('${companyId}','SYNTHETIC COMPANY','KEEP COMPANY CONTENT','${initialVersion}');
 insert into public.cc_company_files(id,company_id,file_name,original_path,drive_file_id,drive_url,updated_at)values('${companyFileId}','${companyId}','company.txt','company/SYNTHETIC COMPANY/A/company.txt','PRESERVED-COMPANY-DRIVE','https://synthetic.invalid/company','${initialVersion}');
 ${source("supabase/migrations/20261014100317_atomic_ccinfo_folder_rename.sql")}
 ${source("supabase/migrations/20261016072727_atomic_ccinfo_record_delete.sql")}
 insert into public.cc_entry_folders(id,entry_kind,entry_id,folder_path,name,updated_at)values('${rootId}','country','${countryId}','','A','${initialVersion}'),('${targetId}','country','${countryId}','','B','${initialVersion}');
 insert into public.cc_entry_files(id,entry_kind,entry_id,folder_path,file_name,original_path,drive_file_id,drive_url,updated_at)values('${fileId}','country','${countryId}','A','stable.txt','country/SYNTHETIC OLD/A/stable.txt','PRESERVED-ENTRY-DRIVE','https://synthetic.invalid/entry','${initialVersion}');
 create table public.ports(id integer primary key,hsfo numeric,updated_at date);insert into public.ports values(1,600,'2026-10-08');
 create table public.price_history(id integer primary key,recorded_at date,hsfo numeric);insert into public.price_history values(1,'2026-10-08',600);
 `)
 try{
  const oids=signatures.map(s=>`${literal(s)}::regprocedure::oid`).join(",")
  f.identities=()=>f.owner.one(`select jsonb_agg(jsonb_build_object('oid',oid,'signature',oid::regprocedure::text,'owner',pg_get_userbyid(proowner),'invoker',not prosecdef,'config',proconfig,'volatility',provolatile,'parallel',proparallel,'acl',proacl::text,'anon',has_function_privilege('anon',oid,'execute'),'authenticated',has_function_privilege('authenticated',oid,'execute'),'service',has_function_privilege('service_role',oid,'execute'))order by oid)from pg_proc where oid=any(array[${oids}]);`)
  f.bodies=()=>f.owner.one(`select jsonb_object_agg(oid::regprocedure::text,prosrc)from pg_proc where oid=any(array[${oids}]);`)
  f.beforeIdentities=await f.identities();f.beforeBodies=await f.bodies()
  if(repaired)await f.owner.query(`begin;${source(migrationPath)}commit;`)
  f.snapshot=()=>f.owner.one(`select jsonb_build_object(${["cc_countries","cc_ports","cc_companies","cc_company_files","cc_entry_files","cc_entry_folders","audit_logs","ports","price_history"].map(table=>`'${table}',(select coalesce(jsonb_agg(to_jsonb(t)order by id),'[]')from public.${table} t)`).join(",")},'epochs',(select coalesce(jsonb_agg(to_jsonb(t)order by mutation_id),'[]')from private.bunker_map_backup_mutations t));`)
  f.execute=async sql=>{const s=await f.session("ccinfo-operation-conflict");try{await s.begin("SYNTHETIC EDITOR");const value=await s.one(sql);await s.query("commit;");return value}finally{await s.close()}}
  return f
 }catch(e){await f.close();throw e}
}
export const renameSql=(id=countryId,version=initialVersion)=>`select public.rename_ccinfo_country('${id}','${version}','RENAMED COUNTRY');`
export const deletionSql=(kind="country",id=countryId,bulk=true,version=initialVersion)=>`select public.delete_ccinfo_record('${kind}','${id}','${version}',${bulk});`
export const folderSql=(mode="rename",{entry=countryId,folder=rootId,path="A",version=initialVersion,parent="",name="RENAMED"}={})=>`select public.${mode==="rename"?"rename_ccinfo_folder":"move_ccinfo_folder"}('country','${entry}',${folder?literal(folder):"null"},${literal(path)},${version?literal(version):"null"},${literal(mode==="rename"?name:parent)});`
export const folderDeleteSql=({entry=countryId,folder=rootId,path="A",version=initialVersion}={})=>`select public.delete_ccinfo_folder('country','${entry}',${folder?literal(folder):"null"},${literal(path)},${version?literal(version):"null"});`
export const prepareSql=({entry=countryId,folder=targetId,path="B"}={})=>`select public.prepare_ccinfo_file_target('country','${entry}',${folder?literal(folder):"null"},${literal(path)});`
export const moveSql=(source="entry",version="2099-10-12T00:00:00.123455Z")=>`select public.move_ccinfo_file('${source==="company"?"company":"country"}','${source==="company"?companyId:countryId}','${source}','${source==="company"?companyFileId:fileId}','${version}',${source==="company"?"null":literal(targetId)});`
