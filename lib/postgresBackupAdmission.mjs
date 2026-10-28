import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { assertExact, assertExportContext, guardedExport } from "./postgresBackupProtocol.mjs"

const origin = `https://${fcunoConnectionPolicy.supabase.projectRef}.supabase.co`
const fail = () => { throw new Error("Source export admission unavailable") }
// This uses only the existing SOURCE application credential. It is never
// shipped to Google. Fixed RPC names/arguments, no table/query/path interface.
export function createPostgresBackupAdmission({ url, serviceRoleKey, fetch: fetchImpl = fetch }) {
  if (url !== origin || typeof serviceRoleKey !== "string" || !serviceRoleKey || typeof fetchImpl !== "function") fail()
  async function rpc(name, body, context) {
    assertExportContext(context)
    const response = await guardedExport(fetchImpl(`${origin}/rest/v1/rpc/${name}`, {
      method: "POST", cache: "no-store", redirect: "error", signal: context.signal,
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), context, result => result.body?.cancel())
    if (response.status !== 200 || !response.body) { void response.body?.cancel().catch(() => {}); fail() }
    const reader = response.body.getReader(); let count = 0; const pieces = []
    try {
      for (;;) {
        const part = await guardedExport(reader.read(), context)
        if (part.done) break
        count += part.value.byteLength; if (count > 1024) fail()
        pieces.push(part.value)
      }
      return JSON.parse(Buffer.concat(pieces).toString("utf8"))
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  }
  return {
    async acquire(input, context) {
      assertExact(input, ["week", "owner", "expiresAt"])
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.owner)) fail()
      const result = await rpc("claim_fixed_postgresql_export", { p_owner: input.owner }, context)
      if (result === null) return null
      assertExact(result, ["week", "owner", "fence"])
      if (result.week !== input.week || result.owner !== input.owner || !Number.isSafeInteger(result.fence) || result.fence < 1) fail()
      return result
    },
    async finish(owned, result, context) {
      assertExact(owned, ["week", "owner", "fence"]); assertExact(result, ["exported"])
      if (typeof result.exported !== "boolean") fail()
      const value = await rpc("finish_fixed_postgresql_export", { p_owner: owned.owner, p_fence: owned.fence, p_exported: result.exported }, context)
      if (value !== true) fail()
    },
  }
}
