import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { transformSync } from "esbuild"

const source = (file: string) => readFileSync(new URL(`../${file}`,import.meta.url),"utf8")
function load(file: string,start: string,end: string,result: string) {
  const text=source(file), from=text.indexOf(start), to=text.indexOf(end,from)
  assert.ok(from>=0&&to>from,`Missing bounded production declarations in ${file}`)
  const code=transformSync(text.slice(from,to),{loader:"ts",format:"cjs",target:"node24"}).code
  return new Function(`${code}; return ${result};`)()
}

test("actual exporter, health and offline validator require receipts from proven capability, not a sparse maximum migration",()=>{
  const exporter=load("app/api/backups/bunker-map-drive/route.ts","const RETAINED_VERIFIED_BACKUP_COUNT","function requireEnv","getApplicableTableConfigs")
  const health=load("lib/systemHealth.ts","const BACKUP_FOLDER_NAME","function requireEnv","getBackupArtifactContract")
  const validator=load("scripts/validate-backup.mjs","const MINIMUM_V2_MIGRATION_HEAD","const TOP_LEVEL_KEYS","getBackupContract")
  for(const head of ["20261007115435","20261009050519","20261009050520","20991231235959"]) {
    for(const schema of ["none","creation-v1","recovery-v2"]) {
      const expected=schema!=="none",tables=exporter(head,schema),h=health(head,schema),v=validator(head,schema)
      assert.equal(tables.some((row:{table:string})=>row.table==="price_setter_creation_receipts"),expected)
      for(const list of [h.registeredTables,h.requiredLiveTables,v.expectedRegisteredTables,v.requiredLiveTables]) assert.equal(list.includes("price_setter_creation_receipts"),expected)
      for(const list of [h.requiredSectionKeys,h.requiredDataKeys,v.requiredSections,v.expectedDataSections]) assert.equal(list.includes("priceSetterCreationReceipts"),expected)
      if(expected) {
        assert.deepEqual(tables.find((r:{table:string})=>r.table==="price_setter_creation_receipts").order,[{column:"request_id",ascending:true}])
        assert.deepEqual(v.sectionSpecs.find((r:{key:string})=>r.key==="priceSetterCreationReceipts").primaryKey,["request_id"])
      }
    }
  }
  assert.equal(exporter("20991231235959").some((r:{table:string})=>r.table==="price_setter_creation_receipts"),false,"later unrelated schema changes cannot require an uninstalled pricing table")
  assert.equal(exporter("20991231235959","recovery-v2").length-exporter("20991231235959","none").length,1)
})

test("actual offline receipt validation preserves deleted-port tombstones and rejects corruption/duplicate identities",()=>{
  const validate=load("scripts/validate-backup.mjs","function validatePriceSetterCreationReceipts","function validateSections","validatePriceSetterCreationReceipts")
  const row={request_id:"11111111-1111-4111-8111-111111111111",port_id:"22222222-2222-4222-8222-222222222222",kind:"port",created_at:"2026-10-09T05:05:20.123456+00:00"}
  assert.deepEqual(validate([]),[]);assert.deepEqual(validate([row]),[],"no current port is required for an immutable tombstone")
  for(const bad of [null,[],{}, {...row,request_id:"bad"},{...row,port_id:null},{...row,kind:"bad"},{...row,created_at:"bad"}]) assert.equal(validate([bad]).length,1)
  for(const duplicate of [{...row,port_id:row.request_id},{...row,request_id:row.port_id},{...row,request_id:row.request_id.toUpperCase()}]) assert.equal(validate([row,duplicate]).length,1)
})

test("actual recovery script refuses both v2 and legacy artifacts before creating any database client",()=>{
  // Execute the complete real script with in-memory file/exit/console boundaries.
  // No shell, file writes, credentials, network or recovery database involved.
  const text=source("scripts/restore-backup-to-recovery.mjs")
  for(const backup of [{schemaVersion:2},{integrity:{schema:"bunker-map-backup-integrity/v2"}},{schemaVersion:1},{}]) {
    const logs:string[]=[],stop=Symbol("exit")
    const code=transformSync(text,{loader:"js",format:"cjs",target:"node24"}).code
    assert.throws(()=>new Function("require","process","console",code)(
      (name:string)=>{assert.equal(name,"node:fs");return {readFileSync:()=>JSON.stringify(backup)}},
      {argv:["node","restore","synthetic-backup.json"],exit:(status:number)=>{assert.equal(status,2);throw stop}},
      {error:(message:string)=>logs.push(message)},
    ),(error:unknown)=>error===stop)
    assert.equal(logs.length,1);assert.match(logs[0],/REFUSED/);assert.match(logs[0],/whole-database/);assert.match(logs[0],/No .*writes/)
  }
})

test("recovery-aware backup validation gates owner/ack fields, preserves legacy tombstones, and rejects ambiguous pending state",()=>{
  const validate=load("scripts/validate-backup.mjs","function validatePriceSetterCreationReceipts","function validateSections","validatePriceSetterCreationReceipts")
  const legacy={request_id:"11111111-1111-4111-8111-111111111111",port_id:"22222222-2222-4222-8222-222222222222",kind:"port",created_at:"2026-10-09T05:05:20.123456+00:00"}
  const pending={...legacy,actor_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",acknowledged_at:null}
  const head="recovery-v2"
  assert.deepEqual(validate([legacy],"creation-v1"),[])
  assert.equal(validate([legacy],head).length,1,"modern artifacts must not silently lose ownership during export/restore")
  assert.deepEqual(validate([{...legacy,actor_id:null,acknowledged_at:null}],head),[],"unowned historical receipts are preserved without assigning an actor")
  assert.deepEqual(validate([pending],head),[])
  assert.deepEqual(validate([{...pending,acknowledged_at:"2026-10-09T05:05:20.123456Z"}],head),[])
  assert.deepEqual(validate([{...pending,acknowledged_at:"2026-10-09T13:05:20.123457+08:00"}],head),[])
  for(const bad of [{...pending,actor_id:"bad"},{...pending,actor_id:undefined},{...pending,acknowledged_at:undefined},
    {...pending,actor_id:null,acknowledged_at:"2026-10-09T06:00:00Z"},
    {...pending,acknowledged_at:"2026-10-09T05:05:20.123455Z"},
    {...pending,acknowledged_at:"2026-02-30T05:05:20Z"},
    {...pending,acknowledged_at:"2026-10-09T25:00:00Z"}]) assert.equal(validate([bad],head).length,1)
  const other={...pending,request_id:"33333333-3333-4333-8333-333333333333",port_id:"44444444-4444-4444-8444-444444444444",actor_id:pending.actor_id.toUpperCase()}
  assert.equal(validate([pending,other],head).length,1)
  assert.deepEqual(validate([{...pending,acknowledged_at:"2026-10-09T05:05:21Z"},other],head),[])
  assert.deepEqual(validate([pending,{...other,actor_id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}],head),[])
})
