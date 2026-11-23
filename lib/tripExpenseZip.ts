type ZipEntry = {
  name: string
  start: number
  compressed: number
  size: number
  method: number
  crc: number
}

const decoder = new TextDecoder()
const checksumTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  return value
})

function invalidZip(): never {
  throw new Error("This ZIP is damaged or uses an unsupported format.")
}

// The directory provides sizes even for ZIPs that put them in data
// descriptors. Names stay in memory and are never used as filesystem paths.
export function readTripZipDirectory(
  bytes: Uint8Array<ArrayBuffer>,
  limits: { entries: number; entryBytes: number; totalBytes: number },
) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u16 = (offset: number) => view.getUint16(offset, true)
  const u32 = (offset: number) => view.getUint32(offset, true)
  let end = bytes.length - 22
  const earliest = Math.max(0, end - 65_535)
  while (end >= earliest && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)) end--
  if (end < earliest || u16(end + 4) !== 0 || u16(end + 6) !== 0) invalidZip()
  const count = u16(end + 10)
  if (u16(end + 8) !== count || count > limits.entries) throw new Error("This ZIP contains too many files.")
  const directory = u32(end + 16)
  if (directory + u32(end + 12) !== end) invalidZip()

  const entries: ZipEntry[] = []
  let next = directory
  let total = 0
  for (let index = 0; index < count; index++) {
    if (next + 46 > end || u32(next) !== 0x02014b50) invalidZip()
    const flags = u16(next + 8)
    const method = u16(next + 10)
    if ((flags & 1) || (method !== 0 && method !== 8) || u16(next + 34) !== 0) invalidZip()
    const nameLength = u16(next + 28)
    const after = next + 46 + nameLength + u16(next + 30) + u16(next + 32)
    if (after > end || !nameLength) invalidZip()
    const name = decoder.decode(bytes.subarray(next + 46, next + 46 + nameLength))
    const parts = name.split("/")
    if (parts.some(part => part === "..") || name.startsWith("/") || /[\\\x00-\x1f]/.test(name)) invalidZip()
    const compressed = u32(next + 20)
    const size = u32(next + 24)
    const crc = u32(next + 16)
    const local = u32(next + 42)
    if (local + 30 > directory || u32(local) !== 0x04034b50 || u16(local + 6) !== flags ||
        u16(local + 8) !== method || u16(local + 26) !== nameLength ||
        decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== name) invalidZip()
    if (!(flags & 8) && (u32(local + 14) !== crc || u32(local + 18) !== compressed || u32(local + 22) !== size)) invalidZip()
    const start = local + 30 + nameLength + u16(local + 28)
    if (start + compressed > directory || (method === 0 && compressed !== size)) invalidZip()
    const unixType = (u32(next + 38) >>> 16) & 0xf000
    if (unixType === 0xa000) invalidZip()
    total += size
    if (size > limits.entryBytes || total > limits.totalBytes) throw new Error("This ZIP expands beyond the upload limits.")
    if (!name.endsWith("/")) entries.push({ name, start, compressed, size, method, crc })
    next = after
  }
  if (next !== end) invalidZip()
  return entries
}

export async function readTripZipEntry(archive: Uint8Array<ArrayBuffer>, entry: ZipEntry) {
  const compressed = archive.subarray(entry.start, entry.start + entry.compressed)
  const bytes = entry.method === 0 ? compressed.slice() : new Uint8Array(entry.size)
  if (entry.method === 8) {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
    const reader = stream.getReader()
    let offset = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (offset + value.length > bytes.length) {
          await reader.cancel()
          invalidZip()
        }
        bytes.set(value, offset)
        offset += value.length
      }
      if (offset !== bytes.length) invalidZip()
    } finally {
      reader.releaseLock()
    }
  }

  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ checksumTable[(crc ^ byte) & 255]
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) invalidZip()
  return bytes
}
