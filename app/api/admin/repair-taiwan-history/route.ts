import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { buildTaiwanReportRows, formatReportDate } from "@/lib/taiwanReport"

const TARGET_DATE = "2026-07-13"
const TAIWAN_PORTS = ["Kaohsiung", "Keelung", "Taichung", "Suao", "Hualien"]
const expectedPrices = {
  Kaohsiung: { hsfo: 638, vlsfo: 700, mgo: 990 },
  Taichung: { hsfo: null, vlsfo: 710, mgo: 990 },
} as const

function getSupabaseClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) throw new Error("Production database credentials are unavailable.")

  return createClient(url, serviceKey, {
    auth: { persistSession: false },
    global: {
      headers: {
        "x-bunker-admin-user": "codex-production-repair",
        "x-bunker-admin-display-name": "Codex Production Repair",
        "x-bunker-admin-page-id": "taiwan-price-history",
        "x-bunker-admin-page-label": "TAIWAN PRICE HISTORY",
        "x-bunker-admin-page-path": "/admin/taiwanpricehistory",
      },
    },
  })
}

function matchesExpected(
  row: { hsfo: number | null; vlsfo: number | null; mgo: number | null },
  expected: { hsfo: number | null; vlsfo: number | null; mgo: number | null },
) {
  return row.hsfo === expected.hsfo && row.vlsfo === expected.vlsfo && row.mgo === expected.mgo
}

export async function POST() {
  try {
    const supabase = getSupabaseClient()
    const { data: primaryPorts, error: primaryPortsError } = await supabase
      .from("ports")
      .select("id,name")
      .in("name", Object.keys(expectedPrices))

    if (primaryPortsError) throw primaryPortsError
    if (!primaryPorts || primaryPorts.length !== 2) {
      throw new Error("Taiwan primary ports could not be resolved.")
    }

    let duplicatesRemoved = 0
    for (const port of primaryPorts) {
      const expected = expectedPrices[port.name as keyof typeof expectedPrices]
      if (!expected) throw new Error(`Unexpected repair port: ${port.name}`)

      const { data: sameDateRows, error: sameDateError } = await supabase
        .from("price_history")
        .select("id,hsfo,vlsfo,mgo,recorded_at")
        .eq("port_id", port.id)
        .gte("recorded_at", `${TARGET_DATE}T00:00:00`)
        .lt("recorded_at", "2026-07-14T00:00:00")
        .order("recorded_at", { ascending: false })

      if (sameDateError) throw sameDateError
      if (!sameDateRows || sameDateRows.length === 0) {
        throw new Error(`No ${TARGET_DATE} record found for ${port.name}.`)
      }
      if (!sameDateRows.every((row) => matchesExpected(row, expected))) {
        throw new Error(`${port.name} has non-identical ${TARGET_DATE} records; repair stopped.`)
      }

      const duplicateIds = sameDateRows.slice(1).map((row) => row.id)
      if (duplicateIds.length > 0) {
        const { error: deleteError } = await supabase
          .from("price_history")
          .delete()
          .in("id", duplicateIds)

        if (deleteError) throw deleteError
        duplicatesRemoved += duplicateIds.length
      }
    }

    const { data: portsData, error: portsError } = await supabase
      .from("ports")
      .select("*")
      .in("name", TAIWAN_PORTS)

    if (portsError) throw portsError
    if (!portsData || portsData.length !== TAIWAN_PORTS.length) {
      throw new Error("Taiwan report ports are incomplete.")
    }

    const { data: historyData, error: historyError } = await supabase
      .from("price_history")
      .select("*")
      .in("port_id", portsData.map((port) => port.id))
      .order("recorded_at", { ascending: false })

    if (historyError) throw historyError
    if (!historyData || historyData.length === 0) {
      throw new Error("Taiwan history is empty.")
    }

    const { data: remarksData, error: remarksError } = await supabase
      .from("remarks")
      .select("id,content")
      .in("id", [1, 2])

    if (remarksError) throw remarksError

    const snapshot = {
      reportDate: formatReportDate(historyData[0].recorded_at),
      rows: buildTaiwanReportRows(portsData, historyData, TAIWAN_PORTS),
      remark: remarksData?.find((row) => row.id === 1)?.content || "",
      specialNotice: remarksData?.find((row) => row.id === 2)?.content || "",
    }
    const { error: snapshotError } = await supabase.from("remarks").upsert({
      id: 101,
      content: JSON.stringify(snapshot),
    }, { onConflict: "id" })

    if (snapshotError) throw snapshotError

    return NextResponse.json({
      success: true,
      duplicatesRemoved,
      reportDate: snapshot.reportDate,
      rows: snapshot.rows,
    })
  } catch (error) {
    console.error("Taiwan history repair failed", error)
    return NextResponse.json({
      success: false,
      message: error instanceof Error ? error.message : "Taiwan history repair failed.",
    }, { status: 500 })
  }
}
