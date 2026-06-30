import { NextResponse } from "next/server"
import { requireSpcPagePermission } from "@/lib/spcAuth"

export const dynamic = "force-dynamic"

const SUPPLIER_SHEET_CSV =
  "https://docs.google.com/spreadsheets/d/1SIyBc1hl29gVwCxBQDsz-gK0bfZe36RDDgiDDIFfGTg/export?format=csv&gid=0"

const FALLBACK_SUPPLIERS = [
  "PETRONAS",
  "GLOBAL MARINE TRANSPORT",
  "HYUNDAI",
  "EASTPAC",
  "PERTAMINA",
  "CNC PETROLEUM",
  "TFG MARINE",
  "CHEVRON",
  "SK ENERGY",
  "SHELL",
  "MAERSK",
]

function firstCsvCell(line: string) {
  const source = line.trim()
  if (!source) return ""
  if (!source.startsWith('"')) return source.split(",")[0]?.trim() || ""

  let cell = ""
  for (let index = 1; index < source.length; index += 1) {
    const char = source[index]
    const next = source[index + 1]
    if (char === '"' && next === '"') {
      cell += '"'
      index += 1
      continue
    }
    if (char === '"') break
    cell += char
  }
  return cell.trim()
}

function parseSupplierCsv(csv: string) {
  const seen = new Set<string>()
  const suppliers: string[] = []

  csv.split(/\r?\n/).forEach((line) => {
    const supplier = firstCsvCell(line)
    const key = supplier.toLowerCase()
    if (!supplier || seen.has(key)) return
    seen.add(key)
    suppliers.push(supplier)
  })

  return suppliers
}

export async function GET() {
  try {
    await requireSpcPagePermission("spc-fixtures", "view")
    let suppliers = FALLBACK_SUPPLIERS

    try {
      const response = await fetch(SUPPLIER_SHEET_CSV, { cache: "no-store" })
      if (response.ok) {
        const parsed = parseSupplierCsv(await response.text())
        if (parsed.length > 0) suppliers = parsed
      }
    } catch {
      suppliers = FALLBACK_SUPPLIERS
    }

    return NextResponse.json(
      { suppliers },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load suppliers."
    return NextResponse.json(
      { message },
      { status: message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500 },
    )
  }
}
