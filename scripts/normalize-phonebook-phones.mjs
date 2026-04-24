import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const PROJECT_ROOT = process.cwd()

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(PROJECT_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

function normalizeDialablePhone(value) {
  const trimmed = (value || "").trim()
  if (!trimmed) return null
  if (trimmed.startsWith("+")) return trimmed
  if (/^00\d/.test(trimmed)) return `+${trimmed.slice(2)}`

  const digits = trimmed.replace(/[^\d]/g, "")
  const looksLikeHongKongLocal =
    digits.length === 8 && !trimmed.includes("-") && !trimmed.includes("(") && !trimmed.includes(")")

  if (looksLikeHongKongLocal) return digits
  if (/^\d{1,4}-/.test(trimmed)) return `+${trimmed}`
  return trimmed
}

async function loadAllContacts(supabase) {
  const rows = []
  let from = 0
  const pageSize = 1000

  while (true) {
    const { data, error } = await supabase
      .from("phonebook_contacts")
      .select("id,direct_line,mobile_1,mobile_2,mobile_phone,pager,business_phone,other_phone")
      .range(from, from + pageSize - 1)

    if (error) throw error
    const batch = data || []
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }

  return rows
}

async function main() {
  const env = loadEnv()
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)

  const contacts = await loadAllContacts(supabase)
  let changed = 0

  for (const contact of contacts) {
    const payload = {
      direct_line: normalizeDialablePhone(contact.direct_line),
      mobile_1: normalizeDialablePhone(contact.mobile_1),
      mobile_2: normalizeDialablePhone(contact.mobile_2),
      mobile_phone: normalizeDialablePhone(contact.mobile_phone),
      pager: normalizeDialablePhone(contact.pager),
      business_phone: normalizeDialablePhone(contact.business_phone),
      other_phone: normalizeDialablePhone(contact.other_phone),
    }

    const differs =
      payload.direct_line !== (contact.direct_line || null) ||
      payload.mobile_1 !== (contact.mobile_1 || null) ||
      payload.mobile_2 !== (contact.mobile_2 || null) ||
      payload.mobile_phone !== (contact.mobile_phone || null) ||
      payload.pager !== (contact.pager || null) ||
      payload.business_phone !== (contact.business_phone || null) ||
      payload.other_phone !== (contact.other_phone || null)

    if (!differs) continue

    const { error } = await supabase.from("phonebook_contacts").update(payload).eq("id", contact.id)
    if (error) throw error
    changed += 1
    if (changed % 100 === 0) {
      console.log(`Normalized ${changed} contacts`)
    }
  }

  console.log(`Normalized phone fields for ${changed} contacts.`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
