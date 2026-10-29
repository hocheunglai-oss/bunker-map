import { isDeepStrictEqual } from "node:util"

// pg_dump omits ACL items equal to object defaults. A logical restore can
// therefore put those exact same items at a different array position. Treat
// ONLY the known schema/database/relation/function/type ACL items as multisets.
// For schemas/relations ONLY, PostgreSQL 17's exact hard-wired owner-default
// ACL also equals NULL: pg_dump omits that redundant explicit ACL. Do not sort
// catalog rows, reinterpret other privileges, or discard grantors/options.
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

function equivalentAcl(expected, actual, parse, ownerDefault = null) {
  // NULL is the hard-wired object default, NEVER an empty ACL. The one allowed
  // explicit-default equivalence is supplied by the known schema/relation
  // policy below; database/function/type null handling stays unchanged.
  if (expected === null || actual === null) {
    if (expected === null && actual === null) return true
    if (ownerDefault === null) return false
    const explicit = parse(expected === null ? actual : expected)
    return explicit?.length === 1 && explicit[0] === ownerDefault
  }
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
function ownerDefaultAcl(value, section) {
  // The signed protocol and fixed native image support PostgreSQL 17 only.
  // acl.c acldefault()/putid() and acl.h define these exact owner/grantor
  // entries: no PUBLIC entry and no explicit grant-option stars. In
  // particular PostgreSQL 17 relations include MAINTAIN (m), sequences do not.
  const privileges = section === "schemas" ? "UC" : section === "relations" ?
    value.kind === "S" ? "rwU" : ["r", "p", "v", "m", "f"].includes(value.kind) ? "arwdDxtm" : null : null
  const owner = value.owner
  if (!privileges || typeof owner !== "string" || !owner || owner.includes("\0") || Buffer.byteLength(owner) > 63) return null
  // ACL quoting is not SQL quote_ident: uppercase, keywords and digit-leading
  // ASCII names stay unquoted, while every non-ASCII/special byte is quoted.
  const encoded = /^[A-Za-z0-9_]+$/.test(owner) ? owner : `"${owner.replaceAll('"', '""')}"`
  return `${encoded}=${privileges}/${encoded}`
}

function equivalentRecord(expected, actual, parse, section = null) {
  if (!record(expected) || !record(actual)) return false
  const { acl: expectedAcl, ...expectedRest } = expected
  const { acl: actualAcl, ...actualRest } = actual
  return isDeepStrictEqual(expectedRest, actualRest) && equivalentAcl(expectedAcl, actualAcl, parse, ownerDefaultAcl(expected, section))
}

function equivalentRecords(expected, actual, section) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false
  for (let index = 0; index < expected.length; index++)
    if (!equivalentRecord(expected[index], actual[index], aclTextItems, section)) return false
  return true
}

export function equivalentRecoverySchemas(expected, actual) {
  return equivalentRecords(expected, actual, "schemas")
}

export function equivalentRecoveryDatabase(expected, actual) {
  return equivalentRecord(expected, actual, aclArrayItems)
}

// Explicitly bounded to the other three catalog sections whose captured ACLs
// use aclitem[]::text. No caller can opt arbitrary catalog fields into this
// comparison, and every field except this exact acl property stays strict.
export function equivalentRecoveryAclSection(expected, actual, section) {
  if (!["relations", "functions", "types"].includes(section)) return false
  return equivalentRecords(expected, actual, section)
}

// Failure-only diagnostic summary. Reuse the exact existing bounded parser;
// expose no ACL item, role, grantor or privilege text. NULL is not an empty ACL.
// This function is never used by a recovery acceptance/equality predicate.
export function summarizeRecoveryAclTextDifference(expected, actual) {
  if (expected === null || actual === null) return {
    kind: expected === actual ? "equivalent" : expected === null ? "null-to-value" : "value-to-null",
    missingEntries: 0, extraEntries: 0,
  }
  const left = aclTextItems(expected), right = aclTextItems(actual)
  if (!left || !right) return { kind: "invalid", missingEntries: 0, extraEntries: 0 }
  const counts = new Map()
  for (const item of left) counts.set(item, (counts.get(item) || 0) + 1)
  let extraEntries = 0
  for (const item of right) {
    const remaining = counts.get(item)
    if (!remaining) extraEntries++
    else if (remaining === 1) counts.delete(item)
    else counts.set(item, remaining - 1)
  }
  const missingEntries = [...counts.values()].reduce((sum, value) => sum + value, 0)
  return { kind: missingEntries || extraEntries ? "changed" : "equivalent", missingEntries, extraEntries }
}

const replayFailure = () => { throw new Error("Private schema ACL replay plan rejected") }
const validName = name => typeof name === "string" && name.length > 0 && !name.includes("\0") && Buffer.byteLength(name) <= 63
const aclName = name => /^[A-Za-z0-9_]+$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`
const sqlIdentifier = name => `"${name.replaceAll('"', '""')}"`
// Explicit escape strings remain safe even if restored role/database settings
// turn standard_conforming_strings off. Never interpolate raw source tokens.
const sqlLiteral = value => `E'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`

function schemaAclItem(item, roles) {
  let offset = 0
  function readName(publicAllowed) {
    const began = offset
    let name = ""
    if (item[offset] === '"') {
      offset++
      let closed = false
      while (offset < item.length) {
        const character = item[offset++]
        if (character !== '"') name += character
        else if (item[offset] === '"') { name += '"'; offset++ }
        else { closed = true; break }
      }
      if (!closed) replayFailure()
    } else while (offset < item.length && /[A-Za-z0-9_]/.test(item[offset])) name += item[offset++]
    if (publicAllowed && offset === began && item[offset] === "=") return null
    if (!validName(name) || !roles.has(name) || item.slice(began, offset) !== aclName(name)) replayFailure()
    return name
  }
  const grantee = readName(true)
  if (item[offset++] !== "=") replayFailure()
  const slash = item.indexOf("/", offset)
  if (slash < 0) replayFailure()
  const rights = item.slice(offset, slash)
  if (!rights || !/^(?:U\*?)?(?:C\*?)?$/.test(rights)) replayFailure()
  offset = slash + 1
  const grantor = readName(false)
  if (offset !== item.length) replayFailure()
  const privileges = [...rights.matchAll(/([UC])(\*)?/g)].map(([, code, option]) => ({ code, grantOption: !!option }))
  if (grantee === null && privileges.some(item => item.grantOption)) replayFailure()
  return { grantee, grantor, privileges }
}

// Sealed recovery only: a logical dump can omit unchanged managed-bootstrap
// pg_init_privs grants. Rebuild ONLY a missing (NULL) schema ACL from the
// independently signed actual ACL. This is not an equality relaxation and
// never changes production or the signed source catalog.
export function buildMissingSchemaAclReplay(expected, actual, capturedRoles) {
  if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length || expected.length > MAX_ACL_ITEMS ||
      !Array.isArray(capturedRoles) || capturedRoles.length > MAX_ACL_ITEMS) replayFailure()
  const roles = new Set()
  for (const role of capturedRoles) {
    if (!validName(role?.rolname) || roles.has(role.rolname)) replayFailure()
    roles.add(role.rolname)
  }
  const plans = [], names = new Set()
  let totalBytes = 0, totalItems = 0
  for (let index = 0; index < expected.length; index++) {
    const source = expected[index], target = actual[index]
    if (!record(source) || !record(target) || !validName(source.name) || names.has(source.name)) replayFailure()
    names.add(source.name)
    const { acl: sourceAcl, ...sourceRest } = source, { acl: targetAcl, ...targetRest } = target
    if (!isDeepStrictEqual(sourceRest, targetRest)) replayFailure()
    if (equivalentRecoverySchemas([source], [target])) continue
    if (targetAcl !== null || sourceAcl === null || !roles.has(source.owner)) replayFailure()
    const items = aclTextItems(sourceAcl)
    if (!items || (totalBytes += Buffer.byteLength(sourceAcl)) > MAX_ACL_BYTES || (totalItems += items.length) > MAX_ACL_ITEMS) replayFailure()
    const pairs = new Set(), pending = new Map()
    for (const item of items) {
      const grant = schemaAclItem(item, roles), pair = JSON.stringify([grant.grantee, grant.grantor])
      if (pairs.has(pair)) replayFailure()
      pairs.add(pair)
      for (const privilege of grant.privileges) {
        const key = `${grant.grantor}\0${privilege.code}`
        if (!pending.has(key)) pending.set(key, [])
        pending.get(key).push({ grantee: grant.grantee, grantor: grant.grantor, ...privilege })
      }
    }
    // Owners retain implicit grant authority even after their ordinary rights
    // are revoked. Only an explicit WITH GRANT OPTION enables other grantors.
    // A queue proves reachability in linear time, independent of ACL item order.
    const authority = new Set([`${source.owner}\0U`, `${source.owner}\0C`]), queue = [...authority], grants = []
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor]
      for (const grant of pending.get(key) || []) {
        grants.push(grant)
        if (grant.grantOption) {
          const enabled = `${grant.grantee}\0${grant.code}`
          if (!authority.has(enabled)) { authority.add(enabled); queue.push(enabled) }
        }
      }
      pending.delete(key)
    }
    if (pending.size) replayFailure()
    plans.push({ name: source.name, owner: source.owner, items, grants })
  }
  if (!plans.length) return null
  const sql = ["BEGIN;"]
  for (const plan of plans) {
    const identity = `n.nspname=${sqlLiteral(plan.name)} AND pg_catalog.pg_get_userbyid(n.nspowner)=${sqlLiteral(plan.owner)}`
    // Recheck the narrow missing-ACL precondition inside the same transaction.
    sql.push(`SELECT 1 / CASE WHEN EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE ${identity} AND n.nspacl IS NULL) THEN 1 ELSE 0 END;`)
    sql.push(`SET LOCAL ROLE ${sqlIdentifier(plan.owner)};`, `REVOKE ALL PRIVILEGES ON SCHEMA ${sqlIdentifier(plan.name)} FROM ${sqlIdentifier(plan.owner)};`, "RESET ROLE;")
    for (const grant of plan.grants) sql.push(`SET LOCAL ROLE ${sqlIdentifier(grant.grantor)};`,
      `GRANT ${grant.code === "U" ? "USAGE" : "CREATE"} ON SCHEMA ${sqlIdentifier(plan.name)} TO ${grant.grantee === null ? "PUBLIC" : sqlIdentifier(grant.grantee)}${grant.grantOption ? " WITH GRANT OPTION" : ""};`, "RESET ROLE;")
    const expectedItems = `ARRAY[${plan.items.map(sqlLiteral).join(",")}]::pg_catalog.text[]`
    // Compare exact item multisets, including grantors/options/duplicates,
    // BEFORE commit. Any remapped grantor or lost privilege aborts the batch.
    sql.push(`SELECT 1 / CASE WHEN EXISTS(SELECT FROM pg_catalog.pg_namespace n WHERE ${identity} AND n.nspacl IS NOT NULL AND ARRAY(SELECT entry::pg_catalog.text FROM pg_catalog.unnest(n.nspacl) entry ORDER BY entry::pg_catalog.text COLLATE pg_catalog."C")=ARRAY(SELECT entry FROM pg_catalog.unnest(${expectedItems}) entry ORDER BY entry COLLATE pg_catalog."C")) THEN 1 ELSE 0 END;`)
  }
  sql.push("COMMIT;")
  const statement = sql.join("\n")
  if (Buffer.byteLength(statement) > 32 * 1024 * 1024) replayFailure()
  return { sql: statement, schemas: plans.length, grants: plans.reduce((sum, plan) => sum + plan.grants.length, 0) }
}
