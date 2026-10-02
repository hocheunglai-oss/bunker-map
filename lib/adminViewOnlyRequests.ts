/**
 * A client-side usability exception, not authorization. The attendance API must
 * still verify page access, staff ownership and that the month has closed.
 */
export async function isViewOnlyAttendanceConfirmation(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  origin: string,
  pageId: string,
  canView: boolean,
): Promise<boolean> {
  if (!canView || pageId !== "attendance-record") return false
  try {
    const request = input instanceof Request ? input : null
    const url = new URL(request ? request.url : String(input), origin)
    const method = (init?.method || request?.method || "GET").toUpperCase()
    if (
      url.origin !== origin ||
      url.pathname !== "/api/admin/attendance" ||
      method !== "POST"
    ) return false

    // Clone Request bodies so checking this exception never consumes the body
    // which the original fetch must deliver to the server.
    const body: unknown = init?.body != null
      ? (typeof init.body === "string" ? JSON.parse(init.body) : null)
      : request ? await request.clone().json() : null
    if (!body || typeof body !== "object" || Array.isArray(body)) return false
    const payload = body as Record<string, unknown>
    const confirmation = payload.confirmation
    return payload.action === "save-confirmation" &&
      Boolean(confirmation && typeof confirmation === "object" &&
        !Array.isArray(confirmation) &&
        (confirmation as Record<string, unknown>).status === "confirmed")
  } catch {
    return false
  }
}
