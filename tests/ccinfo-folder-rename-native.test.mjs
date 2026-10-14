import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fixtureSql, countryId } from "./fixtures/ccinfo-country-rename-sql.mjs"
import { setupNativeCcinfo, literal, waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"

const migration = readFileSync(new URL("../supabase/migrations/20261014100317_atomic_ccinfo_folder_rename.sql", import.meta.url), "utf8")
const rootId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const version = "2026-10-14T01:00:00.123456Z"
const fullFixture = `${fixtureSql()}
reset role;
alter table public.cc_entry_folders add column entry_kind text not null default 'country', add column name text not null default 'UNCHANGED', add column updated_at timestamptz not null default now();
alter table public.cc_entry_files add column entry_kind text not null default 'country', add column folder_path text not null default '', add column file_name text not null default 'unchanged.txt', add column original_path text, add column file_type text, add column drive_file_id text, add column drive_url text, add column deleted_at timestamptz, add column updated_at timestamptz not null default now();
create unique index folder_path_unique on public.cc_entry_folders(entry_kind,entry_id,folder_path,name);
create unique index file_path_unique on public.cc_entry_files(entry_kind,entry_id,original_path);
create table public.cc_company_files(id uuid primary key default gen_random_uuid(),company_id uuid not null references public.cc_companies(id) on delete cascade,file_name text not null,original_path text,deleted_at timestamptz,updated_at timestamptz not null default now());
create unique index company_file_path_unique on public.cc_company_files(company_id,original_path);
${["cc_entry_folders", "cc_entry_files", "cc_company_files"].map(table => `
alter table public.${table} enable row level security;
grant select,insert,update,delete on public.${table} to service_role;
select public.audit_enable_table('public.${table}');
create trigger bunker_map_backup_epoch_fence after insert or update or delete or truncate on public.${table} for each statement execute function private.record_bunker_map_backup_mutation();
`).join("\n")}
create function public.fixture_folder_version() returns trigger language plpgsql as $$ begin new.updated_at := clock_timestamp(); return new; end $$;
create trigger fixture_folder_version before update on public.cc_entry_folders for each row execute function public.fixture_folder_version();
create trigger fixture_file_version before update on public.cc_entry_files for each row execute function public.fixture_folder_version();
create trigger fixture_company_file_version before update on public.cc_company_files for each row execute function public.fixture_folder_version();
insert into public.cc_companies(id,name) values('${companyId}','SYNTHETIC COMPANY');
${migration}
set role service_role;
`

const rpc = (kind = "country", entry = countryId, path = "A", name = "RENAMED", folder = rootId, expected = version) =>
  `select public.rename_ccinfo_folder(${literal(kind)},${literal(entry)},${folder ? literal(folder) : "null"},${literal(path)},${expected ? literal(expected) : "null"},${literal(name)});`
const state = f => f.owner.one(`select jsonb_build_object(
  'folders',(select jsonb_agg(to_jsonb(t) order by id) from public.cc_entry_folders t),
  'files',(select jsonb_agg(to_jsonb(t) order by id) from public.cc_entry_files t),
  'companyFiles',(select jsonb_agg(to_jsonb(t) order by id) from public.cc_company_files t),
  'audit',(select jsonb_agg(to_jsonb(t) order by id) from public.audit_logs t),
  'epochs',(select jsonb_agg(to_jsonb(t) order by mutation_id) from private.bunker_map_backup_mutations t));`)
async function seed(f, name = "A", kind = "country", entry = countryId) {
  await f.owner.query(`insert into public.cc_entry_folders(id,entry_kind,entry_id,folder_path,name,updated_at) values
    ('${rootId}',${literal(kind)},'${entry}','',${literal(name)},'${version}'),
    (gen_random_uuid(),${literal(kind)},'${entry}',${literal(name)},'EMPTY CHILD','${version}'),
    (gen_random_uuid(),${literal(kind)},'${entry}',${literal(`${name}/EMPTY CHILD`)},'DEEP EMPTY','${version}'),
    (gen_random_uuid(),${literal(kind)},'${entry}','',${literal(`${name} EXTRA`)},'${version}');
    insert into public.cc_entry_files(entry_kind,entry_id,folder_path,file_name,original_path,deleted_at) values
    (${literal(kind)},'${entry}',${literal(name)},'root.txt',${literal(`${kind}/SYNTHETIC/${name}/root.txt`)},null),
    (${literal(kind)},'${entry}',${literal(`${name}/EMPTY CHILD/DEEP EMPTY`)},'deep.txt',${literal(`${kind}/SYNTHETIC/${name}/EMPTY CHILD/DEEP EMPTY/deep.txt`)},now()),
    (${literal(kind)},'${entry}',${literal(`${name} EXTRA`)},'unrelated.txt',${literal(`${kind}/SYNTHETIC/${name} EXTRA/unrelated.txt`)},null);`)
}

test("native folder rename is literal, complete, collision-safe and atomic", { timeout: 120000 }, async t => {
  const f = await setupNativeCcinfo(fullFixture)
  try {
    await t.test("empty direct/deep children and active/deleted files move together; readers see only a committed tree", async () => {
      await seed(f)
      const before = await state(f), writer = await f.session("folder-rename")
      await writer.begin()
      const ack = await writer.one(rpc())
      assert.equal(ack.folderPath, "RENAMED")
      assert.deepEqual(await state(f), before)
      assert.deepEqual(ack.folders.map(row => [row.folder_path,row.name]).sort(), [["","RENAMED"],["RENAMED","EMPTY CHILD"],["RENAMED/EMPTY CHILD","DEEP EMPTY"]].sort())
      assert.deepEqual(ack.entryFiles.map(row => row.folder_path).sort(), ["RENAMED","RENAMED/EMPTY CHILD/DEEP EMPTY"].sort())
      await writer.query("commit;")
      const after = await state(f)
      for (const row of before.folders.filter(row => row.id !== rootId && !row.folder_path.startsWith("A"))) assert.deepEqual(after.folders.find(item => item.id === row.id), row)
      assert.deepEqual(after.files.find(row => row.file_name === "unrelated.txt"), before.files.find(row => row.file_name === "unrelated.txt"))
      const logs = after.audit.filter(row => !before.audit.some(prior => prior.id === row.id))
      assert.equal(logs.length, 5)
      assert.ok(logs.every(row => row.request_context.action === "ccinfo_folder_rename"))
      const undo = await f.session("reject-single-row-folder-undo")
      await undo.begin()
      const fileLog = logs.find(row => row.table_name === "cc_entry_files")
      await undo.query(`select set_config('app.audit_undo_of_log_id','${fileLog.id}',true);`)
      await assert.rejects(undo.query(`update public.cc_entry_files set folder_path='UNSAFE SINGLE ROW' where id='${after.files.find(row => row.file_name === "root.txt").id}';`), error => error.code === "23514")
      assert.deepEqual(await state(f), after)
    })
    await t.test("stale folder identity/version and destination collisions save no rows or audit/backup mutations", async () => {
      for (const query of [rpc(), rpc("country", countryId, "WRONG", "NEW", rootId, (await state(f)).folders.find(row => row.id === rootId).updated_at), rpc("country", countryId, "RENAMED", "A EXTRA", rootId, (await state(f)).folders.find(row => row.id === rootId).updated_at)]) {
        const before = await state(f), writer = await f.session("reject-stale-or-collision")
        await writer.begin()
        await assert.rejects(writer.one(query), error => ["40001", "23505"].includes(error.code))
        assert.deepEqual(await state(f), before)
      }
      const before = await state(f), virtual = await f.session("reject-forged-virtual-folder")
      await virtual.begin()
      await assert.rejects(virtual.one(rpc("country",countryId,"RENAMED","NEW",null,null)),error=>error.code==="40001")
      assert.deepEqual(await state(f),before)
    })
    await t.test("SQL wildcards, commas, parentheses, apostrophes and quotes remain literal names", async () => {
      const writer = await f.session("literal-folder")
      await f.owner.query(`update public.cc_entry_folders set id=gen_random_uuid() where id='${rootId}';`)
      await seed(f, `A%,_(*"'`)
      await writer.begin()
      const ack = await writer.one(rpc("country", countryId, `A%,_(*"'`, `NEW%,_(*"'`))
      await writer.query("commit;")
      assert.equal(ack.folders.length,3)
      assert.equal(ack.entryFiles.length,2)
      assert.ok(ack.entryFiles.every(row => row.folder_path.startsWith(`NEW%,_(*"'`)))
    })
    await t.test("mixed imported/manual company files and empty folders roll back on a failure after earlier updates", async () => {
      await f.owner.query(`update public.cc_entry_folders set id=gen_random_uuid() where id='${rootId}';`)
      await seed(f, "A", "company", companyId)
      await f.owner.query(`insert into public.cc_company_files(company_id,file_name,original_path) values('${companyId}','imported.txt','Archive/- Company Information/SYNTHETIC COMPANY/A/IMPORTED/imported.txt');
        create function public.fail_late_folder_rename() returns trigger language plpgsql as $$ begin raise exception 'Injected final write failure'; end $$;
        create trigger fail_late_folder_rename before update on public.cc_company_files for each row execute function public.fail_late_folder_rename();`)
      const before = await state(f), writer = await f.session("late-folder-failure")
      await writer.begin()
      await assert.rejects(writer.one(rpc("company",companyId)), /Injected final write failure/)
      assert.deepEqual(await state(f), before)
      await f.owner.query("drop trigger fail_late_folder_rename on public.cc_company_files;")
      const success = await f.session("mixed-company-folder")
      await success.begin()
      const ack = await success.one(rpc("company",companyId))
      await success.query("commit;")
      assert.equal(ack.companyFiles[0].folder_path,"RENAMED/IMPORTED")
      assert.equal(ack.companyFiles[0].original_path,"Archive/- Company Information/SYNTHETIC COMPANY/RENAMED/IMPORTED/imported.txt")
      assert.equal(ack.entryFiles.length,2)
      assert.equal(ack.folders.length,3)
    })
    await t.test("only service role can invoke the RPC; virtual file folders share the atomic path", async () => {
      const perms = await f.owner.one("select jsonb_build_object('anon',has_function_privilege('anon','public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text)','execute'),'authenticated',has_function_privilege('authenticated','public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text)','execute'),'service',has_function_privilege('service_role','public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text)','execute'),'definer',(select prosecdef from pg_proc where oid='public.rename_ccinfo_folder(text,uuid,uuid,text,timestamptz,text)'::regprocedure));")
      assert.deepEqual(perms,{anon:false,authenticated:false,service:true,definer:false})
      const writer=await f.session("virtual-folder")
      await writer.begin()
      const ack=await writer.one(rpc("company",companyId,"RENAMED/IMPORTED","VIRTUAL RENAMED",null,null))
      await writer.query("commit;")
      assert.equal(ack.companyFiles[0].folder_path,"RENAMED/VIRTUAL RENAMED")
    })
    await t.test("a held upload and a late file move follow a stable destination through an atomic folder move", async () => {
      const before=await state(f)
      const target=before.folders.find(row=>row.entry_kind==="country"&&row.name==="RENAMED"&&row.folder_path==="")
      const sourceFile=before.files.find(row=>row.entry_kind==="country"&&row.folder_path==="A EXTRA"&&row.file_name==="unrelated.txt")
      const upload=await f.session("held-upload"), mover=await f.session("move-destination"), observer=await f.session("move-observer")
      await upload.begin()
      const prepared=await upload.one(`select public.prepare_ccinfo_file_target('country','${countryId}','${target.id}','RENAMED');`)
      await upload.query("commit;")
      assert.equal(prepared.folderId,target.id)
      await mover.begin()
      const moved=await mover.one(`select public.move_ccinfo_folder('country','${countryId}','${target.id}','RENAMED','${target.updated_at}','A EXTRA');`)
      assert.equal(moved.folderPath,"A EXTRA/RENAMED")
      assert.deepEqual(await state(f),before)
      await upload.begin()
      const registering=upload.one(`select public.register_ccinfo_file('country','${countryId}','${prepared.folderId}','late-upload.txt','TXT','SYNTHETIC-LATE-DRIVE','https://synthetic.invalid/late');`).then(value=>({value}),error=>({error}))
      await waitForBlock(observer,upload,mover,"relation","cc_entry_folders")
      await mover.query("commit;")
      const registered=await registering
      assert.equal(registered.error,undefined)
      assert.equal(registered.value.folder_path,"A EXTRA/RENAMED")
      await upload.query("commit;")
      const fileMove=await f.session("late-file-move")
      await fileMove.begin()
      const file=await fileMove.one(`select public.move_ccinfo_file('country','${countryId}','entry','${sourceFile.id}','${sourceFile.updated_at}','${prepared.folderId}');`)
      await fileMove.query("commit;")
      assert.equal(file.folder_path,"A EXTRA/RENAMED")
      const after=await state(f)
      assert.equal(after.files.filter(row=>row.entry_kind==="country"&&row.entry_id===countryId&&row.folder_path==="RENAMED").length,0)
      const stale=await f.session("reject-stale-path")
      await stale.begin()
      await assert.rejects(stale.one(`select public.prepare_ccinfo_file_target('country','${countryId}',null,'RENAMED');`),error=>error.code==="40001")
      assert.deepEqual(await state(f),after)
    })
    await t.test("mixed virtual folder deletion rolls back both sources on late failure and handles punctuation literally", async () => {
      const path=`VIRTUAL%,_(*"'`
      await f.owner.query(`insert into public.cc_entry_files(entry_kind,entry_id,folder_path,file_name,original_path) values
        ('company','${companyId}',${literal(path)},'manual-delete.txt',${literal(`company/SYNTHETIC/${path}/manual-delete.txt`)});
        insert into public.cc_company_files(company_id,file_name,original_path) values
        ('${companyId}','imported-delete.txt',${literal(`company/SYNTHETIC/${path}/imported-delete.txt`)}),
        ('${companyId}','untouched-delete.txt',${literal(`company/SYNTHETIC/${path} EXTRA/untouched-delete.txt`)});
        create trigger fail_late_folder_rename before update on public.cc_company_files for each row execute function public.fail_late_folder_rename();`)
      const before=await state(f), failed=await f.session("late-delete-failure")
      const query=`select public.delete_ccinfo_folder('company','${companyId}',null,${literal(path)},null);`
      await failed.begin()
      await assert.rejects(failed.one(query),/Injected final write failure/)
      assert.deepEqual(await state(f),before)
      await f.owner.query("drop trigger fail_late_folder_rename on public.cc_company_files;")
      const success=await f.session("mixed-virtual-delete")
      await success.begin()
      const deleted=await success.one(query)
      await success.query("commit;")
      assert.equal(deleted.entryFileIds.length,1)
      assert.equal(deleted.companyFileIds.length,1)
      const after=await state(f)
      assert.ok(after.files.find(row=>row.id===deleted.entryFileIds[0]).deleted_at)
      assert.ok(after.companyFiles.find(row=>row.id===deleted.companyFileIds[0]).deleted_at)
      assert.deepEqual(after.companyFiles.find(row=>row.file_name==="untouched-delete.txt"),before.companyFiles.find(row=>row.file_name==="untouched-delete.txt"))
    })
    await t.test("a deleted stable destination cannot strand a late upload in a stale path", async () => {
      const id="cccccccc-cccc-4ccc-8ccc-cccccccccccc"
      await f.owner.query(`insert into public.cc_entry_folders(id,entry_kind,entry_id,folder_path,name,updated_at) values('${id}','country','${countryId}','','DELETE TARGET','${version}');`)
      const deletion=await f.session("delete-upload-target")
      await deletion.begin()
      await deletion.one(`select public.delete_ccinfo_folder('country','${countryId}','${id}','DELETE TARGET','${version}');`)
      await deletion.query("commit;")
      const before=await state(f),late=await f.session("upload-target-gone")
      await late.begin()
      await assert.rejects(late.one(`select public.register_ccinfo_file('country','${countryId}','${id}','late-missing.txt','TXT','PRESERVED-DRIVE-ID','https://synthetic.invalid/preserved');`),error=>error.code==="40001")
      assert.deepEqual(await state(f),before)
    })
    await t.test("legacy implied and generated implicit folders never delete explicit children", async () => {
      await f.owner.query(`insert into public.cc_entry_files(entry_kind,entry_id,folder_path,file_name,original_path) values('company','${companyId}','LEGACY/SUB','legacy.txt','company/SYNTHETIC/LEGACY/SUB/legacy.txt');
        insert into public.cc_entry_folders(entry_kind,entry_id,folder_path,name) values('company','${companyId}','LEGACY','EXPLICIT CHILD');`)
      const before=await state(f),legacy=await f.session("protect-legacy-child")
      await legacy.begin()
      await assert.rejects(legacy.one(`select public.delete_ccinfo_folder('company','${companyId}',null,'LEGACY',null);`),error=>error.code==="23514")
      assert.deepEqual(await state(f),before)
      const prepare=await f.session("prepare-implicit-identities")
      await prepare.begin()
      const parent=await prepare.one(`select public.prepare_ccinfo_file_target('company','${companyId}',null,'LEGACY');`)
      await prepare.one(`select public.prepare_ccinfo_file_target('company','${companyId}',null,'LEGACY/SUB');`)
      await prepare.query("commit;")
      const prepared=await state(f),row=prepared.folders.find(item=>item.id===parent.folderId)
      assert.equal(row.implicit,true)
      const guarded=await f.session("protect-implicit-child")
      await guarded.begin()
      await assert.rejects(guarded.one(`select public.delete_ccinfo_folder('company','${companyId}','${row.id}','LEGACY','${row.updated_at}');`),error=>error.code==="23514")
      assert.deepEqual(await state(f),prepared)
      await f.owner.query(`delete from public.cc_entry_folders where entry_id='${companyId}' and folder_path='LEGACY' and name='EXPLICIT CHILD';`)
      const deletion=await f.session("delete-generated-identities")
      await deletion.begin()
      const deleted=await deletion.one(`select public.delete_ccinfo_folder('company','${companyId}','${row.id}','LEGACY','${row.updated_at}');`)
      await deletion.query("commit;")
      assert.equal(deleted.folderIds.length,2)
      assert.equal(deleted.entryFileIds.length,1)
    })
    await t.test("native dump/restore preserves the additive implicit marker, stable destination and service-only operations", async () => {
      const current=await state(f),root=current.folders.find(row=>row.entry_kind==="country"&&row.name==="RENAMED"&&row.folder_path==="A EXTRA")
      await f.owner.query(`insert into public.cc_entry_files(entry_kind,entry_id,folder_path,file_name,original_path) values('country','${countryId}','RECOVERY/IMPLIED','recovery-source.txt','country/SYNTHETIC/RECOVERY/IMPLIED/recovery-source.txt');`)
      const prepared=await f.session("prepare-recovery-identity")
      await prepared.begin()
      const implicit=await prepared.one(`select public.prepare_ccinfo_file_target('country','${countryId}',null,'RECOVERY/IMPLIED');`)
      await prepared.query("commit;")
      const restored=await f.dumpAndRestore()
      const marker=await restored.owner.one(`select jsonb_build_object('implicit',implicit,'folder_path',folder_path,'name',name) from public.cc_entry_folders where id='${implicit.folderId}';`)
      assert.deepEqual(marker,{implicit:true,folder_path:"RECOVERY",name:"IMPLIED"})
      await restored.service.begin()
      const target=await restored.service.one(`select public.prepare_ccinfo_file_target('country','${countryId}','${root.id}','STALE PATH');`)
      assert.equal(target.folderPath,"A EXTRA/RENAMED")
      const registered=await restored.service.one(`select public.register_ccinfo_file('country','${countryId}','${implicit.folderId}','restored-upload.txt','TXT','RESTORED-SYNTHETIC-DRIVE','https://synthetic.invalid/restored');`)
      assert.equal(registered.folder_path,"RECOVERY/IMPLIED")
      await restored.service.query("commit;")
      assert.ok(restored.sha256)
    })
    await t.test("implied source and destination parents backed only by empty explicit descendants can relocate",async()=>{
      await Promise.all(f.sessions.filter(session=>session!==f.owner).map(session=>session.close()))
      await f.owner.query(`insert into public.cc_entry_folders(entry_kind,entry_id,folder_path,name) values
        ('country','${countryId}','EMPTY VIRTUAL','SOURCE CHILD'),
        ('country','${countryId}','EMPTY PARENT','DESTINATION CHILD');`)
      const writer=await f.session("empty-implied-parent")
      await writer.begin()
      const renamed=await writer.one(rpc("country",countryId,"EMPTY VIRTUAL","RENAMED EMPTY",null,null))
      assert.equal(renamed.folders.length,1)
      assert.equal(renamed.entryFiles.length,0)
      assert.equal(renamed.folders[0].folder_path,"RENAMED EMPTY")
      const moved=await writer.one(`select public.move_ccinfo_folder('country','${countryId}',null,'RENAMED EMPTY',null,'EMPTY PARENT');`)
      assert.equal(moved.folders[0].folder_path,"EMPTY PARENT/RENAMED EMPTY")
      await writer.query("commit;")
      assert.ok((await state(f)).folders.some(row=>row.folder_path==="EMPTY PARENT"&&row.name==="DESTINATION CHILD"))
    })
  } finally { await f.close() }
})
