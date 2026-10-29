import { isDeepStrictEqual } from "node:util"

const invalid = () => { throw new Error("Recovery column metadata invalid") }
const identifier = value => typeof value === "string" && value.length > 0 && !value.includes("\0")

function visibleColumns(columns) {
  if (!Array.isArray(columns) || columns.length > 100000) invalid()
  const groups = new Set(), result = []
  let group, previousPosition = 0, ordinal = 0, names
  for (const column of columns) {
    if (!column || Object.getPrototypeOf(column) !== Object.prototype ||
        !["schema", "relation", "name"].every(key => Object.hasOwn(column, key) && identifier(column[key])) ||
        !Object.hasOwn(column, "position") || !Number.isSafeInteger(column.position) || column.position <= 0) invalid()
    const nextGroup = JSON.stringify([column.schema, column.relation])
    if (nextGroup !== group) {
      // Never sort supplied metadata into equality. Each relation must occur
      // once, and its original physical positions must already be ascending.
      if (groups.has(nextGroup)) invalid()
      groups.add(nextGroup); group = nextGroup; previousPosition = 0; ordinal = 0; names = new Set()
    }
    if (column.position <= previousPosition || names.has(column.name)) invalid()
    previousPosition = column.position; names.add(column.name)
    // Logical pg_dump omits dropped slots. Only the physical slot number may
    // differ after restore; every visible column's order and other catalog
    // field (including unknown future fields) must remain exactly the same.
    result.push({ ...column, position: ++ordinal })
  }
  return result
}

export function equivalentRecoveryColumns(expected, actual) {
  return isDeepStrictEqual(visibleColumns(expected), visibleColumns(actual))
}
