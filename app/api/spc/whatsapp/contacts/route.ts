import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireSpcRole } from "@/lib/spcAuth"

const CONTACT_LIMIT = 80
const CONTACT_COLUMNS = [
  "id",
  "full_name",
  "company",
  "title",
  "position",
  "department",
  "mobile_area",
  "mobile_1",
  "mobile_2",
  "mobile_phone",
  "business_phone",
  "business_phone_2",
  "direct_line",
  "other_phone",
  "instant_messaging",
  "personal_email",
  "general_email",
  "private_email",
  "favorite",
  "search_text",
].join(",")

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function normalizeText(value: string | null | undefined) {
  return value?.trim() || ""
}

function buildSearchTokens(value: string) {
  return value
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[%,()]/g, ""))
    .filter(Boolean)
    .slice(0, 6)
}

function phoneDigits(value: string | null | undefined) {
  return (value || "").replace(/\D/g, "")
}

function phoneSearchClause(value: string) {
  const tail = value.slice(-8)
  return [
    `mobile_1.ilike.%${tail}%`,
    `mobile_2.ilike.%${tail}%`,
    `mobile_phone.ilike.%${tail}%`,
    `business_phone.ilike.%${tail}%`,
    `direct_line.ilike.%${tail}%`,
    `other_phone.ilike.%${tail}%`,
    `instant_messaging.ilike.%${tail}%`,
  ].join(",")
}

export async function GET(request: Request) {
  try {
    await requireSpcRole("supplier_trader")

    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      process.env.SUPABASE_SERVICE_ROLE_KEY || requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    )
    const { searchParams } = new URL(request.url)
    const query = normalizeText(searchParams.get("query"))
    const phone = phoneDigits(searchParams.get("phone"))
    const limit = Math.min(
      Math.max(Number(searchParams.get("limit") || CONTACT_LIMIT), 1),
      CONTACT_LIMIT,
    )

    let contactQuery = supabase
      .from("phonebook_contacts")
      .select(CONTACT_COLUMNS)
      .order("favorite", { ascending: false })
      .order("full_name", { ascending: true })
      .limit(limit)

    if (phone) {
      contactQuery = contactQuery.or(phoneSearchClause(phone))
    } else {
      const tokens = buildSearchTokens(query)
      const queryDigits = phoneDigits(query)
      if (queryDigits.length >= 4) {
        contactQuery = contactQuery.or(phoneSearchClause(queryDigits))
      }
      const searchFields = [
        "search_text",
        "full_name",
        "company",
        "mobile_area",
        "mobile_1",
        "mobile_phone",
        "instant_messaging",
      ]
      for (const token of tokens) {
        contactQuery = contactQuery.or(
          searchFields.map((field) => `${field}.ilike.%${token}%`).join(","),
        )
      }
    }

    const { data, error } = await contactQuery
    if (error) throw error

    return NextResponse.json(
      { contacts: data || [] },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load WhatsApp contacts."
    const status = message === "Unauthorized" ? 401 : message === "Forbidden" ? 403 : 500
    return NextResponse.json({ message }, { status })
  }
}
