export const SPC_SHARED_FEED_STARTED_AT = "2026-07-23T09:20:00.000Z"

export type SpcEnquiryScope = "mine" | "shared" | "records"

export function resolveSpcEnquiryScope(
  scopeValue: string | null,
  createdAfterValue: string,
): SpcEnquiryScope | null {
  const requestedScope = scopeValue?.trim() || ""

  if (!requestedScope) {
    return createdAfterValue === SPC_SHARED_FEED_STARTED_AT ? "shared" : "mine"
  }

  if (
    requestedScope === "mine" ||
    requestedScope === "shared" ||
    requestedScope === "records"
  ) {
    return requestedScope
  }

  return null
}
