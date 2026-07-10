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

  if (error) return {} as Partial<Record<ReportSnapshotKey, T>>

  const keyById = new Map(keys.map((key) => [snapshotIds[key], key] as const))
  const snapshots: Partial<Record<ReportSnapshotKey, T>> = {}
  for (const row of (data || []) as Array<{ id: number; content: string | null }>) {
    const key = keyById.get(row.id)
    if (!key || !row.content) continue
    try {
      snapshots[key] = JSON.parse(row.content) as T
    } catch {
      // Keep one malformed snapshot from blocking the other report dates.
    }
  }
  return snapshots
}

export async function saveReportSnapshot<T>(key: ReportSnapshotKey, payload: T) {
  return supabase.from("remarks").upsert({
    id: snapshotIds[key],
    content: JSON.stringify(payload),
  }, { onConflict: "id" }).select("id").single()
}
