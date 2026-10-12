// Old pricing/history tabs must not bypass conflict-checked operations. Keep
// reads compatible. All four reports publish through the coherent API. Taiwan
// Remarks can edit notices only, never snapshots or Price Setter settings.
// Port creation, including retries, uses the receipt-backed audited API.
export function priceSetterLegacyWriteMessage(
  pageId: string,
  table: string,
  method: string,
  body?: ArrayBuffer,
): string | null {
  const message = "This page is out of date. Refresh it before saving. Your unsaved changes have not been applied."
  if (["GET", "HEAD"].includes(method)) return null
  const historyPage = ["hongkong-price-history", "taiwan-price-history"].includes(pageId)
  if (historyPage && ["price_history", "ports", "remarks"].includes(table)) return message
  if (pageId === "pricesetter" && table === "remarks") return message
  if (pageId !== "pricesetter" && !(pageId === "taiwan-remarks" && table === "remarks")) return null
  if (table === "price_history" || table === "ports") return message
  if (table !== "remarks") return null
  if (method !== "POST" || !body?.byteLength) return message
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    if (!rows.length || rows.some(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return true
      const value = row as Record<string, unknown>
      const allowedIds = [1, 2, 3]
      return !allowedIds.includes(value.id as number)
        || typeof value.content !== "string"
        || Object.keys(value).length !== 2
    })) return message
    return null
  } catch { return message }
}
