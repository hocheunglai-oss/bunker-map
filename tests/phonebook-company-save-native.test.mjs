import assert from "node:assert/strict"
import test from "node:test"
import { setupNativeCcinfo,literal,waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"
import { phonebookSql,companyId,otherId,contactId,initialVersion } from "./fixtures/phonebook-company-save-sql.mjs"
const save = (name="RENAMED COMPANY",version=initialVersion) => `select public.save_phonebook_company('${companyId}','${version}',${literal(JSON.stringify({name}))}::jsonb);`
const state = db => db.owner.one(`select jsonb_build_object('companies',(select jsonb_agg(to_jsonb(c) order by id) from public.phonebook_companies c),'contacts',(select jsonb_agg(to_jsonb(c) order by id) from public.phonebook_contacts c),'queue',(select coalesce(jsonb_agg(to_jsonb(q) order by contact_id),'[]') from public.phonebook_carddav_queue q),'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_logs a));`)

test("native company save commits labels, original source references, inherited phone, audit and durable final-card work together",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    const before=await state(db)
    const writer=await db.session("rename-writer"); await writer.begin("SYNTHETIC EDITOR")
    const result=await writer.one(save())
    assert.equal(result.company.name,"RENAMED COMPANY")
    assert.equal(result.company.source_key,"stable-company-key")
    assert.deepEqual(result.contactIds,[contactId(1),contactId(2),contactId(3)])
    assert.deepEqual(await state(db),before,"other backends cannot see a partial rename before commit")
    await writer.query("commit;")
    const after=await state(db)
    for(let i=0;i<3;i++) {
      const previous=before.contacts[i],current=after.contacts[i]
      assert.equal(current.company,"RENAMED COMPANY")
      assert.equal(current.company_source_id,previous.company_source_id)
      for(const key of ["id","source_key","full_name","mobile_1","notes"]) assert.equal(current[key],previous[key])
      assert.ok(current.search_text.includes("renamed company"))
    }
    assert.deepEqual(after.contacts[3],before.contacts[3])
    assert.equal(after.companies[0].tel_no_1,"12345678")
    const inherited=await db.owner.one("select jsonb_agg(c.tel_no_1 order by p.id) from public.phonebook_contacts p join public.phonebook_companies c on upper(btrim(p.company))=upper(btrim(c.name)) where c.id='"+companyId+"';")
    assert.deepEqual(inherited,["12345678","12345678","12345678"])
    assert.deepEqual(after.queue.map(q=>q.contact_id),result.contactIds)
    assert.equal(after.audit.length,4)
    assert.ok(after.audit.every(a=>a.actor_id==="SYNTHETIC EDITOR"&&a.request_context.action==="phonebook_company_save"))
    const privileges=await db.owner.one("select jsonb_build_object('anon',has_function_privilege('anon','public.save_phonebook_company(uuid,timestamptz,jsonb)','execute'),'authenticated',has_function_privilege('authenticated','public.save_phonebook_company(uuid,timestamptz,jsonb)','execute'),'service',has_function_privilege('service_role','public.save_phonebook_company(uuid,timestamptz,jsonb)','execute')); ")
    assert.deepEqual(privileges,{anon:false,authenticated:false,service:true})
  } finally {await db.close()}
})

test("native rollback on a contact-write failure preserves company, contact, queue and audit snapshots",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    await db.owner.query(`create function private.fail_test_contact() returns trigger language plpgsql as $$ begin if new.id='${contactId(2)}' then raise exception using errcode='23514',message='synthetic contact failure'; end if; return new; end $$; create trigger fail_test_contact before update on public.phonebook_contacts for each row execute function private.fail_test_contact();`)
    const before=await state(db),writer=await db.session("rollback-writer"); await writer.begin()
    await assert.rejects(writer.one(save()),/synthetic contact failure/)
    assert.deepEqual(await state(db),before)
  }finally{await db.close()}
})

test("native phone-only edits include source-linked aliases in inherited details and durable queued cards",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    const writer=await db.session("phone-only");await writer.begin()
    const result=await writer.one(`select public.save_phonebook_company('${companyId}','${initialVersion}','{"name":"OLD COMPANY","tel_no_1":"99998888"}'::jsonb);`)
    await writer.query("commit;")
    const after=await state(db)
    assert.equal(after.contacts[2].company,"OLD COMPANY")
    assert.equal(after.contacts[2].company_source_id,"stable-company-key")
    assert.deepEqual(after.queue.map(q=>q.contact_id),result.contactIds)
    const phones=await db.owner.one(`select jsonb_agg(c.tel_no_1 order by p.id) from public.phonebook_contacts p join public.phonebook_companies c on upper(btrim(p.company))=upper(btrim(c.name)) where c.id='${companyId}';`)
    assert.deepEqual(phones,["99998888","99998888","99998888"])
  }finally{await db.close()}
})

test("native concurrent saves serialize and stale versions cannot overwrite a committed rename",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    const one=await db.session("first"),two=await db.session("second")
    await one.begin(); await one.one(save("FIRST NAME")); await two.begin()
    const pending=two.one(save("SECOND NAME")); pending.catch(()=>undefined)
    await waitForBlock(db.owner,two,one,"relation","phonebook_companies")
    await one.query("commit;")
    await assert.rejects(pending,/company changed or was removed/)
    const after=await state(db)
    assert.equal(after.companies[0].name,"FIRST NAME")
    assert.ok(after.contacts.slice(0,3).every(c=>c.company==="FIRST NAME"))
  }finally{await db.close()}
})

test("native stale contact inserts use stable company identity after waiting for rename",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    const renamer=await db.session("renamer"),creator=await db.session("creator")
    await renamer.begin(); await renamer.one(save()); await creator.begin()
    const pending=creator.query(`insert into public.phonebook_contacts(id,full_name,company,company_source_id,source_key) values('${contactId(5)}','NEW CONTACT','OLD COMPANY','stable-company-key','contact-5');`);pending.catch(()=>undefined)
    await waitForBlock(db.owner,creator,renamer,"relation","phonebook_contacts")
    await renamer.query("commit;"); await pending; await creator.query("commit;")
    const after=await state(db)
    assert.equal(after.contacts[4].company,"RENAMED COMPANY")
    assert.ok(after.queue.some(q=>q.contact_id===contactId(5)))
    const legacy=await db.session("stale-legacy");await legacy.begin()
    await assert.rejects(legacy.query(`insert into public.phonebook_contacts(id,full_name,company,company_source_id,source_key) values('${contactId(6)}','NEW LEGACY','OLD COMPANY','unknown-historic','contact-6');`),/selected company changed/)
  }finally{await db.close()}
})

test("native conflicting links and duplicate names reject atomically; legacy direct rename is fenced",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    for(const name of ["OTHER COMPANY"," other company "]) {
      const writer=await db.session("duplicate");await writer.begin()
      await assert.rejects(writer.one(save(name)),/Another company/)
    }
    const direct=await db.session("legacy-direct");await direct.begin()
    await assert.rejects(direct.query(`update public.phonebook_companies set name='BROKEN RENAME' where id='${companyId}';`),/Reopen Phonebook/)
    await db.owner.query(`alter table public.phonebook_contacts disable trigger canonicalize_phonebook_contact_company; update public.phonebook_contacts set company_source_id='other-company-key' where id='${contactId(2)}'; alter table public.phonebook_contacts enable trigger canonicalize_phonebook_contact_company;`)
    const before=await state(db),writer=await db.session("conflict");await writer.begin()
    await assert.rejects(writer.one(save()),/conflicting company links/)
    assert.deepEqual(await state(db),before)
    await db.owner.query(`alter table public.phonebook_contacts disable trigger canonicalize_phonebook_contact_company;
      update public.phonebook_contacts set company_source_id='legacy-original-id' where id='${contactId(2)}';
      update public.phonebook_contacts set company='RENAMED COMPANY' where id='${contactId(4)}';
      alter table public.phonebook_contacts enable trigger canonicalize_phonebook_contact_company;`)
    const targetBefore=await state(db),targetWriter=await db.session("conflicting-target-label");await targetWriter.begin()
    await assert.rejects(targetWriter.one(save()),/conflicting company links/)
    assert.deepEqual(await state(db),targetBefore,"target-name collision cannot silently attach another company's source-linked contact")
  }finally{await db.close()}
})

test("native actual pg_dump recovery and raw historical inserts preserve legacy source values with queue triggers intact",async()=>{
  const db=await setupNativeCcinfo(phonebookSql())
  try {
    await db.owner.query(`select set_config('request.headers','{}',false); insert into public.phonebook_contacts(id,full_name,company,company_source_id,source_key) values('${contactId(7)}','HISTORIC CONTACT','HISTORIC MISSING COMPANY','historic-source','contact-7');`)
    const before=await state(db)
    const recovery=await db.dumpAndRestore()
    const restored=await recovery.owner.one(`select jsonb_build_object('companies',(select jsonb_agg(to_jsonb(c) order by id) from public.phonebook_companies c),'contacts',(select jsonb_agg(to_jsonb(c) order by id) from public.phonebook_contacts c),'queue',(select coalesce(jsonb_agg(to_jsonb(q) order by contact_id),'[]') from public.phonebook_carddav_queue q),'audit',(select coalesce(jsonb_agg(to_jsonb(a) order by id),'[]') from public.audit_logs a));`)
    assert.deepEqual(restored,before)
    await recovery.service.begin("RESTORED EDITOR"); await recovery.service.one(save()); await recovery.service.query("commit;")
    const checks=await recovery.owner.one(`select jsonb_build_object('renamed',(select count(*) from public.phonebook_contacts where company='RENAMED COMPANY'),'historical',(select company_source_id from public.phonebook_contacts where id='${contactId(7)}'),'queued',(select count(*) from public.phonebook_carddav_queue));`)
    assert.equal(checks.renamed,3);assert.equal(checks.historical,"historic-source");assert.equal(checks.queued,4)
  }finally{await db.close()}
})
