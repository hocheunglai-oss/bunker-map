import { readFile } from "node:fs/promises"
import path from "node:path"
import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"

export const runtime = "nodejs"

const ARCHIVE_ROOT = "fcuno-spc-whatsapp-board"
const EXTENSION_DIR = path.join(process.cwd(), "tools", "whatsapp-spc-speed-board")
const EXTENSION_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "styles.css",
  "spc-sidebar-logo.png",
  "spc-enquiry-chat-button.png",
  "README.md",
] as const

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
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function dosDateTime(date: Date) {
  const year = Math.max(date.getFullYear(), 1980)
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2)
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { dosDate, dosTime }
}

function writeZipFileHeader(
  name: string,
  content: Buffer,
  offset: number,
  modifiedAt: Date,
) {
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

async function createExtensionZip() {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  const modifiedAt = new Date()

  for (const file of EXTENSION_FILES) {
    const content = await readFile(path.join(EXTENSION_DIR, file))
    const archiveName = `${ARCHIVE_ROOT}/${file}`
    const { localHeader, centralHeader } = writeZipFileHeader(
      archiveName,
      content,
      offset,
      modifiedAt,
    )

    localParts.push(localHeader, content)
    centralParts.push(centralHeader)
    offset += localHeader.length + content.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const centralDirectoryOffset = offset
  const endRecord = Buffer.alloc(22)
  endRecord.writeUInt32LE(0x06054b50, 0)
  endRecord.writeUInt16LE(0, 4)
  endRecord.writeUInt16LE(0, 6)
  endRecord.writeUInt16LE(EXTENSION_FILES.length, 8)
  endRecord.writeUInt16LE(EXTENSION_FILES.length, 10)
  endRecord.writeUInt32LE(centralDirectory.length, 12)
  endRecord.writeUInt32LE(centralDirectoryOffset, 16)
  endRecord.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, centralDirectory, endRecord])
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-chrome-extension", "view")
    const zip = await createExtensionZip()

    return new Response(zip, {
      headers: {
        "Cache-Control": "no-store",
        "Content-Disposition": 'attachment; filename="fcuno-spc-whatsapp-board.zip"',
        "Content-Length": String(zip.length),
        "Content-Type": "application/zip",
      },
    })
  } catch (error) {
    if (error instanceof Error && ["Unauthorized", "Forbidden"].includes(error.message)) {
      return NextResponse.json(
        { message: error.message },
        { status: error.message === "Unauthorized" ? 401 : 403 },
      )
    }

    return NextResponse.json(
      { message: error instanceof Error ? error.message : "Failed to download extension." },
      { status: 500 },
    )
  }
}
