import { supabase } from "@/lib/supabase"

export type ReportSnapshotKey = "taiwan" | "hongkong" | "china" | "compact"

const snapshotIds: Record<ReportSnapshotKey, number> = {
  taiwan: 101,
  hongkong: 102,
  china: 103,
  compact: 104,
}

export async function loadReportSnapshot<T>(key: ReportSnapshotKey): Promise<T | null> {
  const { data, error } = await supabase
    .from("remarks")
    .select("content")
    .eq("id", snapshotIds[key])
    .maybeSingle()

  if (error || !data?.content) return null

  try {
    return JSON.parse(data.content) as T
  } catch {
    return null
  }
}

export async function loadReportSnapshots<T>(keys: ReportSnapshotKey[]) {
  const ids = keys.map((key) => snapshotIds[key])
  const { data, error } = await supabase
    .from("remarks")
    .select("id,content")
    .in("id", ids)

  if (error || !Array.isArray(data)) throw new Error("Saved report dates could not be read.")

  const keyById = new Map(keys.map((key) => [snapshotIds[key], key] as const))
  const snapshots: Partial<Record<ReportSnapshotKey, T>> = {}
  for (const row of data as Array<{ id: number; content: string | null }>) {
    if (!row || !Number.isInteger(row.id) || row.content !== null && typeof row.content !== "string") throw new Error("Saved report dates could not be read.")
    const key = keyById.get(row.id)
    if (!key || !row.content) continue
    try {
      const parsed = JSON.parse(row.content)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
        || parsed.reportDate !== undefined && (typeof parsed.reportDate !== "string" || parsed.reportDate.length > 80)) throw new Error("Invalid report date")
      snapshots[key] = parsed as T
    } catch {
      throw new Error("Saved report dates could not be read.")
    }
  }
  return snapshots
}
