import assert from "node:assert/strict"
import test from "node:test"
import { loadSource } from "./fixtures/outlook-template-write-policy.mjs"

const run = "11111111-1111-4111-8111-111111111111"
const nextRun = "22222222-2222-4222-8222-222222222222"
type Ref = { field: string; position: number; literal: string; displayName: string; sourceValue: string; kind: string; sourceId: string | null; resolvedAddress: string | null; status: string }
const ref = (id: string, field = "to", position = 0, status = "resolved"): Ref => ({ field, position, literal: `${id} <${id}@example.invalid>`, displayName: id, sourceValue: `${id}@example.invalid`, kind: "contact", sourceId: id, resolvedAddress: status === "missing" ? null : `${id}@example.invalid`, status })
const previous = (refs: Record<string, Ref[]>, certificationRunId = run) => ({ schema: "fcuno.outlook-template-recipient-resolution/v1", certificationRunId, certifiedAt: new Date().toISOString(), sourceFingerprint: "a".repeat(64), resolvedAt: new Date().toISOString(), refs: { to: [], cc: [], bcc: [], ...refs }, counts: {} })

async function resolver(contacts: Array<{ id: string; email?: string; name?: string }>, certificationRunId = run, groups: Array<{id:string;name:string}> = []) {
  const projection = { contacts: contacts.map(c => ({ sourceContactId: c.id, displayName: c.name || c.id, externalEmailAddress: c.email || `${c.id}@example.invalid` })), groups: groups.map(g=>({sourceGroupId:g.id,groupName:g.name,alias:g.id,smtpAddress:`${g.id}@example.invalid`,memberCount:1})) }
  const client = {
    async rpc(name: string) {
      assert.equal(name, "verify_outlook_exchange_truth_ledger")
      return { data: { latestCertificationRunId: certificationRunId, latestCertificationAt: new Date().toISOString(), latestSourceFingerprint: "a".repeat(64), latestProjectionSnapshotSha256: "a".repeat(64) }, error: null }
    },
    from(table: string) {
      assert.equal(table, "outlook_exchange_truth_snapshots")
      const query = { select() { return query }, eq() { return query }, async maybeSingle() { return { data: { canonical_json: JSON.stringify(projection) }, error: null } } }
      return query
    },
  }
  const fixtureModule = loadSource("lib/outlookTemplateRecipientResolver.ts", {
    "server-only": {}, "@supabase/supabase-js": { createClient: () => client },
    "@/lib/outlookRecipientMapAvailability": { isCertifiedRecipientProjectionAvailable: () => true },
  }, { NEXT_PUBLIC_SUPABASE_URL: "https://fixture.invalid", SUPABASE_SERVICE_ROLE_KEY: "synthetic-not-a-key" }) as {
    loadOutlookTemplateRecipientResolver: () => Promise<{ resolve: (fields: { to: string; cc: string; bcc: string }, evidence: ReturnType<typeof previous>) => { refs: Record<string, Ref[]> } }>
  }
  return fixtureModule.loadOutlookTemplateRecipientResolver()
}

test("unchanged bound literals keep exact kind+sourceId across reorder and field moves", async () => {
  const r = await resolver([{ id: "one", email: "new@example.invalid" }, { id: "two" }], nextRun)
  const one = ref("one"), two = ref("two", "to", 1)
  const result = r.resolve({ to: two.literal, cc: one.literal, bcc: "" }, previous({ to: [one, two] }))
  assert.deepEqual(result.refs.to.map((r: Ref) => [r.kind, r.sourceId, r.position]), [["contact", "two", 0]])
  assert.deepEqual(result.refs.cc.map((r: Ref) => [r.kind, r.sourceId, r.position, r.resolvedAddress]), [["contact", "one", 0, "new@example.invalid"]])
})

test("missing source cannot be rebound to a new same-name/email source", async () => {
  const r = await resolver([{ id: "replacement", name: "one", email: "one@example.invalid" }], nextRun)
  const one = ref("one")
  const result = r.resolve({ to: "", cc: one.literal, bcc: "" }, previous({ to: [one] }))
  assert.equal(result.refs.cc[0].sourceId, "one")
  assert.equal(result.refs.cc[0].kind, "contact")
  assert.equal(result.refs.cc[0].status, "missing")
  assert.equal(result.refs.cc[0].resolvedAddress, null)
})

test("same certification cannot revive a pending source update from an old candidate", async () => {
  const r = await resolver([{ id: "one" }])
  const one = ref("one", "to", 0, "missing")
  const result = r.resolve({ to: one.literal, cc: "", bcc: "" }, previous({ to: [one] }))
  assert.equal(result.refs.to[0].status, "missing")
  assert.equal(result.refs.to[0].resolvedAddress, null)
  assert.equal(result.refs.to[0].sourceId, "one")
})

test("a later real certification can resolve the same retained identity to its new address", async () => {
  const r = await resolver([{ id: "one", email: "new@example.invalid" }], nextRun)
  const one = ref("one", "to", 0, "missing")
  const result = r.resolve({ to: one.literal, cc: "", bcc: "" }, previous({ to: [one] }))
  assert.equal(result.refs.to[0].status, "resolved")
  assert.equal(result.refs.to[0].resolvedAddress, "new@example.invalid")
  assert.equal(result.refs.to[0].sourceId, "one")
})

test("ambiguous historical literal identities cannot be guessed after moving fields", async () => {
  const r = await resolver([{ id: "one" }, { id: "two" }])
  const one = ref("one"), two = { ...ref("two", "to", 1), literal: one.literal, sourceValue: one.sourceValue }
  assert.throws(() => r.resolve({ to: "", cc: one.literal, bcc: "" }, previous({ to: [one, two] })), /identities are ambiguous/)
})

test("quoted commas, semicolons, quotes and trailing backslashes round-trip without losing contact/group identities",async()=>{
  const name='New, Team; "Quoted" \\ End\\'
  const quoted=`"${name.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`
  const group:Ref={...ref('team'),kind:'group',literal:quoted,displayName:name,sourceValue:name,status:'missing',resolvedAddress:null}
  const contact:Ref={...ref('one','to',1),literal:`${quoted} <one@example.invalid>`,displayName:name}
  const r=await resolver([{id:'one',name}],nextRun,[{id:'team',name},{id:'lookalike',name}])
  const result=r.resolve({to:`${group.literal}; ${contact.literal}`,cc:'',bcc:''},previous({to:[group,contact]}))
  assert.deepEqual(result.refs.to.map(r=>[r.kind,r.sourceId,r.displayName,r.sourceValue]),[['group','team',name,name],['contact','one',name,'one@example.invalid']])
})

test("unchanged legacy escaped group token never loses its ID when quote decoding is corrected",async()=>{
  const name='Team "Quoted" \\ End\\'
  const literal=`"${name.replaceAll('\\','\\\\').replaceAll('"','\\"')}"`
  const group:Ref={...ref('team'),kind:'group',literal,displayName:name,sourceValue:literal.slice(1,-1)}
  const r=await resolver([],nextRun,[{id:'team',name},{id:'lookalike',name}])
  const result=r.resolve({to:literal,cc:'',bcc:''},previous({to:[group]}))
  assert.equal(result.refs.to[0].sourceId,'team')
  assert.equal(result.refs.to[0].sourceValue,name)
})
