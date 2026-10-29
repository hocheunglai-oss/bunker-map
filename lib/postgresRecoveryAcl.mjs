import { isDeepStrictEqual } from "node:util"

// pg_dump omits ACL items equal to object defaults. A logical restore can
// therefore put those exact same items at a different array position. Treat
// ONLY the known schema/database/relation/function/type ACL items as multisets;
// do not sort catalog rows,
// infer defaults, reinterpret privileges, or discard grantors/grant options.
const MAX_ACL_BYTES = 8 * 1024 * 1024
const MAX_ACL_ITEMS = 100000
const validItem = value => typeof value === "string" && value.length > 0 && !value.includes("\0")

function aclTextItems(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_ACL_BYTES || value[0] !== "{" || value.at(-1) !== "}") return null
  if (value === "{}") return []
  const items = []
  let offset = 1
  while (offset < value.length - 1) {
    let item = ""
    if (value[offset] === '"') {
      offset++
      let closed = false
      while (offset < value.length - 1) {
        const character = value[offset++]
        if (character === '"') { closed = true; break }
        if (character === "\\") {
          if (offset >= value.length - 1) return null
          item += value[offset++]
        } else item += character
      }
      if (!closed) return null
    } else {
      const began = offset
      while (offset < value.length - 1 && value[offset] !== ",") {
        // Canonical PostgreSQL array output quotes every item containing
        // whitespace, braces, backslashes or quotes. Reject alternate syntax,
        // dimensions, nested arrays and SQL NULL array elements fail-closed.
        if (/[\s{}"\\]/u.test(value[offset])) return null
        offset++
      }
      item = value.slice(began, offset)
      if (item === "NULL") return null
    }
    if (!validItem(item) || items.length >= MAX_ACL_ITEMS) return null
    items.push(item)
    if (offset === value.length - 1) return items
    if (value[offset++] !== "," || offset === value.length - 1) return null
  }
  return null
}

function aclArrayItems(value) {
  if (!Array.isArray(value) || value.length > MAX_ACL_ITEMS) return null
  for (const item of value) if (!validItem(item)) return null
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_ACL_BYTES) return null
  return value
}

function equivalentAcl(expected, actual, parse) {
  // NULL means default ACL, whereas []/{} means explicit empty ACL. Keep
  // those distinguishable even where effective privileges happen to match.
  if (expected === null || actual === null) return expected === null && actual === null
  const left = parse(expected), right = parse(actual)
  if (!left || !right || left.length !== right.length) return false
  const counts = new Map()
  for (const item of left) counts.set(item, (counts.get(item) || 0) + 1)
  for (const item of right) {
    const remaining = counts.get(item)
    if (!remaining) return false
    if (remaining === 1) counts.delete(item)
    else counts.set(item, remaining - 1)
  }
  return counts.size === 0
}

const record = value => value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "acl")
function equivalentRecord(expected, actual, parse) {
  if (!record(expected) || !record(actual)) return false
  const { acl: expectedAcl, ...expectedRest } = expected
  const { acl: actualAcl, ...actualRest } = actual
  return isDeepStrictEqual(expectedRest, actualRest) && equivalentAcl(expectedAcl, actualAcl, parse)
}

export function equivalentRecoverySchemas(expected, actual) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false
  for (let index = 0; index < expected.length; index++)
    if (!equivalentRecord(expected[index], actual[index], aclTextItems)) return false
  return true
}

export function equivalentRecoveryDatabase(expected, actual) {
  return equivalentRecord(expected, actual, aclArrayItems)
}

// Explicitly bounded to the other three catalog sections whose captured ACLs
// use aclitem[]::text. No caller can opt arbitrary catalog fields into this
// comparison, and every field except this exact acl property stays strict.
export function equivalentRecoveryAclSection(expected, actual, section) {
  if (!["relations", "functions", "types"].includes(section)) return false
  return equivalentRecoverySchemas(expected, actual)
}
