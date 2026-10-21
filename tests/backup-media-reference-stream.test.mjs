import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import test from "node:test"
import * as parser from "../lib/backupValidationSpool.mjs"

const hash = value => createHash("sha256").update(value).digest("hex")
const chunk = (id = "chunk-a", extra = {}) => ({ id, video_path: "chunk-a/video.mp4", video_bytes: 3, narration_path: null, narration_bytes: null, ...extra })
const receipt = raw => ({ uploadedFileSha256: hash(raw), fileByteLength: Buffer.byteLength(raw) })
const backup = rows => ({ schemaVersion: 2, data: { auditLogs: [{ ignored: true }], spcPresentationChunks: rows }, integrity: { artifactSha256: "a".repeat(64), truth: { checkpointAfterExport: { headSequence: 7 } } } })
async function* bytes(raw, width = 7) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
  for (let offset = 0; offset < buffer.length; offset += width) yield buffer.subarray(offset, offset + width)
}
async function extract(raw, options) { return parser.extractBackupMediaReferences(bytes(raw), receipt(raw), options) }

function recordStatePresentationFixture() {
  // Read just the existing fixture's data declaration, without importing its
  // route/esbuild harness or adding any transport/provider dependency here.
  const source = fs.readFileSync(new URL("./fixtures/spc-record-state-api.mjs", import.meta.url), "utf8")
  const declaration = source.match(/^export const presentationRow=(\{.*\})$/m)
  assert.ok(declaration, "Existing record-state presentation fixture declaration")
  return new Function("recordVersion", `return (${declaration[1]})`)("2026-10-14T01:02:03.123456Z")
}

test("supported record-state fixture accepts absent media with null, numeric zero and canonical string zero", async context => {
  const fixture = recordStatePresentationFixture()
  assert.equal(fixture.narration_path, null)
  assert.equal(fixture.narration_bytes, 0)
  for (const kind of ["video", "narration"]) for (const size of [null, 0, "0"]) {
    await context.test(`${kind}: null path and ${JSON.stringify(size)} size`, async () => {
      const other = kind === "video" ? "narration" : "video"
      const row = { ...fixture, [`${other}_path`]: fixture[`${other}_path`] ?? `${fixture.id}/${other}.m4a`, [`${other}_bytes`]: 100, [`${kind}_path`]: null, [`${kind}_bytes`]: size }
      const raw = JSON.stringify(backup([row]))
      let closed = false
      async function* source() { try { yield* bytes(raw) } finally { closed = true } }
      try {
        const output = await parser.extractBackupMediaReferences(source(), receipt(raw))
        assert.deepEqual(output.references, [{ chunkId: fixture.id, kind: other, path: row[`${other}_path`], expectedBytes: 100 }])
        assert.equal(output.sectionSha256, hash(JSON.stringify([row])))
        assert.equal(output.fileSha256, hash(raw))
        assert.equal(output.fileBytes, Buffer.byteLength(raw))
      } finally { assert.equal(closed, true) }
    })
  }
})

test("fixture-derived empty media shapes do not admit inconsistent, missing or noncanonical sizes", async () => {
  const fixture = recordStatePresentationFixture()
  for (const kind of ["video", "narration"]) {
    const other = kind === "video" ? "narration" : "video"
    const base = { ...fixture, [`${other}_path`]: null, [`${other}_bytes`]: null }
    const invalid = [
      ...[undefined, 1, "1", -1, "-1", "00", "0.0", "-0", "+0", " 0", "0 ", "0e0", false, "", {}].map(size => ({ ...base, [`${kind}_path`]: null, [`${kind}_bytes`]: size })),
      ...[null, undefined, 0, "0", -1, "-1", "00"].map(size => ({ ...base, [`${kind}_path`]: `${fixture.id}/${kind}.m4a`, [`${kind}_bytes`]: size })),
      ...[null, 0, "0"].map(size => ({ ...base, [`${kind}_path`]: undefined, [`${kind}_bytes`]: size })),
    ]
    for (const row of invalid) {
      const raw = JSON.stringify(backup([row]))
      let closed = false
      async function* source() { try { yield* bytes(raw) } finally { closed = true } }
      await assert.rejects(parser.extractBackupMediaReferences(source(), receipt(raw)))
      assert.equal(closed, true)
    }
    const negativeZero = JSON.stringify(backup([{ ...base, [`${kind}_path`]: null, [`${kind}_bytes`]: 0 }])).replace(`"${kind}_bytes":0`, `"${kind}_bytes":-0`)
    await assert.rejects(extract(negativeZero))
  }
})

test("reference extractor authenticates the entire async stream before returning only selected bounded references", async () => {
  assert.equal(typeof parser.extractBackupMediaReferences, "function")
  const rows = [chunk("chunk-é🚢", { video_path: "chunk-é🚢/video.mp4", narration_path: "chunk-é🚢/narration.m4a", narration_bytes: "5" })]
  const input = backup(rows), raw = JSON.stringify(input, null, 2)
  const output = await extract(raw)
  assert.deepEqual(output.references, [
    { chunkId: "chunk-é🚢", kind: "video", path: "chunk-é🚢/video.mp4", expectedBytes: 3 },
    { chunkId: "chunk-é🚢", kind: "narration", path: "chunk-é🚢/narration.m4a", expectedBytes: 5 },
  ])
  const { data, ...metadata } = input
  assert.deepEqual(output.metadata, metadata)
  assert.equal(output.chunkCount, 1)
  assert.equal(output.sectionSha256, hash(JSON.stringify(rows)))
  assert.equal(output.fileSha256, hash(raw))
  assert.equal(output.fileBytes, Buffer.byteLength(raw))
  assert.notEqual(output.fileSha256, output.metadata.integrity.artifactSha256)
  assert.equal(Object.hasOwn(output.metadata, "data"), false)
})

test("raw SHA, canonical trusted length, EOF and stream completion cannot be substituted by JSON-equivalent bytes", async () => {
  const raw = JSON.stringify(backup([chunk()])), trusted = receipt(raw)
  for (const [input, expected] of [
    [raw + " ", trusted], [raw, { ...trusted, uploadedFileSha256: "0".repeat(64) }],
    [raw, { ...trusted, fileByteLength: trusted.fileByteLength - 1 }],
    [raw, { ...trusted, fileByteLength: trusted.fileByteLength + 1 }],
    [raw, { ...trusted, fileByteLength: "01" }], [raw, { ...trusted, fileByteLength: 1.5 }],
    [raw, { ...trusted, uploadedFileSha256: "A".repeat(64) }],
    [raw + "{}", receipt(raw + "{}")],
  ]) await assert.rejects(parser.extractBackupMediaReferences(bytes(input), expected))
  const result = await parser.extractBackupMediaReferences(bytes(raw), { ...trusted, fileByteLength: String(trusted.fileByteLength) })
  assert.equal(result.fileSha256, trusted.uploadedFileSha256)
  let returned = false
  async function* failedAfterJson() { try { yield Buffer.from(raw); throw new Error("synthetic stream failure after JSON") } finally { returned = true } }
  await assert.rejects(parser.extractBackupMediaReferences(failedAfterJson(), trusted), /synthetic stream failure/)
  assert.equal(returned, true)
})

test("references remain unavailable until EOF and invalid receipts do not acquire the source", async () => {
  const raw = JSON.stringify(backup([chunk()]))
  let releaseEof, reachedEof, settled = false
  const eofGate = new Promise(resolve => { releaseEof = resolve })
  const waitingForEof = new Promise(resolve => { reachedEof = resolve })
  async function* source() { yield Buffer.from(raw); reachedEof(); await eofGate }
  const pending = parser.extractBackupMediaReferences(source(), receipt(raw)).finally(() => { settled = true })
  await waitingForEof
  await Promise.resolve()
  assert.equal(settled, false)
  releaseEof()
  assert.equal((await pending).references.length, 1)
  let acquired = false
  const untouched = { [Symbol.asyncIterator]() { acquired = true; throw new Error("Should not acquire untrusted source") } }
  await assert.rejects(parser.extractBackupMediaReferences(untouched, { uploadedFileSha256: "invalid", fileByteLength: 1 }), /SHA-256/)
  assert.equal(acquired, false)
})

test("malformed, truncated, invalid UTF8, duplicate keys and invalid ignored rows all fail closed", async () => {
  const valid = JSON.stringify(backup([chunk()]))
  const inputs = [
    valid.slice(0, -1), valid.replace('"ignored":true', '"ignored":true,"ignored":false'),
    valid.replace('"id":"chunk-a"', '"id":"chunk-a","id":"other"'),
    valid.replace('"data":{', '"data":{"auditLogs":[], '),
    valid.replace('"schemaVersion":2', '"schemaVersion":2,"schemaVersion":2'),
    valid.replace('"auditLogs":[{"ignored":true}]', '"auditLogs":[1,]'),
    valid.replace('"ignored":true', '"ignored":1e400'), valid.replace('"ignored":true', '"ignored":"\\q"'),
    valid.replace('"spcPresentationChunks":[', '"spcPresentationChunks":false,"other":['),
    '{"data":{}}', '{"data":[]}', '{"data":{"spcPresentationChunks":[]},"data":{}}',
    Buffer.concat([Buffer.from('{"data":{"auditLogs":["'), Buffer.from([0xf0, 0x28, 0x8c, 0x28]), Buffer.from('"]}}')]),
  ]
  for (const input of inputs) await assert.rejects(extract(input))
  // Every byte boundary includes split multibyte UTF8; the fatal decoder must
  // accept valid boundaries rather than hashing decoded/re-encoded text.
  const unicode = JSON.stringify(backup([chunk("é🚢")]))
  const output = await parser.extractBackupMediaReferences(bytes(unicode, 1), receipt(unicode))
  assert.equal(output.references[0].chunkId, "é🚢")
})

test("chunk identity, exact paths, sizes, conflicting expectations and bounded collection are checked", async () => {
  for (const rows of [
    [null], [false], [[]], [chunk("")], [chunk(" x")], [chunk("bad\n")], [chunk("\ud800")], [chunk(), chunk()],
    [chunk("a", { video_path: "../video.mp4" })], [chunk("a", { video_path: "/video.mp4" })],
    [chunk("a", { video_path: "a//video.mp4" })], [chunk("a", { video_path: "a\\video.mp4" })],
    [chunk("a", { video_path: "a/./video.mp4" })], [chunk("a", { video_path: "a/vi\u0000deo.mp4" })],
    [chunk("a", { video_path: "a/\ud800.mp4" })],
    [chunk("a", { video_path: "x".repeat(1025) })], [chunk("a", { video_path: 1 })],
    [chunk("a", { video_bytes: 0 })], [chunk("a", { video_bytes: "01" })], [chunk("a", { video_bytes: -1 })],
    [chunk("a", { video_bytes: 1.5 })], [chunk("a", { video_bytes: Number.MAX_SAFE_INTEGER + 1 })],
    [chunk("a", { video_path: null, video_bytes: 3 })], [chunk("a", { video_bytes: null })],
    [chunk("a"), chunk("b", { video_bytes: 4 })],
  ]) await assert.rejects(extract(JSON.stringify(backup(rows))))
  const same = await extract(JSON.stringify(backup([chunk("a"), chunk("b")])))
  assert.equal(same.references.length, 2)
  for (const [limits, raw] of [
    [{ chunkRows: 1 }, JSON.stringify(backup([chunk("a"), chunk("b")]))],
    [{ references: 1 }, JSON.stringify(backup([chunk("a"), chunk("b")]))],
    [{ referenceBytes: 1 }, JSON.stringify(backup([chunk()]))],
    [{ valueBytes: 128 }, JSON.stringify(backup([chunk("a", { ignored: "x".repeat(129) })]))],
    [{ valueBytes: 128 }, JSON.stringify({ data: { auditLogs: [{ ignored: "x".repeat(129) }], spcPresentationChunks: [] } })],
    [{ metadataBytes: 1 }, JSON.stringify(backup([]))],
    [{ structuralTokens: 4 }, JSON.stringify(backup([chunk()]))],
  ]) await assert.rejects(extract(raw, { limits }), /bound|exceeds/)
  await assert.rejects(extract(JSON.stringify(backup([])), { limits: { references: Infinity } }), /limit/)
})

test("abort, malformed input and invalid chunks close the owned source", async () => {
  const raw = JSON.stringify(backup([chunk()]))
  for (const mode of ["abort", "invalid", "nonbytes", "oversized-chunk"]) {
    const controller = new AbortController()
    let closed = false
    async function* source() {
      try {
        if (mode === "abort") { yield Buffer.from(raw.slice(0, 8)); controller.abort(new Error("synthetic abort")); yield Buffer.from(raw.slice(8)) }
        else if (mode === "invalid") yield Buffer.from("{not-json}")
        else if (mode === "nonbytes") yield raw
        else yield Buffer.alloc(parser.BACKUP_MEDIA_REFERENCE_LIMITS.inputChunkBytes + 1)
      } finally { closed = true }
    }
    await assert.rejects(parser.extractBackupMediaReferences(source(), receipt(raw), { signal: controller.signal }))
    assert.equal(closed, true, mode)
  }
})

test("reference extraction performs no temporary row, SQLite, or artifact filesystem writes", async () => {
  const originals = new Map(["mkdtempSync", "mkdirSync", "openSync", "writeSync", "writeFileSync"].map(name => [name, fs[name]]))
  try {
    for (const name of originals.keys()) fs[name] = () => { throw new Error(`Unexpected filesystem mutation: ${name}`) }
    const output = await extract(JSON.stringify(backup([chunk()])))
    assert.equal(output.references.length, 1)
  } finally { for (const [name, original] of originals) fs[name] = original }
})

test("a cooperative transport abort while waiting for bytes closes the pending iterator", async () => {
  const controller = new AbortController(), raw = JSON.stringify(backup([chunk()]))
  let waiting, closed = false
  const transportWaiting = new Promise(resolve => { waiting = resolve })
  async function* source() {
    try {
      yield Buffer.from(raw.slice(0, 8))
      await new Promise((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true })
        waiting()
      })
    } finally { closed = true }
  }
  const pending = parser.extractBackupMediaReferences(source(), receipt(raw), { signal: controller.signal })
  await transportWaiting
  controller.abort(new Error("synthetic pending transport abort"))
  await assert.rejects(pending, /synthetic pending transport abort/)
  assert.equal(closed, true)
})

function processTreeRss(rootPid) {
  const sample = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 })
  assert.equal(sample.status, 0, sample.stderr)
  const rows = sample.stdout.trim().split("\n").map(line => line.trim().split(/\s+/).map(Number))
  const pids = new Set([rootPid])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, ppid] of rows) if (pids.has(ppid) && !pids.has(pid)) { pids.add(pid); changed = true }
  }
  return rows.reduce((total, [pid, , rss]) => total + (pids.has(pid) ? rss : 0), 0)
}

test("synthetic >2GiB reference extraction stays bounded under a 64MiB heap without artifact or spool writes", { skip: process.env.FCUNO_MEDIA_REFERENCE_SCALE_TEST !== "1", timeout: 300000 }, async () => {
  const moduleUrl = new URL("../lib/backupValidationSpool.mjs", import.meta.url).href
  const source = `
    import { createHash } from 'node:crypto';
    import fs from 'node:fs';
    import { extractBackupMediaReferences } from ${JSON.stringify(moduleUrl)};
    const prefix=Buffer.from('{"data":{"auditLogs":['), row=Buffer.from(JSON.stringify({ignored:'A'.repeat(65500)}));
    const count=32790, comma=Buffer.from(','), suffix=Buffer.from('],"spcPresentationChunks":[{"id":"synthetic","video_path":"synthetic/video.mp4","video_bytes":3,"narration_path":null,"narration_bytes":0}]}}');
    let byteLength=prefix.length+suffix.length+row.length*count+count-1;
    if(byteLength<=2**31)throw new Error('Scale input is not >2GiB');
    const sha=createHash('sha256').update(prefix);for(let n=0;n<count;n++){if(n)sha.update(comma);sha.update(row)}sha.update(suffix);
    let generated=0,closed=false;
    async function* input(){try{generated+=prefix.length;yield prefix;for(let n=0;n<count;n++){if(n){generated++;yield comma}generated+=row.length;yield row}generated+=suffix.length;yield suffix}finally{closed=true}}
    let filesystemWriteCalls=0;for(const method of ['mkdtempSync','mkdirSync','openSync','writeSync','writeFileSync'])fs[method]=()=>{filesystemWriteCalls++;throw new Error('Forbidden filesystem write: '+method)};
    const output=await extractBackupMediaReferences(input(),{uploadedFileSha256:sha.digest('hex'),fileByteLength:byteLength});
    if(output.references.length!==1||output.fileBytes!==byteLength||generated!==byteLength||!closed)throw new Error('Scale extraction mismatch');
    console.log(JSON.stringify({byteLength,generated,references:output.references.length,closed,filesystemWriteCalls,maxRssKiB:process.resourceUsage().maxRSS,heapLimitMiB:64}));
  `
  const child = spawn(process.execPath, ["--max-old-space-size=64", "--input-type=module", "-e", source], { stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = "", peakTreeRssKiB = processTreeRss(process.pid)
  child.stdout.on("data", value => { stdout += value })
  child.stderr.on("data", value => { stderr += value })
  const timer = setInterval(() => { peakTreeRssKiB = Math.max(peakTreeRssKiB, processTreeRss(process.pid)) }, 1000)
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve) })
    assert.equal(code, 0, stdout + stderr)
    const evidence = JSON.parse(stdout.trim())
    assert.ok(evidence.byteLength > 2 ** 31)
    assert.equal(evidence.filesystemWriteCalls, 0)
    assert.ok(evidence.maxRssKiB < 256 * 1024, JSON.stringify(evidence))
    assert.ok(peakTreeRssKiB < 512 * 1024, `Peak sampled test process-tree RSS ${peakTreeRssKiB}KiB`)
    console.log(JSON.stringify({ ...evidence, peakSampledProcessTreeRssKiB: peakTreeRssKiB, sampleIntervalMs: 1000, artifactBytesWritten: 0, spoolBytesWritten: 0 }))
  } finally { clearInterval(timer); if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL") }
})
