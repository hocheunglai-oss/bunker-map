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

export async function saveReportSnapshot<T>(key: ReportSnapshotKey, payload: T) {
  return supabase.from("remarks").upsert({
    id: snapshotIds[key],
    content: JSON.stringify(payload),
  })
}
