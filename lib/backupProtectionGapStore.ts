import "server-only"
import { createClient } from "@supabase/supabase-js"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"
import { BackupProtectionObservationError, validBackupTime, type BackupGapObserver, type BackupGapObservation, type BackupGapObservationResult } from "@/lib/backupProtectionPolicy"

const KEY_PATTERN = /^[a-z0-9-]{1,100}$/
const MAX_GAPS = 10_000
const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/
function gapTime(value: unknown) {
  return typeof value === "string" && RFC3339.test(value) ? validBackupTime(value) : null
}

function validateObservation(input: BackupGapObservation) {
  if (!input || typeof input !== "object" || !["database", "drive-file"].includes(input.domain) || gapTime(input.observedAt) === null
    || typeof input.complete !== "boolean" || !Array.isArray(input.gaps) || input.gaps.length > MAX_GAPS) {
    throw new BackupProtectionObservationError()
  }
  const keys = new Set<string>()
  for (const gap of input.gaps) {
    if (!gap || typeof gap !== "object" || typeof gap.key !== "string" || !KEY_PATTERN.test(gap.key)
      || gapTime(gap.dueAt) === null || keys.has(gap.key)
      || gap.coveredThroughAt !== undefined && (gapTime(gap.coveredThroughAt) === null
        || Date.parse(gap.coveredThroughAt) > Date.parse(input.observedAt))) throw new BackupProtectionObservationError()
    const hasRequired = gap.requiredVersion !== undefined || gap.requiredFingerprint !== undefined
    const hasCovered = gap.coveredVersion !== undefined || gap.coveredFingerprint !== undefined
    if (input.domain === "database" && gap.key === "inventory") {
      if (typeof gap.requiredVersion !== "string" || !/^\d{14}$/.test(gap.requiredVersion) || typeof gap.requiredFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(gap.requiredFingerprint)
        || hasCovered && (typeof gap.coveredVersion !== "string" || !/^\d{14}$/.test(gap.coveredVersion) || typeof gap.coveredFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(gap.coveredFingerprint) || !gap.coveredThroughAt)
        || gap.coveredThroughAt && !hasCovered || gap.requiredSinceAt !== undefined
        || hasCovered && gap.coveredVersion! > gap.requiredVersion) throw new BackupProtectionObservationError()
    } else if (hasRequired || hasCovered || gapTime(gap.requiredSinceAt) === null) throw new BackupProtectionObservationError()
    keys.add(gap.key)
  }
}

export function validateBackupGapReply(value: unknown, input: BackupGapObservation, preview = false): BackupGapObservationResult {
  validateObservation(input)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BackupProtectionObservationError()
  const reply = value as BackupGapObservationResult
  const observedAt = gapTime(reply.observedAt)
  if (reply.schema !== "fcuno.backup-protection-gaps/v1" || reply.domain !== input.domain || typeof reply.accepted !== "boolean"
    || observedAt === null || !Array.isArray(reply.gaps) || reply.gaps.length > MAX_GAPS
    || preview && !reply.accepted
    || (reply.accepted && observedAt !== validBackupTime(input.observedAt))
    || (!reply.accepted && observedAt < Date.parse(input.observedAt))) throw new BackupProtectionObservationError()
  const keys = new Set<string>()
  const byKey = new Map<string, BackupGapObservationResult["gaps"][number]>()
  // A read-only projection can see a committed clock newer than this GET's
  // start time. This is not an accepted durable observation or ordering claim.
  const latestFirstSeen = preview ? Math.max(observedAt, Date.now()) + 5 * 60_000 : observedAt
  for (const gap of reply.gaps) {
    const firstSeen = gapTime(gap?.firstUncoveredAt)
    if (!gap || typeof gap !== "object" || typeof gap.key !== "string" || !KEY_PATTERN.test(gap.key) || keys.has(gap.key) || firstSeen === null || firstSeen > latestFirstSeen
      || gapTime(gap.firstDueAt) === null) throw new BackupProtectionObservationError()
    keys.add(gap.key)
    byKey.set(gap.key, gap)
  }
  if (reply.accepted) {
    for (const gap of input.gaps) {
      const saved = byKey.get(gap.key)
      if (!saved || Date.parse(saved.firstDueAt) > Date.parse(gap.dueAt)) throw new BackupProtectionObservationError()
    }
    if (input.complete && keys.size !== input.gaps.length) throw new BackupProtectionObservationError()
  }
  return reply
}

function createBackupProtectionGapCallback(rpcName: "reconcile_backup_protection_gaps" | "preview_backup_protection_gaps"): BackupGapObserver {
  const rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  let url: URL
  try { url = new URL(rawUrl || "") } catch { throw new BackupProtectionObservationError() }
  if (url.origin !== `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`
    || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname) || !key) {
    throw new BackupProtectionObservationError("Backup protection storage does not match the FC Uno project. No alert was sent.")
  }
  const client = createClient(url.origin, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return async (input) => {
    validateObservation(input)
    try {
      const { data, error } = await client.rpc(rpcName, {
        p_domain: input.domain, p_observed_at: input.observedAt, p_gaps: input.gaps, p_complete: input.complete,
      }).abortSignal(AbortSignal.timeout(15_000))
      if (error) throw new BackupProtectionObservationError()
      const result = validateBackupGapReply(data, input, rpcName === "preview_backup_protection_gaps")
      if (!result.accepted) throw new BackupProtectionObservationError("A newer backup check is already recorded. No alert was sent from this older check.")
      return result
    } catch (error) {
      if (error instanceof BackupProtectionObservationError) throw error
      throw new BackupProtectionObservationError()
    }
  }
}

// Hard-bound factories: callers cannot turn the read-only dashboard callback
// into the state-writing notification operation or an arbitrary service RPC.
export function createBackupProtectionGapObserver(): BackupGapObserver {
  return createBackupProtectionGapCallback("reconcile_backup_protection_gaps")
}

export function createBackupProtectionGapPreviewObserver(): BackupGapObserver {
  return createBackupProtectionGapCallback("preview_backup_protection_gaps")
}
