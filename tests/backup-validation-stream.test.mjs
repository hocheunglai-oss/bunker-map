import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { once } from "node:events"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { BACKUP_VALIDATION_LIMITS, DiskMap, DiskSet, hashValidationValue, parseBoundedBackupJson, readBackupForValidation, sortedValidationRows } from "../lib/backupValidationSpool.mjs"
import { fixtureRunId, makeBackupFixture, rehashBackupFixture, writeLargeBackupFixture } from "./fixtures/backup-validation.mjs"

const root = fileURLToPath(new URL("../", import.meta.url)), validator = path.join(root, "scripts/validate-backup.mjs")
const hash = value => createHash("sha256").update(value).digest("hex")
function temporary() { return fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-backup-test-")) }
function cli(file, script = validator, heap = 256) {
  return spawnSync(process.execPath, [`--max-old-space-size=${heap}`, script, file], { cwd: root, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })
}
function result(output) { return output.split("\n").filter(line => /^(?:ERROR:|WARNING:|RESULT:|File SHA-256:|Artifact SHA-256:|Errors:|Warnings:|Truth head:)/.test(line)) }
function pinnedBaseline() {
  const metadata=JSON.parse(fs.readFileSync(new URL("./fixtures/backup-validator-baseline.json",import.meta.url),"utf8"))
  const source=fs.readFileSync(new URL(`./fixtures/${metadata.fixturePath}`,import.meta.url),"utf8")
  assert.equal(metadata.commit,"b3b6fe34d16107a269b981074bfe1ee0b2614119")
  assert.equal(metadata.repository,"hocheunglai-oss/bunker-map")
  assert.equal(metadata.sourcePath,"scripts/validate-backup.mjs")
  assert.equal(metadata.sourceBytes,97282)
  assert.equal(Buffer.byteLength(source),metadata.sourceBytes)
  assert.equal(metadata.sourceSha256,"3c9762e9f7661d2d8719f6491a8436e9c2c33d740ec9010679867acb113a2148")
  assert.equal(hash(source),metadata.sourceSha256)
  return source
}

test("the pre-streaming comparison baseline is immutable, self-contained and independent of Git HEAD/history", () => {
  const source=pinnedBaseline()
  assert.match(source,/port: idSet\(data, "ccPorts"\)/)
  assert.match(source,/fs\.readFileSync\(backupPath, "utf8"\)/)
  assert.doesNotMatch(source,/backupValidationSpool/)
  assert.equal(source.split('"../lib/backupPricingSchema.mjs"').length,2)
})

test("disk-backed views preserve JSON.stringify/v1 hashes, escaped UTF8, scalar normalization and derived array semantics", async () => {
  const directory = temporary(), file = path.join(directory, "values.json")
  const input = '{"schemaVersion":2,"data":{"auditLogs":[{"id":"x","escaped":"\\u00e9🛳\\n\\\"","n":-0,"exponent":1e+2,"integerKeys":{"2":"b","1":"a"}},{"id":"y","v":null},{}]},"warnings":[]}'
  fs.writeFileSync(file, input)
  const loaded = await readBackupForValidation(file)
  try {
    const ordinary = JSON.parse(input)
    assert.equal(Array.isArray(loaded.backup.data.auditLogs), true)
    assert.equal(hashValidationValue(loaded.backup), hash(JSON.stringify(ordinary)))
    assert.equal(hashValidationValue(loaded.backup.data.auditLogs), hash(JSON.stringify(ordinary.data.auditLogs)))
    assert.equal(loaded.fileSha256, hash(input))
    const mapped = loaded.backup.data.auditLogs.filter(row => row.id).map(row => [row.id, row])
    const index = new DiskMap(mapped), ids = new DiskSet(index.keys())
    assert.equal(index.size, 2); assert.equal(ids.size, 2); assert.equal(index.get("x").escaped, ordinary.data.auditLogs[0].escaped)
    const sorted = sortedValidationRows(loaded.backup.data.auditLogs.filter(row => row.id), row => row.id === "x" ? 2 : 1)
    assert.deepEqual([...sorted].map(row => row.id), ["y", "x"])
    index.set("undefined-values",{empty:[],missing:undefined,array:[undefined,,null]})
    assert.deepEqual(index.get("undefined-values"),{empty:[],missing:undefined,array:[undefined,undefined,null]})
    assert.equal(hashValidationValue(index.get("undefined-values")),hash(JSON.stringify({empty:[],array:[null,null,null]})))
    assert.ok(loaded.spool.peakCacheBytes <= loaded.spool.limits.cacheBytes)
  } finally { const temp = loaded.spool.directory; loaded.close(); assert.equal(fs.existsSync(temp), false); fs.rmSync(directory, {recursive:true,force:true}) }
})

test("strict streaming JSON rejects truncation, bad escapes, invalid UTF8 and duplicate/ambiguous keys with owned spool cleanup", async () => {
  const directory = temporary(), file = path.join(directory, "invalid.json")
  try {
    for (const input of ['{"data":{"auditLogs":[{"id":"x"}', '{"data":{"auditLogs":[{"id":"\\q"}]}}',
      '{"data":{"auditLogs":[{"id":"x","id":"y"}]}}', '{"data":{"auditLogs":[],"auditLogs":[]}}',
      '{"data":{},"data":{}}', '{"data":{"auditLogs":[1,]}}', '{"data":{}} garbage', Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d])]) {
      fs.writeFileSync(file, input)
      await assert.rejects(readBackupForValidation(file))
    }
  } finally { fs.rmSync(directory,{recursive:true,force:true}) }
})

test("structural, byte and depth guards run before JSON.parse, including JSON embedded in truth strings", async () => {
  const limits = {...BACKUP_VALIDATION_LIMITS,structuralTokens:20,objectProperties:5,arrayElements:5,depth:4,valueBytes:4096}
  for (const input of ['{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}', '[0,0,0,0,0,0]',
    '[[[[[0]]]]]', JSON.stringify({a:"A".repeat(4096)}), '{"value":1e400}', '{"nested":{"x":1,"x":2}}']) {
    assert.throws(()=>parseBoundedBackupJson(input,limits),/bounded|Non-finite|Duplicate/)
  }
  assert.deepEqual(parseBoundedBackupJson('{"x":-0,"y":1e2,"z":"\\ud83d\\udea2"}',limits), {x:-0,y:100,z:"🚢"})
  const directory=temporary(),file=path.join(directory,"wide.json")
  try {
    fs.writeFileSync(file,'{"data":{"auditLogs":[{"a":1,"b":2,"c":3,"d":4,"e":5,"f":6}]}}')
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith("fcuno-backup-validation-")))
    await assert.rejects(readBackupForValidation(file,{limits}),/bounded/)
    assert.deepEqual(new Set(fs.readdirSync(os.tmpdir()).filter(name=>name.startsWith("fcuno-backup-validation-"))),before)
  } finally { fs.rmSync(directory,{recursive:true,force:true}) }
})

test("a second concurrent reader cannot replace the first spool/index owner", async () => {
  const directory=temporary(),file=path.join(directory,"backup.json")
  fs.writeFileSync(file,JSON.stringify(makeBackupFixture()))
  let loaded
  try {
    const first=readBackupForValidation(file)
    await assert.rejects(readBackupForValidation(file),/Only one backup validation spool/)
    loaded=await first
    await assert.rejects(readBackupForValidation(file),/Only one backup validation spool/)
    assert.equal(hashValidationValue(loaded.backup.data.auditLogs),hash("[]"))
    loaded.close();loaded=null
    const next=await readBackupForValidation(file);next.close()
  } finally {loaded?.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test("retained rows, nested index values, lazy arrays and indexes reject closed or foreign owners", async () => {
  const directory=temporary(),file=path.join(directory,"backup.json")
  fs.writeFileSync(file,JSON.stringify({data:{rows:[{id:"A",value:"first"}]}}))
  let first,second
  try {
    first=await readBackupForValidation(file)
    const row=first.backup.data.rows[0],array=first.backup.data.rows
    const derived=array.map(value=>[value.id,value]),empty=array.filter(()=>false)
    const map=new DiskMap([["a",row]]),set=new DiskSet(["a"])
    const iterators=[array.values(),array.entries(),derived.values(),map.entries(),set.values()]
    for(const iterator of iterators) assert.equal(iterator.next().done,false)
    const at=array.at,mapArray=array.map,emptyValues=empty.values
    const oldIdentity=first.spool.identity
    first.close()
    const closedOperations=[()=>row.id,()=>Object.keys(row),()=>"id" in row,()=>array.length,()=>array[0],
      ()=>hashValidationValue(row),()=>hashValidationValue({nested:[row]}),()=>hashValidationValue(array),
      ()=>at(0),()=>mapArray(value=>value),()=>emptyValues().next(),()=>sortedValidationRows(array,()=>1),
      ()=>map.size,()=>map.has("a"),()=>map.get("a"),()=>map.set("x",1),()=>map.delete("a"),
      ()=>map.entries().next(),()=>set.size,()=>set.add("b"),()=>set.has("a"),()=>set.delete("a"),()=>set.values().next()]
    for(const operation of closedOperations) assert.throws(operation,/spool is closed/)
    for(const iterator of iterators) assert.throws(()=>iterator.next(),/spool is closed/)
    fs.writeFileSync(file,JSON.stringify({data:{rows:[{id:"B",value:"second"}]}}))
    second=await readBackupForValidation(file)
    const current=new DiskMap()
    for(const operation of closedOperations) assert.throws(operation,/spool is closed/)
    for(const value of [row,array,derived,{nested:[row]},{nested:{array}}]) {
      assert.throws(()=>current.set("retained",value),/spool is closed/)
    }
    assert.equal(current.size,0)
    // Even corrupted on-disk references must not bind an old owner to new rows.
    for(const encoded of [["row",oldIdentity,"rows",0],["view",oldIdentity,1]]) {
      second.spool.indexSet.run(current.id,JSON.stringify(["string","foreign"]),JSON.stringify(encoded))
      assert.throws(()=>current.get("foreign"),/Foreign backup validation/)
    }
    current.set("current",{row:second.backup.data.rows[0],array:second.backup.data.rows})
    assert.equal(current.get("current").row.id,"B")
    assert.equal(current.get("current").array,second.backup.data.rows)
    assert.equal(hashValidationValue(second.backup.data.rows[0]),hash(JSON.stringify({id:"B",value:"second"})))
  } finally {first?.close();second?.close();fs.rmSync(directory,{recursive:true,force:true})}
})

test("local error and warning collection is bounded and cannot produce partial VALID results", {timeout:180000}, () => {
  const directory=temporary(),file=path.join(directory,"invalid.json"),spools=path.join(directory,"spools")
  fs.mkdirSync(spools)
  try {
    const source=fs.readFileSync(validator,"utf8")
    const diagnostics=source.slice(source.indexOf("function addError"),source.indexOf("function isPresentPrimaryKeyValue"))
    const receiptSource=source.slice(source.indexOf("function validatePriceSetterCreationReceipts"),source.indexOf("function validateAttendanceDingtalkEvidence"))
    const validateReceipts=new Function(`${diagnostics}\n${receiptSource};return validatePriceSetterCreationReceipts`)()
    assert.throws(()=>validateReceipts(new Array(1100).fill({})),/truncated after 1000 distinct errors.*INVALID/)
    const collect=new Function(`${diagnostics};return addError`)(),messages=[]
    collect(messages,"same");collect(messages,"same");assert.equal(messages.length,1)
    assert.throws(()=>collect(messages,"x".repeat(4097)),/message exceeds 4096.*INVALID/)
    for(const kind of ["anomalies","warnings"]) {
      const fixture=makeBackupFixture("20261014082839")
      if(kind==="anomalies") fixture.data.attendanceDingtalkPunchAnomalies=new Array(600000).fill({})
      else fixture.warnings=Array.from({length:1100},(_,index)=>({key:`warning-${index}`,message:`Synthetic warning ${index}`}))
      fs.writeFileSync(file,JSON.stringify(rehashBackupFixture(fixture)))
      const output=spawnSync(process.execPath,["--max-old-space-size=64",validator,file],{cwd:root,env:{...process.env,TMPDIR:spools},encoding:"utf8",maxBuffer:2*1024*1024,timeout:120000})
      assert.equal(output.status,1,output.stdout+output.stderr)
      assert.equal(output.signal,null,output.stdout+output.stderr)
      assert.match(output.stdout+output.stderr,/Diagnostic output truncated after 1000 distinct (?:errors|warnings).*INVALID/)
      assert.doesNotMatch(output.stdout,/RESULT: VALID/)
      assert.doesNotMatch(output.stderr,/heap out of memory|Reached heap limit|Ineffective mark-compacts/)
      assert.deepEqual(fs.readdirSync(spools),[])
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true})}
})

test("full semantic validator agrees with the previous validator on valid, hash, duplicate, FK, credential and truth-ledger cases", () => {
  const directory = temporary(), file = path.join(directory, "backup.json"), baseline = path.join(directory, "baseline.mjs")
  let previous = pinnedBaseline()
  previous = previous.replace('"../lib/backupPricingSchema.mjs"', JSON.stringify(new URL("../lib/backupPricingSchema.mjs", import.meta.url).href))
  fs.writeFileSync(baseline, previous)
  const cases = [
    backup => backup,
    backup => { backup.data.auditLogs = [{id:"audit",table_name:"ports",after_row:{"é🛳": "escaped\n\"",n:-0,exponent:1e2}}]; return rehashBackupFixture(backup) },
    backup => { backup.integrity.artifactSha256 = "0".repeat(64); return backup },
    backup => { backup.integrity.sections.admins.sha256 = "0".repeat(64); return backup },
    backup => { backup.data.admins = [{id:"duplicate"},{id:"duplicate"}]; return rehashBackupFixture(backup) },
    backup => { backup.data.ccPorts = [{id:"port",country_id:"missing"}]; return rehashBackupFixture(backup) },
    backup => { backup.data.adminUsers = [{id:"admin",password_hash:"forbidden"}]; return rehashBackupFixture(backup) },
    backup => { backup.data.auditLogs = [{id:"audit",table_name:"admin_users",after_row:{password_hash:"forbidden"}}]; return rehashBackupFixture(backup) },
    backup => { backup.data.outlookExchangeTruthLedger[1].previous_entry_sha256 = "0".repeat(64); return rehashBackupFixture(backup) },
    backup => { backup.data.outlookExchangeTruthLedger[0].audit_log_id = "missing"; return rehashBackupFixture(backup) },
    backup => { backup.data.outlookExchangeTruthSnapshots[0].canonical_json += " "; return rehashBackupFixture(backup) },
    backup => { backup.integrity.truth.exportedLedger.entries = 1; return backup },
  ]
  try {
    for (const mutate of cases) {
      fs.writeFileSync(file, JSON.stringify(mutate(makeBackupFixture()),null,2))
      const old = cli(file,baseline), current = cli(file)
      assert.equal(current.status,old.status, current.stdout+current.stderr)
      assert.deepEqual(result(current.stdout),result(old.stdout),current.stderr)
    }
    fs.writeFileSync(file,JSON.stringify(makeBackupFixture()))
    const valid = cli(file)
    assert.equal(valid.status,0,valid.stdout+valid.stderr)
    assert.match(valid.stdout,/RESULT: VALID/)
    fs.writeFileSync(file,JSON.stringify(makeBackupFixture("20261014082839")))
    const currentSchema = cli(file)
    assert.equal(currentSchema.status,0,currentSchema.stdout+currentSchema.stderr)
    assert.deepEqual(result(currentSchema.stdout),result(cli(file,baseline).stdout))
    for(const present of [true,false]) {
      const ports=makeBackupFixture("20261014082839")
      ports.data.ccPorts=present?[{id:"port"}]:[]
      ports.data.ccEntryFolders=[{id:"folder",entry_kind:"port",entry_id:"port"}]
      ports.data.ccEntryFiles=[{id:"file",entry_kind:"port",entry_id:"port",drive_file_id:"synthetic-drive"}]
      fs.writeFileSync(file,JSON.stringify(rehashBackupFixture(ports)))
      const next=cli(file),old=cli(file,baseline)
      assert.equal(next.status,present?0:1,next.stdout+next.stderr)
      assert.equal(next.status,old.status,old.stdout+old.stderr)
      assert.deepEqual(result(next.stdout),result(old.stdout))
    }
    const withTemplate = makeBackupFixture("20261014082839")
    const resolution = { schema:"fcuno.outlook-template-recipient-resolution/v1",certificationRunId:fixtureRunId,
      certifiedAt:withTemplate.integrity.truth.checkpointAfterExport.latestCertificationAt,
      sourceFingerprint:withTemplate.integrity.truth.checkpointAfterExport.latestSourceFingerprint,resolvedAt:withTemplate.generatedAt,
      refs:{to:[{field:"to",position:0,literal:"operations@example.invalid",displayName:"",sourceValue:"operations@example.invalid",
        kind:"external",sourceId:null,resolvedAddress:"operations@example.invalid",status:"external"}],cc:[],bcc:[]},
      counts:{total:1,resolved:0,external:1,ambiguous:0,missing:0} }
    withTemplate.data.emailTemplates=[{id:"template",to_recipients:"operations@example.invalid",recipient_resolution:resolution}]
    for (const field of ["templateRecipientVerificationBeforeExport","templateRecipientVerificationAfterExport"]) {
      withTemplate.integrity.truth[field].templates.total=1;withTemplate.integrity.truth[field].templates.sendable=1
    }
    withTemplate.integrity.truth.templateRecipientTruth.total=1;withTemplate.integrity.truth.templateRecipientTruth.sendable=1
    for (const valid of [true,false]) {
      resolution.refs.to[0].resolvedAddress=valid?"operations@example.invalid":"wrong@example.invalid"
      fs.writeFileSync(file,JSON.stringify(rehashBackupFixture(withTemplate)))
      const next=cli(file),old=cli(file,baseline)
      assert.equal(next.status,valid?0:1,next.stdout+next.stderr)
      assert.deepEqual(result(next.stdout),result(old.stdout))
    }
  } finally { fs.rmSync(directory,{recursive:true,force:true}) }
})

test("port file/folder parent validation from the preceding repair is preserved", () => {
  const directory=temporary(),file=path.join(directory,"port.json")
  try {
    const backup=makeBackupFixture("20261014082839")
    backup.data.ccPorts=[{id:"port"}]
    backup.data.ccEntryFolders=[{id:"folder",entry_kind:"port",entry_id:"port"}]
    backup.data.ccEntryFiles=[{id:"file",entry_kind:"port",entry_id:"port",drive_file_id:"synthetic-drive"}]
    fs.writeFileSync(file,JSON.stringify(rehashBackupFixture(backup)))
    assert.equal(cli(file).status,0)
    backup.data.ccPorts=[]
    fs.writeFileSync(file,JSON.stringify(rehashBackupFixture(backup)))
    const invalid=cli(file)
    assert.equal(invalid.status,1)
    assert.match(invalid.stdout,/ccEntryFiles.entry_id: 1 missing parent reference/)
    assert.match(invalid.stdout,/ccEntryFolders.entry_id: 1 missing parent reference/)
  } finally {fs.rmSync(directory,{recursive:true,force:true})}
})

test("sensitive temporary rows are removed on uncaught failure, SIGINT and SIGTERM", {timeout:10000}, async () => {
  const directory=temporary(),file=path.join(directory,"backup.json")
  fs.writeFileSync(file,JSON.stringify(makeBackupFixture()))
  try {
    for (const signal of [null,"SIGINT","SIGTERM"]) {
      const source=`import {readBackupForValidation} from ${JSON.stringify(new URL("../lib/backupValidationSpool.mjs",import.meta.url).href)};const loaded=await readBackupForValidation(${JSON.stringify(file)});console.log(loaded.spool.directory);${signal?"setInterval(()=>{},1000)":"throw new Error('Synthetic failure')"}`
      const child=spawn(process.execPath,["--input-type=module","-e",source],{cwd:root,stdio:["ignore","pipe","pipe"]})
      let output="";child.stdout.setEncoding("utf8");child.stdout.on("data",chunk=>{output+=chunk})
      const exited=once(child,"exit")
      try {
        while (!output.includes("\n")) await Promise.race([once(child.stdout,"data"),exited.then(()=>{if(!output)throw new Error("No spool path emitted")})])
        const spoolPath=output.trim()
        assert.ok(spoolPath.startsWith(path.join(os.tmpdir(),"fcuno-backup-validation-")))
        if (signal) child.kill(signal)
        await exited
        assert.equal(fs.existsSync(spoolPath),false)
      } finally {if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL")}
    }
  } finally {fs.rmSync(directory,{recursive:true,force:true})}
})

test("full semantic validation handles a production-sized 2,535,715,355-byte artifact under a 256 MB heap", {skip:process.env.FCUNO_BACKUP_SCALE_TEST !== "1",timeout:600000}, () => {
  const directory = temporary(), file = path.join(directory,"synthetic-large.json")
  try {
    const generated = writeLargeBackupFixture(file,2535715355)
    const output = cli(file,validator,256)
    assert.equal(output.status,0,output.stdout+output.stderr)
    assert.match(output.stdout,/RESULT: VALID/)
    assert.match(output.stdout,/Errors: 0/)
    assert.match(output.stdout,/Warnings: 0/)
    assert.ok(output.stdout.includes(`File SHA-256: ${generated.fileSha256}`))
    assert.ok(output.stdout.includes(`Artifact SHA-256: ${generated.artifactSha256}`))
    assert.match(output.stdout,/Truth snapshots checked: 69/)
    const nestedSource=`import {readBackupForValidation,DiskMap} from ${JSON.stringify(new URL("../lib/backupValidationSpool.mjs",import.meta.url).href)};const loaded=await readBackupForValidation(${JSON.stringify(file)});try{const index=new DiskMap();for(let n=0;n<5000;n++)index.set(n,loaded.backup.data.auditLogs[n].after_row);if(index.size!==5000||index.get(4999).blob.length<10000)throw new Error('Nested index mismatch');console.log('Nested payloads spilled; peak retained cache estimate: '+loaded.spool.peakCacheBytes)}finally{loaded.close()}`
    const nested=spawnSync(process.execPath,["--max-old-space-size=64","--input-type=module","-e",nestedSource],{cwd:root,encoding:"utf8",maxBuffer:1024*1024})
    assert.equal(nested.status,0,nested.stdout+nested.stderr)
    assert.match(nested.stdout,/Nested payloads spilled/)
    const restore = cli(file,path.join(root,"scripts/restore-backup-to-recovery.mjs"),32)
    assert.equal(restore.status,2)
    assert.match(restore.stderr,/No artifact bytes were read/)
    assert.doesNotMatch(restore.stderr,/ERR_STRING_TOO_LONG/)
  } finally { fs.rmSync(directory,{recursive:true,force:true}) }
})
