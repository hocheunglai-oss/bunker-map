import assert from "node:assert/strict"
import test from "node:test"
import { randomUUID } from "node:crypto"
import { setupSourcePolicy, ref, json, literal, reserve, certification } from "./fixtures/outlook-template-source-policy.mjs"
import { waitForBlock } from "./fixtures/native-postgres-ccinfo.mjs"

const withFixture = async (callback, options) => { const f = await setupSourcePolicy(options); try { await callback(f) } finally { await f.close() } }
const contact = (id, name = id) => ({ id, name, email: `${id}@example.invalid` })
const fields = row => ({ to: row.to_recipients, cc: row.cc_recipients, bcc: row.bcc_recipients, refs: row.recipient_resolution.refs })

test("RED old source DELETE leaves a bound template recipient behind", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], templates: [{ refs: { to: [ref('one')] } }] })
  await f.owner.query("delete from public.shared_addressbook_contacts where id='one';")
  assert.equal((await f.template()).to_recipients, "one <one@example.invalid>")
}, { repaired: false }))

test("contact DELETE removes only exact bound identities in all fields; preserves order, external and dynamic tokens", async () => withFixture(async f => {
  const a = ref('one', { name: 'SAME NAME', literal: '"SAME, NAME" <one@example.invalid>' })
  const b = ref('two', { name: 'SAME NAME', position: 1 })
  const external = ref(null, { kind: 'external', position: 2, name: 'SAME NAME', address: 'external@example.invalid', literal: '"A; B" <external@example.invalid>', status: 'external' })
  const dynamic = ref(null, { kind: 'unresolved', field: 'cc', position: 1, name: '', address: '0BT', literal: '<0BT>', status: 'missing' })
  await f.seed({ contacts: [contact('one'), contact('two')], templates: [{
    refs: { to: [a, b, external], cc: [{ ...a, field: 'cc' }, dynamic], bcc: [{ ...a, field: 'bcc' }, { ...a, field: 'bcc', position: 1 }] },
  }] })
  const before = await f.template()
  await f.owner.query("delete from public.shared_addressbook_contacts where id='one';")
  const after = await f.template()
  assert.equal(after.to_recipients, `${b.literal}; ${external.literal}`)
  assert.equal(after.cc_recipients, '<0BT>')
  assert.equal(after.bcc_recipients, '')
  assert.deepEqual(after.recipient_resolution.refs.to.map(r => [r.sourceId, r.position]), [['two', 0], [null, 1]])
  assert.deepEqual(after.recipient_resolution.counts, { total: 3, resolved: 1, external: 1, missing: 1, ambiguous: 0 })
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.body_html, before.body_html); assert.equal(after.subject, before.subject)
  const state = await f.state()
  const templateAudits = state.audit.filter(a => a.table_name === 'email_templates' && a.operation === 'UPDATE')
  assert.equal(templateAudits.length, 1)
  assert.equal(templateAudits[0].actor_id, 'synthetic-owner')
  const deletion = state.audit.find(a => a.table_name === 'shared_addressbook_contacts' && a.operation === 'DELETE')
  assert.equal(templateAudits[0].request_context.correlationId, deletion.request_context.correlationId)
  assert.ok(state.queue.some(q => q.entity_id === 'one' && q.action === 'delete_contact'))
  assert.ok(state.ledger.some(e => e.audit_log_id === deletion.id && e.event_type === 'source_change'))
}))

test("source name/email UPDATE keeps ID and safely updates token, but cannot revive old certified address; unaffected insertion works", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one'), contact('two')], templates: [
    { refs: { to: [ref('one')] } }, { id: 'unaffected', refs: { to: [ref('two')] } },
  ] })
  const before = await f.template()
  await f.owner.query("update public.shared_addressbook_contacts set display_name='Updated, Name',primary_email='new@example.invalid' where id='one';")
  const after = await f.template()
  assert.equal(after.to_recipients, '"Updated, Name" <new@example.invalid>')
  assert.deepEqual(after.recipient_resolution.refs.to[0], { ...before.recipient_resolution.refs.to[0], literal: after.to_recipients, displayName: 'Updated, Name', sourceValue: 'new@example.invalid', status: 'missing', resolvedAddress: null })
  assert.equal(after.revision, before.revision + 1)
  const global = await f.owner.one("select public.verify_outlook_template_recipient_truth();")
  assert.equal(global.valid, true); assert.equal(global.allTemplatesSendable, false)
  const service = await f.session('unaffected-insert')
  assert.equal((await service.one(reserve(randomUUID(), 'unaffected', 1))).reserved, true)
  const blocked = await f.session('blocked-insert')
  await assert.rejects(blocked.query(reserve(randomUUID(), 'synthetic-template', after.revision)), /OUTLOOK_INSERTION_TEMPLATE_CHANGED/)
  const staleSave = await f.session('stale-map-save')
  const revived = { ...after.recipient_resolution, refs: { ...after.recipient_resolution.refs, to: [{ ...after.recipient_resolution.refs.to[0], status: 'resolved', resolvedAddress: 'one@example.invalid' }] }, counts: { total: 1, resolved: 1, external: 0, missing: 0, ambiguous: 0 } }
  await assert.rejects(staleSave.query(`update public.email_templates set recipient_resolution=${json(revived)} where id='synthetic-template';`), /OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING/)
  assert.deepEqual(await f.template(), after)
  const nextRun = '22222222-2222-4222-8222-222222222222'
  await f.certify(nextRun)
  const certified = { ...revived, certificationRunId: nextRun, certifiedAt: f.verified.latestCertificationAt, refs: { ...revived.refs, to: [{ ...revived.refs.to[0], resolvedAddress: 'new@example.invalid' }] } }
  // All templates receive the same new certified envelope, as the real batch does.
  await f.owner.query(`update public.email_templates set recipient_resolution=case when id='synthetic-template' then ${json(certified)} else recipient_resolution || ${json({ certificationRunId: nextRun, certifiedAt: f.verified.latestCertificationAt })} end;`)
  const ready = await f.template()
  assert.equal((await service.one(reserve(randomUUID(), 'synthetic-template', ready.revision, nextRun))).reserved, true)
}))

test("metadata-only updates do not dirty a template; source identity changes roll back", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], groups: [{ id: 'team' }], templates: [{ refs: { to: [ref('one')], cc: [ref('team', { kind: 'group', field: 'cc' })] } }] })
  const before = await f.template()
  await f.owner.query("update public.shared_addressbook_contacts set nickname='Metadata',properties='{}',updated_at=clock_timestamp() where id='one'; update public.shared_addressbook_groups set description='Metadata',member_count=0 where id='team';")
  assert.deepEqual(await f.template(), before)
  const state = await f.state(), writer = await f.session('id-mutation')
  await assert.rejects(writer.query("update public.shared_addressbook_contacts set id='different' where id='one';"), /OUTLOOK_SOURCE_ID_IMMUTABLE/)
  assert.deepEqual(await f.state(), state)
}))

test("member contact UPDATE blocks its group binding without removing it; one source effect updates each template once", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one'), contact('two')], groups: [{ id: 'team' }], members: [{ group: 'team', contact: 'one' }], templates: [
    { refs: { to: [ref('one')], cc: [ref('team', { kind: 'group', field: 'cc' })] } },
    { id: 'unaffected', refs: { to: [ref('two')] } },
  ] })
  const before = await f.template()
  await f.owner.query("update public.shared_addressbook_contacts set primary_email='changed@example.invalid' where id='one';")
  const after = await f.template()
  assert.equal(after.revision, before.revision + 1)
  assert.equal(after.recipient_resolution.refs.cc[0].sourceId, 'team')
  assert.equal(after.recipient_resolution.refs.cc[0].status, 'missing')
  assert.equal(after.cc_recipients, before.cc_recipients)
  const state = await f.state()
  assert.equal(state.audit.filter(a => a.table_name === 'email_templates' && a.operation === 'UPDATE').length, 1)
  assert.equal((await (await f.session('unaffected-after-member-update')).one(reserve(randomUUID(), 'unaffected', 1))).reserved, true)
  const blocked = await f.session('member-update-insert')
  await assert.rejects(blocked.query(reserve(randomUUID(), 'synthetic-template', after.revision)), /OUTLOOK_INSERTION_TEMPLATE_CHANGED/)
}))

test("deleting last group member or its contact preserves group binding and blocks stale membership; group DELETE alone removes it", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one'), contact('two')], groups: [{ id: 'team', name: 'Team' }], members: [{ group: 'team', contact: 'one' }], templates: [
    { refs: { to: [ref('team', { kind: 'group', name: 'Team' })], cc: [ref('one', { field: 'cc' })] } },
    { id: 'unaffected', refs: { to: [ref('two')] } },
  ] })
  await f.owner.query("delete from public.shared_addressbook_contacts where id='one';")
  const after = await f.template()
  assert.equal(after.recipient_resolution.refs.to[0].sourceId, 'team')
  assert.equal(after.recipient_resolution.refs.to[0].status, 'missing')
  assert.equal(after.to_recipients, 'Team <team@example.invalid>')
  assert.equal(after.cc_recipients, '')
  assert.equal((await f.owner.one("select to_jsonb(g) from public.shared_addressbook_groups g where id='team';")).member_count, 0)
  const blocked = await f.session('membership-insert')
  await assert.rejects(blocked.query(reserve(randomUUID(), 'synthetic-template', after.revision)), /OUTLOOK_INSERTION_TEMPLATE_CHANGED/)
  assert.equal((await (await f.session('unaffected-after-member-delete')).one(reserve(randomUUID(), 'unaffected', 1))).reserved, true)
  await f.owner.query("delete from public.shared_addressbook_groups where id='team';")
  assert.equal((await f.template()).to_recipients, '')
}))

test("unavailable certificate rolls source, outbox, audit and templates back together", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], templates: [{ refs: { to: [ref('one')] } }] })
  await f.owner.query("update private.synthetic_exchange_truth set value=jsonb_set(value,'{valid}','false');")
  const before = await f.state(), writer = await f.session('unavailable-edit')
  await assert.rejects(writer.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';"), /OUTLOOK_TEMPLATE_TRUTH_UNAVAILABLE/)
  assert.deepEqual(await f.state(), before)
}))

test("expired certificate also rolls a source DELETE back without partial removal", async () => withFixture(async f => {
  await f.seed({ contacts:[contact('one')], templates:[{refs:{to:[ref('one')]}}] })
  await f.owner.query("update private.synthetic_exchange_truth set value=jsonb_set(value,'{latestCertificationAt}',to_jsonb('2000-01-01T00:00:00Z'::text));")
  const before=await f.state(), writer=await f.session('expired-delete')
  await assert.rejects(writer.query("delete from public.shared_addressbook_contacts where id='one';"),/OUTLOOK_TEMPLATE_TRUTH_UNAVAILABLE/)
  assert.deepEqual(await f.state(),before)
}))

test("new full certification before its derived batch rejects a stale envelope once with P0001 and rolls source changes back",async()=>withFixture(async f=>{
  await f.seed({contacts:[contact('one')],templates:[{refs:{to:[ref('one')]}}]})
  await f.certify('22222222-2222-4222-8222-222222222222')
  const before=await f.state(), writer=await f.session('source-before-template-batch')
  await assert.rejects(writer.query("update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one';"),error=>error.code==='P0001' && /OUTLOOK_TEMPLATE_RECIPIENT_EVIDENCE_STALE/.test(error.message))
  assert.deepEqual(await f.state(),before)
}))

test("group rename keeps its exact ID and every other recipient, pending until certified", async () => withFixture(async f => {
  await f.seed({groups:[{id:'team',name:'Old Team'},{id:'other',name:'Old Team'}],templates:[{refs:{to:[ref('team',{kind:'group',name:'Old Team'}),ref('other',{kind:'group',name:'Old Team',position:1})]}}]})
  const before=await f.template()
  await f.owner.query("update public.shared_addressbook_groups set name='New; Team',nickname='new-team' where id='team';")
  const after=await f.template()
  assert.equal(after.recipient_resolution.refs.to[0].sourceId,'team')
  assert.equal(after.recipient_resolution.refs.to[0].status,'missing')
  assert.equal(after.recipient_resolution.refs.to[0].literal,'\"New; Team\"')
  assert.deepEqual(after.recipient_resolution.refs.to[1],before.recipient_resolution.refs.to[1])
  assert.equal(after.revision,before.revision+1)
}))

test("SQL serializer and tokenizer preserve escaped names and a following exact recipient",async()=>withFixture(async f=>{
  await f.seed({contacts:[contact('one'),contact('two')],groups:[{id:'team'}],templates:[{refs:{to:[ref('one'),ref('two',{position:1})],cc:[ref('team',{kind:'group',field:'cc'}),ref('two',{field:'cc',position:1})]}}]})
  const name='New, Team; "Quoted" \\ End\\'
  await f.owner.query(`update public.shared_addressbook_contacts set display_name=${literal(name)} where id='one'; update public.shared_addressbook_groups set name=${literal(name)} where id='team';`)
  const row=await f.template()
  for(const field of ['to','cc']){
    const tokens=await f.owner.one(`select to_jsonb(private.outlook_template_split_recipient_text(${literal(row[`${field}_recipients`])}));`)
    assert.deepEqual(tokens,row.recipient_resolution.refs[field].map(r=>r.literal))
    assert.equal(tokens.length,2)
    assert.equal(row.recipient_resolution.refs[field][0].displayName,name)
  }
}))

test("transient projection absence and an uncertified new source never authorize deletion", async () => withFixture(async f => {
  await f.seed({contacts:[contact('one')],templates:[{refs:{to:[ref('one')]}}]})
  const before=await f.template()
  const missing=await f.owner.one(`select public.reconcile_outlook_template_resolution(${json(before.recipient_resolution)},'{"contacts":[],"groups":[]}'::jsonb,${literal(certification)}::uuid,${literal(f.verified.latestCertificationAt)}::timestamptz,${literal('a'.repeat(64))},clock_timestamp());`)
  assert.equal(missing.refs.to.length,1); assert.equal(missing.refs.to[0].sourceId,'one'); assert.equal(missing.refs.to[0].status,'missing')
  await f.owner.query(`update public.email_templates set recipient_resolution=${json(missing)} where id='synthetic-template'; insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values ('new','SYNTHETIC','new','New','new@example.invalid');`)
  assert.equal((await f.template()).to_recipients,before.to_recipients)
  const prune=await f.session('projection-is-not-delete-proof')
  await assert.rejects(prune.query("select public.prune_deleted_outlook_template_source('contact','one');"),/OUTLOOK_TEMPLATE_DELETE_NOT_PROVEN/)
}))

test("moving one membership blocks both exact groups atomically with one template revision", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], groups: [{ id:'first' }, { id:'second' }], members: [{group:'first',contact:'one'}], templates: [{
    refs:{to:[ref('first',{kind:'group'}),ref('second',{kind:'group',position:1})]},
  }] })
  const before=await f.template()
  await f.owner.query("update public.shared_addressbook_group_members set group_id='second' where group_id='first' and contact_id='one';")
  const after=await f.template()
  assert.equal(after.revision,before.revision+1)
  assert.deepEqual(after.recipient_resolution.refs.to.map(r=>[r.sourceId,r.status]),[['first','missing'],['second','missing']])
  assert.equal(after.to_recipients,before.to_recipients)
}))

test("retrospective prune requires actual exact-ID DELETE audit, rejects current re-created identity, and is idempotent", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], templates: [{ refs: { to: [ref('one')] } }] })
  await f.owner.query("delete from public.shared_addressbook_contacts where id='one';")
  const before = await f.template()
  await f.apply()
  assert.equal((await f.owner.one("select public.prune_deleted_outlook_template_source('contact','one');")).updated, 1)
  const once = await f.template()
  assert.equal(once.to_recipients, ''); assert.equal(once.revision, before.revision + 1)
  assert.equal((await f.owner.one("select public.prune_deleted_outlook_template_source('contact','one');")).updated, 0)
  assert.deepEqual(await f.template(), once)
  const noProof = await f.session('no-proof')
  await assert.rejects(noProof.query("select public.prune_deleted_outlook_template_source('contact','unknown');"), /OUTLOOK_TEMPLATE_DELETE_NOT_PROVEN/)
  await f.owner.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values ('one','SYNTHETIC','one','Recreated','new@example.invalid');")
  const recreated = await f.session('recreated')
  await assert.rejects(recreated.query("select public.prune_deleted_outlook_template_source('contact','one');"), /OUTLOOK_TEMPLATE_DELETE_NOT_PROVEN/)
}, { repaired: false }))

test("ledger order, not old source audit timestamp, prevents stale re-resolution", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], templates: [{ refs: { to: [ref('one')] } }] })
  // The owner models a source audit time captured before its ledger lock wait.
  // Its actual immutable source_change event remains AFTER this certification.
  await f.owner.query("alter table public.audit_logs alter column occurred_at set default '2000-01-01'; update public.shared_addressbook_contacts set primary_email='new@example.invalid' where id='one'; alter table public.audit_logs alter column occurred_at set default clock_timestamp();")
  assert.equal((await f.owner.one(`select jsonb_build_object('pending',private.outlook_template_source_is_pending('contact','one',${literal(certification)}::uuid));`)).pending, true)
  const after = await f.template(), writer = await f.session('clock-gap-save')
  const revived = { ...after.recipient_resolution, refs: { ...after.recipient_resolution.refs, to: [{ ...after.recipient_resolution.refs.to[0], status: 'resolved', resolvedAddress: 'one@example.invalid' }] }, counts: { total: 1, resolved: 1, external: 0, missing: 0, ambiguous: 0 } }
  await assert.rejects(writer.query(`update public.email_templates set recipient_resolution=${json(revived)} where id='synthetic-template';`), /OUTLOOK_TEMPLATE_SOURCE_SYNC_PENDING/)
}))

test("retrospective prune cannot race an in-flight same-ID restoration", async () => withFixture(async f => {
  await f.seed({contacts:[contact('one')],templates:[{refs:{to:[ref('one')]}}]})
  await f.owner.query("delete from public.shared_addressbook_contacts where id='one';")
  await f.apply()
  const restorer=await f.session('restore-source'), prune=await f.session('prune-race')
  await restorer.begin('restore-source')
  await restorer.query("insert into public.shared_addressbook_contacts(id,source_book,source_card,display_name,primary_email) values ('one','SYNTHETIC','one','Restored','new@example.invalid');")
  await assert.rejects(prune.query("select public.prune_deleted_outlook_template_source('contact','one');"),error=>error.code==='55P03')
  await restorer.query('commit;')
  assert.equal((await f.template()).to_recipients,'one <one@example.invalid>')
  const after=await f.session('prune-restored')
  await assert.rejects(after.query("select public.prune_deleted_outlook_template_source('contact','one');"),/OUTLOOK_TEMPLATE_DELETE_NOT_PROVEN/)
}, {repaired:false}))

test("concurrent source edit serializes with canonical Save; old editor cannot resurrect a removed token", async () => withFixture(async f => {
  await f.seed({ contacts: [contact('one')], templates: [{ refs: { to: [ref('one')] } }] })
  const original = await f.template(), sourceWriter = await f.session('source-writer'), editor = await f.session('stale-editor')
  await sourceWriter.begin('source-writer')
  await sourceWriter.query("delete from public.shared_addressbook_contacts where id='one';")
  const stale = editor.query(`select public.save_email_template_canonical(${json(original)},${original.revision},null);`)
  await waitForBlock(f.owner, editor, sourceWriter, 'advisory')
  await sourceWriter.query('commit;')
  await assert.rejects(stale, /EMAIL_TEMPLATE_CONFLICT/)
  assert.equal((await f.template()).to_recipients, '')
}))

test("untrusted database roles cannot invoke propagation, pending helpers or retrospective prune", async () => withFixture(async f => {
  const rights = await f.owner.one(`select jsonb_build_object(
    'publicPrune',has_function_privilege('anon','public.prune_deleted_outlook_template_source(text,text)','EXECUTE'),
    'authenticatedPrune',has_function_privilege('authenticated','public.prune_deleted_outlook_template_source(text,text)','EXECUTE'),
    'servicePrune',has_function_privilege('service_role','public.prune_deleted_outlook_template_source(text,text)','EXECUTE'),
    'serviceApply',has_function_privilege('service_role','private.apply_outlook_template_source_change(text,text,jsonb,boolean)','EXECUTE'),
    'serviceTrigger',has_function_privilege('service_role','private.propagate_outlook_template_source_change()','EXECUTE'));`)
  assert.deepEqual(rights, { publicPrune: false, authenticatedPrune: false, servicePrune: true, serviceApply: false, serviceTrigger: false })
}))
