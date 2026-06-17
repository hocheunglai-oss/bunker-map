import { parseSimpleFormula } from "@/lib/portPricing"

type SupabaseLike = {
  from: (table: string) => any
}

type LatestHistoryRow = {
  hsfo: number | null
  vlsfo: number | null
  mgo: number | null
  recorded_at: string
}

type PortDependencyRow = {
  id: number
  name: string | null
  type?: string | null
  hsfo_formula?: string | null
  vlsfo_formula?: string | null
  mgo_formula?: string | null
}

function getErrorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message.trim()) return message
  }

  return "Unknown database error."
}

function throwIfError(result: { error?: unknown }, action: string) {
  if (result.error) {
    throw new Error(`${action}: ${getErrorMessage(result.error)}`)
  }
}

export async function syncPortFromLatestHistory(
  supabase: SupabaseLike,
  currentPortId: number
) {
  const latestHistoryResult = await supabase
    .from("price_history")
    .select("hsfo,vlsfo,mgo,recorded_at")
    .eq("port_id", currentPortId)
    .order("recorded_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle()

  throwIfError(latestHistoryResult, "Load latest price history")

  const latestHistory = latestHistoryResult.data as LatestHistoryRow | null
  if (!latestHistory) return null

  const syncResult = await supabase
    .from("ports")
    .update({
      hsfo: latestHistory.hsfo,
      vlsfo: latestHistory.vlsfo,
      mgo: latestHistory.mgo,
      updated_at: latestHistory.recorded_at,
    })
    .eq("id", currentPortId)

  throwIfError(syncResult, "Sync latest history to port")

  const currentPortResult = await supabase
    .from("ports")
    .select("name")
    .eq("id", currentPortId)
    .maybeSingle()

  throwIfError(currentPortResult, "Load synced port")

  const allPortsResult = await supabase
    .from("ports")
    .select("id,name,type,hsfo_formula,vlsfo_formula,mgo_formula")

  throwIfError(allPortsResult, "Load formula dependencies")

  const currentPort = currentPortResult.data as { name?: string | null } | null
  const allPorts = (allPortsResult.data ?? []) as PortDependencyRow[]
  if (!currentPort?.name || allPorts.length === 0) return latestHistory

  const dependentIds = new Set<number>()
  const queue = [String(currentPort.name).toLowerCase()]

  while (queue.length > 0) {
    const currentName = queue.shift()
    if (!currentName) continue

    for (const candidate of allPorts) {
      if (candidate.id === currentPortId || candidate.type === "divider") continue

      const formulas = [
        candidate.hsfo_formula,
        candidate.vlsfo_formula,
        candidate.mgo_formula,
      ]

      const referencesCurrent = formulas.some((formula) => {
        const parsed = parseSimpleFormula(formula)
        return parsed?.refName === currentName
      })

      if (!referencesCurrent || dependentIds.has(candidate.id)) continue

      dependentIds.add(candidate.id)
      queue.push(String(candidate.name).toLowerCase())
    }
  }

  if (dependentIds.size > 0) {
    const dependentSyncResult = await supabase
      .from("ports")
      .update({ updated_at: latestHistory.recorded_at })
      .in("id", Array.from(dependentIds))

    throwIfError(dependentSyncResult, "Sync dependent port dates")
  }

  return latestHistory
}
