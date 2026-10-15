import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

// The largest observed production snapshot is 3.28 MB and audit row is 3.18 MB.
// The largest snapshot contains 74,093 JSON values at depth four (14 Oct 2026).
// These limits leave substantial room for JSON escaping and future growth,
// while refusing a single adversarial row rather than exhausting the heap.
export const BACKUP_VALIDATION_LIMITS = Object.freeze({
  valueBytes: 32 * 1024 * 1024,
  cacheBytes: 8 * 1024 * 1024,
  depth: 512,
  sections: 256,
  metadataBytes: 32 * 1024 * 1024,
  structuralTokens: 500000,
  objectProperties: 250000,
  arrayElements: 250000,
})

let activeSpool = null
let nextSpoolIdentity = 1
function activateSpool(spool) { activeSpool = spool }
const rowReferences = new WeakMap()
const arrayReferences = new WeakMap()

function encode(value, spool) {
  spool.assertActive()
  const row = value && typeof value === "object" ? rowReferences.get(value) : null
  if (row) {
    row.spool.assertActive()
    if (row.spool !== spool) throw new Error("Foreign backup validation row owner")
    return ["row", spool.identity, row.section, row.index]
  }
  const array = value && typeof value === "object" ? arrayReferences.get(value) : null
  if (array) {
    array.spool.assertActive()
    if (array.spool !== spool) throw new Error("Foreign backup validation array owner")
    return ["view", spool.identity, array.id]
  }
  if (value === undefined) return ["undefined"]
  if (value === null) return ["null"]
  if (typeof value === "number") return ["number", Number.isNaN(value) ? "NaN" : value]
  if (typeof value === "string" || typeof value === "boolean") return [typeof value, value]
  if (Array.isArray(value)) return ["array", [...value].map(item => encode(item, spool))]
  if (typeof value === "object") return ["object", Object.entries(value).map(([key, item]) => [key, encode(item, spool)])]
  throw new Error("Unsupported value in backup validation index")
}

function decode(value, spool) {
  spool.assertActive()
  switch (value[0]) {
    case "row":
      if (value[1] !== spool.identity) throw new Error("Foreign backup validation row owner")
      return spool.row(value[2], value[3])
    case "view":
      if (value[1] !== spool.identity || !spool.views.has(value[2])) throw new Error("Foreign backup validation array owner")
      return spool.views.get(value[2])
    case "undefined": return undefined
    case "null": return null
    case "number": return value[1] === "NaN" ? NaN : value[1]
    case "string": case "boolean": return value[1]
    case "array": return value[1].map(item => decode(item, spool))
    case "object": return Object.fromEntries(value[1].map(([key, item]) => [key, decode(item, spool)]))
    default: throw new Error("Invalid temporary backup index value")
  }
}

function keyText(value, spool) {
  spool.assertActive()
  // Validator identity keys are scalar IDs/hashes. Ambiguous object keys must
  // not be silently coerced to the same identity by the disk index.
  if (value !== null && typeof value === "object") throw new Error("Object-valued backup identity is ambiguous")
  return JSON.stringify(encode(value, spool))
}

export class DiskMap {
  constructor(iterable = []) {
    if (!activeSpool) return new globalThis.Map(iterable)
    this.spool = activeSpool
    this.id = this.spool.nextCollection++
    for (const [key, value] of iterable) this.set(key, value)
  }
  get size() { this.spool.assertActive(); return this.spool.indexCount.get(this.id).count }
  has(key) { this.spool.assertActive(); return !!this.spool.indexGet.get(this.id, keyText(key, this.spool)) }
  get(key) {
    this.spool.assertActive()
    const row = this.spool.indexGet.get(this.id, keyText(key, this.spool))
    return row ? decode(JSON.parse(row.value), this.spool) : undefined
  }
  set(key, value) {
    this.spool.assertActive()
    this.spool.indexSet.run(this.id, keyText(key, this.spool), JSON.stringify(encode(value, this.spool)))
    return this
  }
  delete(key) { this.spool.assertActive(); return this.spool.indexDelete.run(this.id, keyText(key, this.spool)).changes > 0 }
  *entries() {
    this.spool.assertActive()
    for (const row of this.spool.indexEntries.iterate(this.id)) {
      this.spool.assertActive()
      yield [decode(JSON.parse(row.key), this.spool), decode(JSON.parse(row.value), this.spool)]
      this.spool.assertActive()
    }
  }
  *keys() { for (const [key] of this.entries()) yield key }
  *values() { for (const [, value] of this.entries()) yield value }
  [Symbol.iterator]() { return this.entries() }
}

export class DiskSet {
  constructor(iterable = []) {
    if (!activeSpool) return new globalThis.Set(iterable)
    this.map = new DiskMap()
    for (const value of iterable) this.add(value)
  }
  get size() { return this.map.size }
  add(value) { this.map.set(value, true); return this }
  has(value) { return this.map.has(value) }
  delete(value) { return this.map.delete(value) }
  values() { return this.map.keys() }
  keys() { return this.values() }
  *entries() { for (const value of this.values()) yield [value, value] }
  [Symbol.iterator]() { return this.values() }
}

class JsonReader {
  constructor(filePath, limits, onChunk) {
    this.iterator = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })[Symbol.asyncIterator]()
    this.decoder = new TextDecoder("utf-8", { fatal: true })
    this.buffer = ""
    this.position = 0
    this.done = false
    this.limits = limits
    this.onChunk = onChunk
  }
  async fill() {
    if (this.position < this.buffer.length) return true
    if (this.done) return false
    for (;;) {
      const result = await this.iterator.next()
      if (result.done) {
        this.done = true
        this.buffer = this.decoder.decode()
      } else {
        this.onChunk(result.value)
        this.buffer = this.decoder.decode(result.value, { stream: true })
      }
      this.position = 0
      if (this.buffer.length) return true
      if (this.done) return false
    }
  }
  async whitespace() {
    for (;;) {
      if (!await this.fill()) return
      while (this.position < this.buffer.length && /[\x20\x09\x0a\x0d]/.test(this.buffer[this.position])) this.position++
      if (this.position < this.buffer.length) return
    }
  }
  async peek() { await this.whitespace(); return await this.fill() ? this.buffer[this.position] : null }
  async expect(char) {
    if (await this.peek() !== char) throw new Error(`Invalid JSON: expected ${char}`)
    this.position++
  }
  async value(structureBudget = null) {
    await this.whitespace()
    if (!await this.fill()) throw new Error("Truncated JSON value")
    const first = this.buffer[this.position]
    const container = first === "{" || first === "["
    const quoted = first === '"'
    let depth = 0, inString = false, escaped = false, finished = false, bytes = 0
    const pieces = []
    while (!finished && await this.fill()) {
      const from = this.position
      while (this.position < this.buffer.length) {
        const char = this.buffer[this.position]
        if (!container && !quoted && /[\x20\x09\x0a\x0d,\]}]/.test(char)) { finished = true; break }
        this.position++
        if (inString) {
          if (escaped) escaped = false
          else if (char === "\\") escaped = true
          else if (char === '"') { inString = false; if (quoted && depth === 0) { finished = true; break } }
        } else if (char === '"') inString = true
        else if (char === "{" || char === "[") {
          depth++
          if (depth > this.limits.depth) throw new Error("JSON nesting exceeds the bounded validation depth")
        } else if (char === "}" || char === "]") {
          depth--
          if (container && depth === 0) { finished = true; break }
        }
      }
      const piece = this.buffer.slice(from, this.position)
      bytes += Buffer.byteLength(piece)
      if (bytes > this.limits.valueBytes) throw new Error("JSON row or metadata value exceeds the bounded validation size")
      pieces.push(piece)
    }
    if (inString || depth !== 0) throw new Error("Truncated JSON container or string")
    const raw = pieces.join("")
    if (!raw) throw new Error("Missing JSON value")
    // Duplicate names are ambiguous recovery input. JSON.parse would discard
    // earlier fields; detect them before any digest or semantic certification.
    return parseBoundedBackupJson(raw, this.limits, structureBudget)
  }
  async close() { await this.iterator.return?.() }
}

export function parseBoundedBackupJson(raw, limits = BACKUP_VALIDATION_LIMITS, structureBudget = null) {
  if (Buffer.byteLength(raw) > limits.valueBytes) throw new Error("JSON value exceeds the bounded validation size")
  const stack = []
  let inString = false, escaped = false, start = 0, justString = null, tokens = 0, properties = 0, elements = 0
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') { inString = false; justString = raw.slice(start, index + 1) }
      continue
    }
    if (char === '"') { inString = true; start = index; justString = null; tokens++ }
    else if (char === "{") { stack.push({ keys: new globalThis.Set() }); justString = null; tokens++ }
    else if (char === "[") { stack.push(null); justString = null; tokens++; elements++ }
    else if (char === "}" || char === "]") { stack.pop(); justString = null }
    else if (char === ":" && justString !== null && stack.at(-1)) {
      const key = JSON.parse(justString), frame = stack.at(-1)
      if (frame.keys.has(key)) throw new Error(`Duplicate JSON object key: ${key.slice(0, 100)}`)
      frame.keys.add(key)
      justString = null
      properties++
    } else if (!/[\x20\x09\x0a\x0d]/.test(char)) {
      if (char === ",") { tokens++; if (stack.length && !stack.at(-1)) elements++ }
      justString = null
    }
    if (stack.length > limits.depth || tokens > limits.structuralTokens || properties > limits.objectProperties || elements > limits.arrayElements) {
      throw new Error("JSON structure exceeds bounded validation complexity")
    }
  }
  if (structureBudget) {
    structureBudget.tokens += tokens
    structureBudget.properties += properties
    structureBudget.elements += elements
    if (structureBudget.tokens > limits.structuralTokens || structureBudget.properties > limits.objectProperties || structureBudget.elements > limits.arrayElements) {
      throw new Error("Cumulative backup metadata exceeds bounded validation complexity")
    }
  }
  return JSON.parse(raw, (_, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Non-finite JSON number is ambiguous recovery input")
    return value
  })
}

class ValidationSpool {
  constructor(limits) {
    if (activeSpool) throw new Error("Only one backup validation spool may be active in this process")
    this.limits = limits
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "fcuno-backup-validation-"))
    fs.chmodSync(this.directory, 0o700)
    this.dataPath = path.join(this.directory, "rows.json")
    this.fd = fs.openSync(this.dataPath, "wx+", 0o600)
    this.offset = 0
    this.identity = nextSpoolIdentity++
    this.nextCollection = 1
    this.nextView = 1
    this.views = new globalThis.Map()
    this.sections = new globalThis.Map()
    this.cache = new globalThis.Map()
    this.cacheBytes = 0
    this.peakCacheBytes = 0
    this.closed = false
    this.exitCleanup = () => this.close()
    this.sigintCleanup = () => { this.close(); process.exit(130) }
    this.sigtermCleanup = () => { this.close(); process.exit(143) }
    try {
    this.db = new DatabaseSync(path.join(this.directory, "indexes.sqlite"))
    fs.chmodSync(path.join(this.directory, "indexes.sqlite"), 0o600)
    this.db.exec("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-4096; CREATE TABLE rows(section TEXT, n INTEGER, offset INTEGER, bytes INTEGER, kind TEXT, PRIMARY KEY(section,n)); CREATE TABLE lists(collection INTEGER,n INTEGER,value TEXT,PRIMARY KEY(collection,n)); CREATE TABLE indexes(collection INTEGER,key TEXT,value TEXT,PRIMARY KEY(collection,key)); BEGIN")
    this.rowInsert = this.db.prepare("INSERT INTO rows VALUES(?,?,?,?,?)")
    this.rowGet = this.db.prepare("SELECT offset,bytes,kind FROM rows WHERE section=? AND n=?")
    this.listInsert = this.db.prepare("INSERT INTO lists VALUES(?,?,?)")
    this.listGet = this.db.prepare("SELECT value FROM lists WHERE collection=? AND n=?")
    this.indexGet = this.db.prepare("SELECT value FROM indexes WHERE collection=? AND key=?")
    this.indexSet = this.db.prepare("INSERT INTO indexes VALUES(?,?,?) ON CONFLICT(collection,key) DO UPDATE SET value=excluded.value")
    this.indexDelete = this.db.prepare("DELETE FROM indexes WHERE collection=? AND key=?")
    this.indexCount = this.db.prepare("SELECT count(*) AS count FROM indexes WHERE collection=?")
    this.indexEntries = this.db.prepare("SELECT key,value FROM indexes WHERE collection=? ORDER BY rowid")
    } catch (error) { this.close(); throw error }
    process.once("exit", this.exitCleanup)
    process.once("SIGINT", this.sigintCleanup)
    process.once("SIGTERM", this.sigtermCleanup)
    activateSpool(this)
  }
  assertActive() {
    if (this.closed) throw new Error("Backup validation spool is closed")
    if (activeSpool !== this) throw new Error("Foreign backup validation spool owner")
  }
  write(value) {
    this.assertActive()
    const bytes = Buffer.from(value)
    let written = 0
    while (written < bytes.length) written += fs.writeSync(this.fd, bytes, written, bytes.length - written, this.offset + written)
    const offset = this.offset
    this.offset += bytes.length
    return { offset, bytes: bytes.length }
  }
  append(section, index, value) {
    this.assertActive()
    const canonical = JSON.stringify(value), location = this.write(canonical)
    this.rowInsert.run(section, index, location.offset, location.bytes, value === null ? "null" : Array.isArray(value) ? "array" : typeof value)
    return canonical
  }
  parsed(section, index) {
    this.assertActive()
    const key = `${section}:${index}`
    const cached = this.cache.get(key)
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return cached.value }
    const row = this.rowGet.get(section, index)
    if (!row) return undefined
    const bytes = Buffer.allocUnsafe(row.bytes)
    let read = 0
    while (read < bytes.length) {
      const count = fs.readSync(this.fd, bytes, read, bytes.length - read, row.offset + read)
      if (!count) throw new Error("Temporary backup spool was truncated")
      read += count
    }
    let nodes = 0
    const value = JSON.parse(bytes.toString("utf8"), (_, item) => { nodes++; return item })
    // Tiny JSON properties cost more heap than their source bytes. Account for
    // that overhead rather than retaining eight MB of arbitrarily wide objects.
    const retainedCost = row.bytes * 2 + nodes * 128
    if (retainedCost <= this.limits.cacheBytes) {
      while (this.cacheBytes + retainedCost > this.limits.cacheBytes && this.cache.size) {
        const [oldKey, old] = this.cache.entries().next().value
        this.cache.delete(oldKey); this.cacheBytes -= old.bytes
      }
      this.cache.set(key, { value, bytes: retainedCost }); this.cacheBytes += retainedCost
      this.peakCacheBytes = Math.max(this.peakCacheBytes, this.cacheBytes)
    }
    return value
  }
  row(section, index) {
    this.assertActive()
    const record = this.rowGet.get(section, index)
    if (!record) return undefined
    if (record.kind !== "object") return this.parsed(section, index)
    const proxy = new Proxy({}, {
      get: (_, key) => this.parsed(section, index)?.[key],
      has: (_, key) => Object.hasOwn(this.parsed(section, index), key),
      ownKeys: () => Reflect.ownKeys(this.parsed(section, index)),
      getOwnPropertyDescriptor: (_, key) => Object.hasOwn(this.parsed(section, index), key)
        ? { configurable: true, enumerable: true, writable: false, value: this.parsed(section, index)[key] } : undefined,
      set: () => { throw new Error("Backup validation rows are read-only") },
    })
    rowReferences.set(proxy, { spool: this, section, index })
    return proxy
  }
  array(count, get) {
    this.assertActive()
    // Proxy callbacks have their own receiver; retain the owning spool, not it.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const spool = this
    const checkedGet = index => { spool.assertActive(); return get(index) }
    let proxy
    const methods = {
      *values() { spool.assertActive(); for (let index = 0; index < count; index++) { yield checkedGet(index); spool.assertActive() } },
      *entries() { spool.assertActive(); for (let index = 0; index < count; index++) { yield [index, checkedGet(index)]; spool.assertActive() } },
      at(index) { spool.assertActive(); const position = index < 0 ? count + index : index; return position >= 0 && position < count ? checkedGet(position) : undefined },
      map(callback, thisArg) {
        spool.assertActive()
        const id = spool.nextCollection++
        for (let index = 0; index < count; index++) spool.listInsert.run(id, index, JSON.stringify(encode(callback.call(thisArg, checkedGet(index), index, proxy), spool)))
        return spool.array(count, index => decode(JSON.parse(spool.listGet.get(id, index).value), spool))
      },
      filter(callback, thisArg) {
        spool.assertActive()
        const id = spool.nextCollection++; let length = 0
        for (let index = 0; index < count; index++) {
          const value = checkedGet(index)
          if (callback.call(thisArg, value, index, proxy)) spool.listInsert.run(id, length++, JSON.stringify(encode(value, spool)))
        }
        return spool.array(length, index => decode(JSON.parse(spool.listGet.get(id, index).value), spool))
      },
      some(callback, thisArg) { spool.assertActive(); for (let index = 0; index < count; index++) if (callback.call(thisArg, checkedGet(index), index, proxy)) { spool.assertActive(); return true }; spool.assertActive(); return false },
      every(callback, thisArg) { spool.assertActive(); for (let index = 0; index < count; index++) if (!callback.call(thisArg, checkedGet(index), index, proxy)) { spool.assertActive(); return false }; spool.assertActive(); return true },
    }
    proxy = new Proxy([], {
      get: (_, key) => { spool.assertActive(); return key === "length" ? count : key === Symbol.iterator ? methods.values : Object.hasOwn(methods, key) ? methods[key] : typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? checkedGet(Number(key)) : Array.prototype[key] },
      has: (_, key) => { spool.assertActive(); return typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) ? Number(key) < count : key in Array.prototype },
      set: () => { throw new Error("Backup validation arrays are read-only") },
    })
    const id = this.nextView++
    arrayReferences.set(proxy, { spool, id, count, get: checkedGet })
    this.views.set(id, proxy)
    return proxy
  }
  sectionArray(section, count) { return this.array(count, index => this.row(section, index)) }
  close() {
    if (this.closed) return
    this.closed = true
    process.removeListener("exit", this.exitCleanup)
    process.removeListener("SIGINT", this.sigintCleanup)
    process.removeListener("SIGTERM", this.sigtermCleanup)
    if (activeSpool === this) activeSpool = null
    this.cache.clear()
    this.views.clear()
    try { this.db?.close() }
    finally {
      try { fs.closeSync(this.fd) }
      finally { fs.rmSync(this.directory, { recursive: true, force: true }) }
    }
  }
}

async function object(reader, value, target, onValue) {
  await reader.expect("{")
  if (await reader.peek() === "}") { reader.position++; return target }
  const keys = new globalThis.Set()
  for (;;) {
    const key = await reader.value()
    if (typeof key !== "string") throw new Error("JSON object key must be a string")
    if (keys.size >= reader.limits.sections || key.length > 1024) throw new Error("Backup object has too many or overlong keys")
    if (keys.has(key)) throw new Error(`Duplicate JSON object key: ${key.slice(0, 100)}`)
    keys.add(key)
    await reader.expect(":")
    const item = await value(key)
    Object.defineProperty(target, key, { enumerable: true, configurable: true, writable: true, value: item })
    onValue?.(key, item)
    const delimiter = await reader.peek()
    if (delimiter === "}") { reader.position++; return target }
    await reader.expect(",")
  }
}

export async function readBackupForValidation(filePath, options = {}) {
  const limits = { ...BACKUP_VALIDATION_LIMITS, ...options.limits }
  const spool = new ValidationSpool(limits)
  const fileHash = createHash("sha256")
  let fileBytes = 0, metadataBytes = 0
  const metadataStructure = { tokens: 0, properties: 0, elements: 0 }
  const reader = new JsonReader(filePath, limits, chunk => { fileHash.update(chunk); fileBytes += chunk.length })
  try {
    const backup = await object(reader, async key => {
      if (key !== "data" || await reader.peek() !== "{") {
        const value = await reader.value(metadataStructure)
        metadataBytes += Buffer.byteLength(JSON.stringify(value))
        if (metadataBytes > limits.metadataBytes) throw new Error("Backup metadata exceeds the bounded validation size")
        return value
      }
      return object(reader, async section => {
        if (spool.sections.size >= limits.sections || section.length > 1024) throw new Error("Backup has too many or overlong data sections")
        if (await reader.peek() !== "[") throw new Error(`Backup data section ${section} is not an array`)
        await reader.expect("[")
        const start = spool.offset
        spool.write("[")
        const hash = createHash("sha256").update("[")
        let count = 0
        if (await reader.peek() !== "]") for (;;) {
          const value = await reader.value()
          if (count) { spool.write(","); hash.update(",") }
          hash.update(spool.append(section, count++, value))
          const delimiter = await reader.peek()
          if (delimiter === "]") break
          await reader.expect(",")
        }
        await reader.expect("]")
        spool.write("]"); hash.update("]")
        spool.sections.set(section, { start, bytes: spool.offset - start, count, sha256: hash.digest("hex") })
        return spool.sectionArray(section, count)
      }, {})
    }, {})
    if (await reader.peek() !== null) throw new Error("Unexpected trailing data after backup JSON")
    return { backup, spool, fileSha256: fileHash.digest("hex"), fileBytes, close: () => spool.close() }
  } catch (error) { spool.close(); throw error }
  finally { await reader.close() }
}

export function hashValidationValue(value) {
  const hash = createHash("sha256")
  function visit(item) {
    const array = item && typeof item === "object" ? arrayReferences.get(item) : null
    if (array) {
      array.spool.assertActive()
      hash.update("[")
      for (let index = 0; index < array.count; index++) { if (index) hash.update(","); visit(array.get(index)) }
      hash.update("]")
      return
    }
    const row = item && typeof item === "object" ? rowReferences.get(item) : null
    if (row) {
      row.spool.assertActive()
      const record = row.spool.rowGet.get(row.section, row.index)
      const buffer = Buffer.allocUnsafe(Math.min(record.bytes, 64 * 1024))
      for (let done = 0; done < record.bytes;) {
        const count = fs.readSync(row.spool.fd, buffer, 0, Math.min(buffer.length, record.bytes - done), record.offset + done)
        if (!count) throw new Error("Temporary backup spool was truncated")
        hash.update(buffer.subarray(0, count)); done += count
      }
      return
    }
    if (item && typeof item === "object") {
      if (Array.isArray(item)) {
        hash.update("[")
        for (let index = 0; index < item.length; index++) { if (index) hash.update(","); visit(item[index] === undefined ? null : item[index]) }
        hash.update("]")
      } else {
        hash.update("{")
        let first = true
        for (const key of Object.keys(item)) {
          if (item[key] === undefined) continue
          if (!first) hash.update(",")
          first = false
          hash.update(JSON.stringify(key)); hash.update(":"); visit(item[key])
        }
        hash.update("}")
      }
    } else hash.update(JSON.stringify(item))
  }
  visit(value)
  return hash.digest("hex")
}

export function sortedValidationRows(values, numericKey) {
  const array = arrayReferences.get(values)
  if (!array) return [...values].sort((a, b) => numericKey(a) - numericKey(b))
  array.spool.assertActive()
  const spool = array.spool, id = spool.nextCollection++
  spool.db.exec(`CREATE TABLE sort_${id}(n INTEGER PRIMARY KEY,sort_value REAL,value TEXT); CREATE INDEX sort_order_${id} ON sort_${id}(sort_value,n)`)
  const insert = spool.db.prepare(`INSERT INTO sort_${id} VALUES(?,?,?)`)
  for (let index = 0; index < array.count; index++) {
    const value = array.get(index), number = numericKey(value)
    insert.run(index, Number.isFinite(number) ? number : null, JSON.stringify(encode(value, spool)))
  }
  // Invalid sort fields are already rejected by semantic checks; putting them
  // first is deterministic and cannot turn a malformed row into a valid one.
  const sortedId = spool.nextCollection++
  spool.db.prepare(`INSERT INTO lists SELECT ?,row_number() OVER(ORDER BY sort_value,n)-1,value FROM sort_${id}`).run(sortedId)
  spool.db.exec(`DROP TABLE sort_${id}`)
  return spool.array(array.count, index => { const row = spool.listGet.get(sortedId, index); return row ? decode(JSON.parse(row.value), spool) : undefined })
}
