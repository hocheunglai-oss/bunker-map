import type { CcinfoIndexKind } from "./ccinfoIndex"

export type CcinfoDeleteRequest = { kind: CcinfoIndexKind; id: string; expectedUpdatedAt: string; deletePorts: boolean }
export type CcinfoDeleteReceipt = {
  schema: "fcuno.ccinfo-delete/v1"
  kind: CcinfoIndexKind
  id: string
  deletedAt: string
  deletedCount: 1
  portsDeleted: number
  portsDetached: number
}
export const CCINFO_DELETE_TIMEOUT_MS = 30_000
export class CcinfoDeleteError extends Error {
  constructor(message: string, public readonly status: number) { super(message); this.name = "CcinfoDeleteError" }
}
const conflict = "The entry changed or was removed. Refresh it before deleting. Your draft is still here."
const uncertain = "The deletion could not be confirmed. Keep this entry open and refresh its saved details before trying again."
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
function validVersion(value: unknown): value is string {
  if (typeof value !== "string") return false
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/.exec(value)
  if (!parts || Number(parts[1]) < 1 || !Number.isFinite(Date.parse(value))) return false
  const date = new Date(0)
  date.setUTCFullYear(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]))
  return date.getUTCFullYear() === Number(parts[1]) && date.getUTCMonth() === Number(parts[2]) - 1 && date.getUTCDate() === Number(parts[3])
}
export function parseCcinfoDeleteRequest(value: unknown): CcinfoDeleteRequest {
  if (!object(value)) throw new CcinfoDeleteError("Check the selected entry before deleting.", 400)
  if (value.expectedUpdatedAt === undefined || value.expectedUpdatedAt === null || value.expectedUpdatedAt === "") throw new CcinfoDeleteError(conflict, 409)
  if (Object.keys(value).some(key => !["kind", "id", "expectedUpdatedAt", "deletePorts"].includes(key))
    || typeof value.kind !== "string" || !["company", "country", "port"].includes(value.kind) || typeof value.id !== "string" || !uuid.test(value.id)
    || !validVersion(value.expectedUpdatedAt) || typeof value.deletePorts !== "boolean" || value.kind !== "country" && value.deletePorts) {
    throw new CcinfoDeleteError("Check the selected entry and saved version before deleting.", 400)
  }
  return { kind: value.kind as CcinfoIndexKind, id: value.id.toLowerCase(), expectedUpdatedAt: value.expectedUpdatedAt, deletePorts: value.deletePorts }
}
export function parseCcinfoDeleteReceipt(value: unknown, request: CcinfoDeleteRequest): CcinfoDeleteReceipt {
  if (!object(value) || value.schema !== "fcuno.ccinfo-delete/v1" || value.kind !== request.kind || value.id !== request.id
    || value.deletedCount !== 1 || !validVersion(value.deletedAt)
    || typeof value.portsDeleted !== "number" || !Number.isSafeInteger(value.portsDeleted) || value.portsDeleted < 0
    || typeof value.portsDetached !== "number" || !Number.isSafeInteger(value.portsDetached) || value.portsDetached < 0
    || (request.kind !== "country" || !request.deletePorts) && value.portsDeleted !== 0
    || (request.kind !== "country" || request.deletePorts) && value.portsDetached !== 0) {
    throw new CcinfoDeleteError(uncertain, 502)
  }
  return { schema: "fcuno.ccinfo-delete/v1", kind: request.kind, id: request.id, deletedAt: value.deletedAt,
    deletedCount: 1, portsDeleted: value.portsDeleted, portsDetached: value.portsDetached }
}
export async function deleteCcinfoRecord(value: CcinfoDeleteRequest, options: { signal?: AbortSignal } = {}): Promise<CcinfoDeleteReceipt> {
  const request = parseCcinfoDeleteRequest(value)
  if (options.signal?.aborted) throw new CcinfoDeleteError(uncertain, 0)
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => { controller.abort(); reject(new CcinfoDeleteError(uncertain, 0)) }
    timer = setTimeout(abort, CCINFO_DELETE_TIMEOUT_MS)
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
  })
  const operation = async (): Promise<CcinfoDeleteReceipt> => {
    let response: Response
    try {
      response = await fetch("/api/ccinfo/delete-record", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request), cache: "no-store", signal: controller.signal })
    } catch { throw new CcinfoDeleteError(uncertain, 0) }
    // Access revocation must remain identifiable even if a proxy returns HTML.
    if (response.status === 401) throw new CcinfoDeleteError("Your sign-in expired. Please sign in again.", 401)
    if (response.status === 403) throw new CcinfoDeleteError("You do not have permission to delete this entry.", 403)
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const message = object(body) && typeof body.message === "string" && body.message.length <= 240 && !/[\u0000-\u001f\u007f]/.test(body.message)
        ? body.message : response.status === 409 ? conflict : uncertain
      throw new CcinfoDeleteError(message, response.status)
    }
    if (!object(body)) throw new CcinfoDeleteError(uncertain, 502)
    return parseCcinfoDeleteReceipt(body.deletion, request)
  }
  try {
    return await Promise.race([operation(), deadline])
  } finally {
    clearTimeout(timer)
    if (abort) options.signal?.removeEventListener("abort", abort)
  }
}
