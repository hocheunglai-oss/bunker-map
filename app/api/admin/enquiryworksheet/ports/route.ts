import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { requireAdminPagePermission } from "@/lib/adminAuth"

export const dynamic = "force-dynamic"

type PortNameRow = {
  name: string | null
}

function requireEnv(name: string) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not configured.`)
  return value
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unable to load port index."
  const status =
    message === "Unauthorized"
      ? 401
      : message === "Forbidden"
        ? 403
        : 500

  return NextResponse.json({ message }, { status })
}

export async function GET() {
  try {
    await requireAdminPagePermission("enquiryworksheet", "view")

    const supabase = createClient(
      requireEnv("NEXT_PUBLIC_SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      },
    )

    const { data, error } = await supabase
      .from("cc_ports")
      .select("name")
      .order("name", { ascending: true })
      .limit(10000)

    if (error) throw error

    const ports = Array.from(
      new Set(
        ((data || []) as PortNameRow[])
          .map((port) => port.name?.trim() || "")
          .filter(Boolean),
      ),
    )

    return NextResponse.json({ ports })
  } catch (error) {
    return errorResponse(error)
  }
}
