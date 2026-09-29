type SyncFailure = { id: string; label: string; error: string }

// The AI workbench has other work to finish in its 60-second request. Do not
// leave it waiting for an unbounded directory upload or mistake HTTP 207 for
// verified delivery. The phonebook can retry any unfinished contacts.
export async function syncPhonebookFromWorkbench(
  request: Request,
  contactIds: string[],
  dependencies: { fetch?: typeof fetch; now?: () => number } = {},
) {
  const ids = [...new Set(contactIds.filter(Boolean))]
  if (!ids.length) return null
  const send = dependencies.fetch || fetch
  const now = dependencies.now || Date.now
  const deadline = now() + 20_000
  const verified = new Set<string>()
  const errors = new Map<string, string>()

  for (let index = 0; index < ids.length; index += 2) {
    const remaining = deadline - now()
    if (remaining <= 0) break
    const batch = ids.slice(index, index + 2)
    try {
      const response = await send(new URL("/api/phonebook/carddav-sync", request.url), {
        method: "POST",
        headers: { "Content-Type": "application/json", cookie: request.headers.get("cookie") || "" },
        body: JSON.stringify({ contactIds: batch }),
        cache: "no-store",
        signal: AbortSignal.timeout(Math.max(1, Math.min(remaining, 10_000))),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !payload || payload.done !== true || payload.nextCursor !== null
        || !Array.isArray(payload.verifiedIds) || !Array.isArray(payload.failed)
        || payload.total !== batch.length || payload.verifiedCount !== payload.verifiedIds.length
        || payload.verifiedIds.some((id: unknown) => typeof id !== "string" || !batch.includes(id))
        || payload.failed.some((failure: { id?: string } | null) => !failure || typeof failure.id !== "string" || !batch.includes(failure.id))
        || new Set(payload.verifiedIds).size !== payload.verifiedIds.length
        || new Set(payload.failed.map((failure: { id: string }) => failure.id)).size !== payload.failed.length
        || payload.verifiedIds.length + payload.failed.length !== batch.length
        || payload.failed.some((failure: { id: string }) => payload.verifiedIds.includes(failure.id))) {
        for (const id of batch) errors.set(id, "Sync did not return a verified result.")
        break
      }
      const failedIds = new Set(payload.failed.map((failure: { id?: string }) => failure?.id))
      for (const id of batch) {
        if (payload.verifiedIds.includes(id) && !failedIds.has(id)) verified.add(id)
        else errors.set(id, "Contact delivery has not been verified.")
      }
      // Stop on upstream trouble rather than repeating it for the whole import.
      if (batch.some((id) => !verified.has(id))) break
    } catch {
      for (const id of batch) errors.set(id, "Sync was interrupted or timed out; delivery is not verified.")
      break
    }
  }

  const failed: SyncFailure[] = ids.filter((id) => !verified.has(id)).map((id) => ({
    id,
    label: `CONTACT ${id.slice(0, 8)}`,
    error: errors.get(id) || "Contact has not been synced yet.",
  }))
  return {
    ok: failed.length === 0,
    message: failed.length
      ? `Saved to phonebook. ${failed.length} contact(s) still need sync. Open Phonebook and sync the affected company.`
      : `Verified ${verified.size} contacts on CardDAV.`,
    failed,
  }
}
