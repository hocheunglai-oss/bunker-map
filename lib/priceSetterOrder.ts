export type PortOrderSnapshot = [string, number | null][]
export type PriceSetterReorder = { operation: "reorder"; expected: PortOrderSnapshot; order: string[] }
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const invalid = () => new Error("Reload saved ports before changing their order.")

export function priceSetterOrderSnapshot(rows: readonly { id: string; display_order?: unknown }[]): PortOrderSnapshot {
  const ids = new Set<string>()
  return rows.map(row => {
    const value = row.display_order ?? null
    if (!uuid.test(row.id) || ids.has(row.id) || value !== null && (typeof value !== "number" || !Number.isInteger(value) || value < -2147483648 || value > 2147483647)) throw invalid()
    ids.add(row.id)
    return [row.id, value]
  })
}

function visibleOrderIds(fullIds: readonly string[], visibleIds: readonly string[], movedId: string, targetId: string): Set<string> {
  const visible = new Set(visibleIds)
  if (new Set(fullIds).size !== fullIds.length || visible.size !== visibleIds.length
    || JSON.stringify(fullIds.filter(id => visible.has(id))) !== JSON.stringify(visibleIds)
    || !visible.has(movedId) || !visible.has(targetId)) throw invalid()
  return visible
}

// Move visible rows through their existing slots; hidden rows stay in place.
export function moveVisiblePort(fullIds: string[], visibleIds: string[], movedId: string, targetId: string): string[] {
  const visible = visibleOrderIds(fullIds, visibleIds, movedId, targetId)
  const moved = [...visibleIds], from = moved.indexOf(movedId), to = moved.indexOf(targetId)
  moved.splice(to, 0, moved.splice(from, 1)[0])
  let index = 0
  return fullIds.map(id => visible.has(id) ? moved[index++] : id)
}

// The indicator and the save use this same explicit edge. Direction of travel
// never silently decides which side of the destination the row will occupy.
export function insertVisiblePort(fullIds: readonly string[], visibleIds: readonly string[], movedId: string, targetId: string, edge: "before" | "after"): string[] {
  const visible = visibleOrderIds(fullIds, visibleIds, movedId, targetId)
  if (edge !== "before" && edge !== "after") throw invalid()
  if (movedId === targetId) return [...fullIds]
  const moved = visibleIds.filter(id => id !== movedId)
  moved.splice(moved.indexOf(targetId) + (edge === "after" ? 1 : 0), 0, movedId)
  let index = 0
  return fullIds.map(id => visible.has(id) ? moved[index++] : id)
}

export function validatePriceSetterReorder(value: unknown): PriceSetterReorder {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid()
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 3 || input.operation !== "reorder" || !Array.isArray(input.expected)
    || input.expected.length < 1 || !Array.isArray(input.order) || input.order.length !== input.expected.length) throw invalid()
  const rows = input.expected.map(entry => {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || entry[1] === undefined) throw invalid()
    return { id: entry[0], display_order: entry[1] }
  })
  const expected = priceSetterOrderSnapshot(rows), ids = new Set(expected.map(([id]) => id))
  if (new Set(input.order).size !== ids.size || input.order.some(id => typeof id !== "string" || !ids.has(id))) throw invalid()
  return { operation: "reorder", expected, order: input.order as string[] }
}

export function confirmPriceSetterOrder(value: unknown, wanted: string[]): PortOrderSnapshot {
  const uncertain = () => new Error("The new order could not be confirmed. Retry or reload saved ports.")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw uncertain()
  const result = value as Record<string, unknown>, expected = wanted.map((id, index) => [id, index + 1])
  if (typeof result.replayed !== "boolean" || JSON.stringify(result.order) !== JSON.stringify(expected)) throw uncertain()
  return expected as PortOrderSnapshot
}
