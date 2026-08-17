import { readFile } from "node:fs/promises"
import path from "node:path"

function buildCrcTable() {
  const table = new Uint32Array(256)
  for (let index = 0; index < table.length; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
}

const CRC_TABLE = buildCrcTable()

function crc32(buffer: Buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function zipHeaders(name: string, content: Buffer, offset: number, modifiedAt: Date) {
  const nameBuffer = Buffer.from(name)
  const checksum = crc32(content)
  const { dosDate, dosTime } = dosDateTime(modifiedAt)
  const localHeader = Buffer.alloc(30 + nameBuffer.length)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0, 6)
  localHeader.writeUInt16LE(0, 8)
  localHeader.writeUInt16LE(dosTime, 10)
  localHeader.writeUInt16LE(dosDate, 12)
  localHeader.writeUInt32LE(checksum, 14)
  localHeader.writeUInt32LE(content.length, 18)
  localHeader.writeUInt32LE(content.length, 22)
  localHeader.writeUInt16LE(nameBuffer.length, 26)
  localHeader.writeUInt16LE(0, 28)
  nameBuffer.copy(localHeader, 30)

  const centralHeader = Buffer.alloc(46 + nameBuffer.length)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(0, 8)
  centralHeader.writeUInt16LE(0, 10)
  centralHeader.writeUInt16LE(dosTime, 12)
  centralHeader.writeUInt16LE(dosDate, 14)
  centralHeader.writeUInt32LE(checksum, 16)
  centralHeader.writeUInt32LE(content.length, 20)
  centralHeader.writeUInt32LE(content.length, 24)
  centralHeader.writeUInt16LE(nameBuffer.length, 28)
  centralHeader.writeUInt16LE(0, 30)
  centralHeader.writeUInt16LE(0, 32)
  centralHeader.writeUInt16LE(0, 34)
  centralHeader.writeUInt16LE(0, 36)
  centralHeader.writeUInt32LE(0, 38)
  centralHeader.writeUInt32LE(offset, 42)
  nameBuffer.copy(centralHeader, 46)
  return { localHeader, centralHeader }
}

export async function createStoredZip(input: {
  archiveRoot: string
  sourceDirectory: string
  files: readonly string[]
}) {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  const modifiedAt = new Date()
  let offset = 0

  for (const file of input.files) {
    const content = await readFile(path.join(input.sourceDirectory, file))
    const headers = zipHeaders(`${input.archiveRoot}/${file}`, content, offset, modifiedAt)
    localParts.push(headers.localHeader, content)
    centralParts.push(headers.centralHeader)
    offset += headers.localHeader.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(input.files.length, 8)
  endRecord.writeUInt16LE(input.files.length, 10)
  endRecord.writeUInt32LE(centralDirectory.length, 12)
  endRecord.writeUInt32LE(offset, 16)
  endRecord.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, centralDirectory, endRecord])
}
