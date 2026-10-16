import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { templateWritePolicySql, verifiedTruth, loadSource, emptyResolution, inputTemplate } from "./fixtures/outlook-template-write-policy.mjs"
const {PGlite}=await import(process.env.PGLITE_MODULE_PATH||"@electric-sql/pglite")
const env={NEXT_PUBLIC_SUPABASE_URL:"https://synthetic-database.invalid",SUPABASE_SERVICE_ROLE_KEY:"synthetic-only"}
async function fixture({repaired=true,overrides={}}={}) {
  const db=new PGlite();await db.exec(templateWritePolicySql({repaired}));const truth=verifiedTruth(overrides);await db.query("insert into private.synthetic_exchange_truth values($1)",[truth])
  const calls=[], controls={permission:"edit"}
  const projection={contacts:[{sourceContactId:"synthetic-contact",displayName:"Certified Person",externalEmailAddress:"person@example.invalid"}],groups:[]}
  const client=()=>({async rpc(name,args){calls.push(name);if(name==="verify_outlook_exchange_truth_ledger")return {data:truth,error:null};assert.equal(name,"save_email_template_canonical");try{const result=await db.query("select public.save_email_template_canonical($1,$2,$3) result",[args.p_template,args.p_expected_revision,args.p_expected_updated_at]);return {data:result.rows[0].result,error:null}}catch(error){return {data:null,error:{code:error.code,message:error.message}}}},from(table){assert.equal(table,"outlook_exchange_truth_snapshots");const query={select(){return query},eq(){return query},async maybeSingle(){return {data:{canonical_json:JSON.stringify(projection)},error:null}}};return query}})
  const availability=loadSource("lib/outlookRecipientMapAvailability.ts",{})
  const resolver=loadSource("lib/outlookTemplateRecipientResolver.ts",{"server-only":{},"@supabase/supabase-js":{createClient:client},"@/lib/outlookRecipientMapAvailability":availability},env)
  const utils=loadSource("lib/emailTemplateCanonicalUtils.ts",{"node:crypto":{createHash},crypto:{createHash}})
  const library=loadSource("lib/emailTemplates.ts",{"@supabase/supabase-js":{createClient:client},"@/lib/adminAuth":{requireAdminSession:async()=>({username:"synthetic"})},"@/lib/adminAudit":{createAdminAuditedSupabaseClient:client},"@/lib/emailTemplateSanitizer":{sanitizeEmailTemplate:row=>row,findTemplateFormattingIssues:()=>[]},"@/lib/outlookTemplateRecipientResolver":resolver,"@/lib/emailTemplateCanonicalUtils":utils,"@/lib/emailTemplateSlug":{slugifyEmailTemplate:value=>value}},env)
  const api=loadSource("app/api/admin/email-templates/route.ts",{"next/server":{NextResponse:Response},"@/lib/emailTemplates":library,"@/lib/adminAudit":{createAdminAuditContext:()=>({username:"synthetic"})},"@/lib/adminAuth":{requireAdminPagePermission:async(page,access)=>{assert.equal(page,"email-templates");assert.equal(access,"edit");if(controls.permission!=="edit")throw Error(controls.permission==="anonymous"?"Unauthorized":"Forbidden");return {username:"synthetic"}}},"@/lib/sharedAddressBookServer":{loadSharedAddressBookRecipients:async()=>assert.fail("save never loads mutable directory")}})
  const base={id:"synthetic-template",title:"Synthetic template",subject:"Subject",folder:"Synthetic",sourcePath:"",from:"",to:"Certified Person",cc:"",bcc:"",bodyHtml:"<p>Body</p>",bodyText:"Body",tags:[],slug:"synthetic-template",isActive:true,placeholders:[],recipientResolution:{},updatedAt:new Date().toISOString(),revision:0}
  async function save(changes={}){const row={...base,...changes};const response=await api.POST(new Request("https://synthetic-app.invalid/api/admin/email-templates",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"save-template",template:row,expectedRevision:row.revision})}));return {status:response.status,body:await response.json()}}
  return {db,truth,calls,controls,save,resolver,projection,close:()=>db.close()}
}
test("RED: old database trigger refuses actual API save despite approved normal-queue certified map",async()=>{const f=await fixture({repaired:false});try{assert.equal((await f.save()).status,500);assert.equal((await f.db.query("select count(*)::int n from public.email_templates")).rows[0].n,0)}finally{await f.close()}})
test("actual API, library, resolver and repaired SQL allow body-only saves throughout ordinary queue delivery",async()=>{const f=await fixture();try{const created=await f.save();assert.equal(created.status,200);assert.equal(created.body.template.revision,1);const changed=await f.save({...created.body.template,bodyHtml:"<p>Changed body only</p>",bodyText:"Changed body only"});assert.equal(changed.status,200);assert.equal(changed.body.template.revision,2);assert.equal(changed.body.template.recipientResolution.refs.to[0].sourceId,"synthetic-contact");assert.deepEqual(f.calls,["verify_outlook_exchange_truth_ledger","save_email_template_canonical","verify_outlook_exchange_truth_ledger","save_email_template_canonical"]);assert.equal((await f.db.query("select count(*)::int n from public.audit_logs")).rows[0].n,2)}finally{await f.close()}})
test("actual save rejects real queue failures, stale or broken certification, before any canonical write",async()=>{for(const overrides of [{queue:{pending:1,processing:1,failed:1,terminalFailed:0}},{queue:{failed:0,terminalFailed:1}},{latestCertificationAt:new Date(Date.now()-37*3600000).toISOString()},{integrityValid:false},{latestProjectionSnapshotSha256:"b".repeat(64)}]){const f=await fixture({overrides});try{assert.equal((await f.save()).status,500);assert.deepEqual(f.calls,["verify_outlook_exchange_truth_ledger"]);assert.equal((await f.db.query("select count(*)::int n from public.audit_logs")).rows[0].n,0)}finally{await f.close()}}})
test("actual API permissions remain EDIT-only and prevent all recipient/SQL reads",async()=>{const f=await fixture();try{for(const [permission,status]of[["anonymous",401],["view",403]]){f.controls.permission=permission;assert.equal((await f.save()).status,status);assert.deepEqual(f.calls,[])}}finally{await f.close()}})
test("actual resolver keeps certified source identity on recipient changes and never silently rebinds a deleted source",async()=>{
  const f=await fixture();try{
    let resolver=await f.resolver.loadOutlookTemplateRecipientResolver()
    const previous=resolver.resolve({to:"Certified Person",cc:"",bcc:""})
    assert.equal(previous.refs.to[0].sourceId,"synthetic-contact")
    f.projection.contacts.push({sourceContactId:"other-contact",displayName:"Certified Person",externalEmailAddress:"other@example.invalid"})
    resolver=await f.resolver.loadOutlookTemplateRecipientResolver()
    assert.equal(resolver.resolve({to:"Certified Person",cc:"",bcc:""}).refs.to[0].status,"ambiguous")
    assert.equal(resolver.resolve({to:"Certified Person",cc:"",bcc:""},previous).refs.to[0].sourceId,"synthetic-contact")
    f.projection.contacts.shift()
    resolver=await f.resolver.loadOutlookTemplateRecipientResolver()
    const missing=resolver.resolve({to:"Certified Person",cc:"",bcc:""},previous)
    assert.equal(missing.refs.to[0].status,"missing");assert.equal(missing.refs.to[0].sourceId,"synthetic-contact");assert.equal(missing.refs.to[0].resolvedAddress,null)
    const explicit=resolver.resolve({to:"other@example.invalid",cc:"",bcc:""},previous)
    assert.equal(explicit.refs.to[0].sourceId,"other-contact")
  }finally{await f.close()}
})
test("unsafe address evidence cannot be persisted; stale recipient evidence and stale revision roll back",async()=>{const f=await fixture();try{assert.equal((await f.save({to:"bad@@example.invalid"})).status,500);assert.equal((await f.db.query("select count(*)::int n from public.email_templates")).rows[0].n,0);const valid=await f.save();assert.equal(valid.status,200);const stale=await f.save({revision:0});assert.equal(stale.status,409);const wrong=emptyResolution(f.truth);wrong.sourceFingerprint="b".repeat(64);await assert.rejects(f.db.query("select public.save_email_template_canonical($1,1,null)",[inputTemplate(wrong)]),error=>error.code==="40001");assert.equal((await f.db.query("select count(*)::int n from public.audit_logs")).rows[0].n,1)}finally{await f.close()}})
