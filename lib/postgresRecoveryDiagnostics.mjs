// Deliberately contains no error messages, SQL, identifiers, arguments, rows or
// process environments. Diagnostics are hints, never a recovery acceptance.
import { RECOVERY_CATALOG_KEYS } from "./postgresRecoveryCatalog.mjs"
import { isDeepStrictEqual } from "node:util"
import { summarizeRecoveryAclTextDifference } from "./postgresRecoveryAcl.mjs"

export const RECOVERY_DIAGNOSTIC_STAGES = Object.freeze([
  "runtime-check", "input-read", "manifest-verification", "archive-verification", "catalog-scope", "workspace-setup",
  "binary-validation", "initdb", "start-server", "create-operator", "restore-roles", "restore-memberships", "read-toc",
  "bootstrap-restore", "create-extensions", "verify-extensions", "restore-archive", "restore-role-settings",
  "verify-catalog", "verify-tables", "compare-table-rows", "compare-sequences", "verify-database", "verify-memberships",
  "verify-roles", "verify-login-roles", "verify-vault", "write-success", "complete",
])
const programs = ["initdb", "pgCtl", "psql", "pgRestore", "sort"]
const signals = ["SIGABRT", "SIGALRM", "SIGBUS", "SIGFPE", "SIGHUP", "SIGILL", "SIGINT", "SIGKILL", "SIGPIPE", "SIGQUIT", "SIGSEGV", "SIGTERM", "SIGXCPU", "SIGXFSZ"]
const stderrHints = ["generic", "permission-denied", "object-exists", "missing-object", "unsupported-setting", "statement-timeout", "memory"]
// Hints from untrusted error text are NOT a proven cause. Retain at most 8 KiB
// transiently, expose only a fixed enum, and never persist the text itself.
export function createNativeStderrHint() {
  let tail = Buffer.alloc(0), hint = "generic"
  const patterns = [
    ["statement-timeout", /(?:ERROR|FATAL):[^\n]*canceling statement due to statement timeout/],
    ["memory", /(?:ERROR|FATAL):[^\n]*(?:out of memory|memory exhausted|could not allocate memory)/],
    ["permission-denied", /(?:ERROR|FATAL):[^\n]*(?:permission denied|must be (?:owner|superuser))/],
    ["object-exists", /(?:ERROR|FATAL):[^\n]*already exists/],
    ["missing-object", /(?:ERROR|FATAL):[^\n]*(?:does not exist|could not open extension control file)/],
    ["unsupported-setting", /(?:ERROR|FATAL):[^\n]*(?:unrecognized configuration parameter|invalid value for parameter)/],
  ]
  return Object.freeze({
    write(chunk) {
      if (!(chunk instanceof Uint8Array)) return
      tail = Buffer.from(Buffer.concat([tail, chunk.subarray(Math.max(0, chunk.length - 8192))]).subarray(-8192))
      const text = tail.toString("utf8")
      if (hint === "generic") hint = patterns.find(([, pattern]) => pattern.test(text))?.[0] || "generic"
    },
    value: () => hint,
  })
}
const fail = () => { throw new Error("Private recovery diagnostic invalid") }
const exact = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail()
}
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000
const fields = Object.freeze({
  schemas: ["name", "owner", "acl", "comment"],
  relations: ["schema", "name", "kind", "owner", "acl", "rls", "force_rls", "options", "comment"],
  columns: ["schema", "relation", "position", "name", "type", "not_null", "identity", "generated", "storage", "compression", "default", "collation", "collation_schema", "comment"],
  constraints: ["schema", "relation", "name", "type", "validated", "deferrable", "deferred", "definition"],
  indexes: ["schema", "relation", "name", "definition", "valid", "ready"],
  triggers: ["schema", "relation", "name", "enabled", "definition"],
  policies: ["schema", "relation", "name", "permissive", "roles", "cmd", "qual", "with_check"],
  functions: ["schema", "name", "identity", "definition", "owner", "acl", "comment"],
  views: ["schema", "name", "kind", "definition"],
  sequences: ["schema", "name", "type", "start", "increment", "max", "min", "cache", "cycle"],
  types: ["schema", "name", "kind", "owner", "acl", "not_null", "base_type", "default", "enum_values"],
  extensionTables: ["schema", "name", "extension", "config", "condition"],
})
const maximumDetailFields = 24
const mismatchKinds = ["missingExpected", "missingActual", "typeMismatch", "stringMismatch", "otherMismatch"]
const aclKinds = ["nullToValue", "valueToNull", "equivalent", "changed", "invalid", "missingEntries", "extraEntries"]
const zero = names => Object.fromEntries(names.map(name => [name, 0]))
const record = value => value !== null && typeof value === "object" && !Array.isArray(value)
const valueType = value => value === null ? "null" : Array.isArray(value) ? "array" : typeof value
// Same array-position alignment as the real verifier; never join by or retain
// private identifiers. Detail is advisory only and cannot alter `equal`.
export function describeRecoveryCatalogDifferences(expected, actual, catalog) {
  let slots = maximumDetailFields
  return catalog.filter(item => !item.equal).map(({ section }) => {
    const left = expected[section], right = actual[section], known = fields[section]
    if (!known || !Array.isArray(left) || !Array.isArray(right) || !count(left.length) || !count(right.length)) fail()
    const byField = new Map(known.map(field => [field, { field, ...zero(mismatchKinds), acl: field === "acl" ? zero(aclKinds) : null }]))
    const detail = { section, alignment: "array-position", rowsCompared: Math.min(left.length, right.length),
      missingExpectedRows: Math.max(0, right.length - left.length), missingActualRows: Math.max(0, left.length - right.length),
      invalidRows: 0, unknownFieldRows: 0, fields: [], truncated: false }
    for (let index = 0; index < detail.rowsCompared; index++) {
      const a = left[index], b = right[index]
      if (!record(a) || !record(b)) { detail.invalidRows++; continue }
      if ([...Object.keys(a), ...Object.keys(b)].some(key => !known.includes(key))) detail.unknownFieldRows++
      for (const field of known) {
        const item = byField.get(field), hasA = Object.hasOwn(a, field), hasB = Object.hasOwn(b, field)
        if (!hasA || !hasB) { if (hasA) item.missingActual++; else if (hasB) item.missingExpected++; continue }
        if (isDeepStrictEqual(a[field], b[field])) continue
        if (valueType(a[field]) !== valueType(b[field])) item.typeMismatch++
        else if (typeof a[field] === "string") item.stringMismatch++
        else item.otherMismatch++
        if (item.acl) {
          const summary = summarizeRecoveryAclTextDifference(a[field], b[field])
          const key = { "null-to-value": "nullToValue", "value-to-null": "valueToNull", equivalent: "equivalent", changed: "changed", invalid: "invalid" }[summary.kind]
          item.acl[key]++; item.acl.missingEntries += summary.missingEntries; item.acl.extraEntries += summary.extraEntries
        }
      }
    }
    for (const item of byField.values()) if (mismatchKinds.some(key => item[key] > 0)) {
      if (slots > 0) { detail.fields.push(item); slots-- } else detail.truncated = true
    }
    return detail
  })
}
function validateCatalogDifferences(value) {
  if (!Array.isArray(value.catalogDifferences) || value.catalogDifferences.length > RECOVERY_CATALOG_KEYS.length) fail()
  const seen = new Set(); let fieldCount = 0
  for (const detail of value.catalogDifferences) {
    exact(detail, ["section", "alignment", "rowsCompared", "missingExpectedRows", "missingActualRows", "invalidRows", "unknownFieldRows", "fields", "truncated"])
    const item = value.catalog.find(item => item.section === detail.section)
    if (!item || item.equal || seen.has(detail.section) || detail.alignment !== "array-position" || typeof detail.truncated !== "boolean" ||
        ![detail.rowsCompared, detail.missingExpectedRows, detail.missingActualRows, detail.invalidRows, detail.unknownFieldRows].every(count) ||
        detail.rowsCompared !== Math.min(item.expectedCount, item.actualCount) || detail.missingExpectedRows !== Math.max(0, item.actualCount - item.expectedCount) ||
        detail.missingActualRows !== Math.max(0, item.expectedCount - item.actualCount) || detail.invalidRows > detail.rowsCompared || detail.unknownFieldRows > detail.rowsCompared ||
        !Array.isArray(detail.fields) || (fieldCount += detail.fields.length) > maximumDetailFields) fail()
    seen.add(detail.section)
    const seenFields = new Set()
    for (const entry of detail.fields) {
      exact(entry, ["field", ...mismatchKinds, "acl"])
      if (!fields[detail.section]?.includes(entry.field) || seenFields.has(entry.field) ||
          !mismatchKinds.every(key => count(entry[key])) || !mismatchKinds.some(key => entry[key] > 0) ||
          mismatchKinds.reduce((sum, key) => sum + entry[key], 0) > detail.rowsCompared) fail()
      seenFields.add(entry.field)
      if (entry.field === "acl") {
        exact(entry.acl, aclKinds)
        if (!aclKinds.every(key => Number.isSafeInteger(entry.acl[key]) && entry.acl[key] >= 0 && entry.acl[key] <= 10000000000) ||
            ["nullToValue", "valueToNull", "equivalent", "changed", "invalid"].reduce((sum, key) => sum + entry.acl[key], 0) !==
            entry.typeMismatch + entry.stringMismatch + entry.otherMismatch) fail()
      } else if (entry.acl !== null) fail()
    }
  }
  if (value.status === "complete" && value.catalogDifferences.length) fail()
}
export function validateRecoveryDiagnostic(value) {
  const version2 = value?.schema === "fcuno.private-recovery-diagnostic/v2"
  exact(value, ["schema", "status", "stage", "elapsedMs", "native", "catalog", "cleanup", ...(version2 ? ["catalogDifferences"] : [])])
  if ((!version2 && value.schema !== "fcuno.private-recovery-diagnostic/v1") || !["running", "failed", "complete"].includes(value.status) ||
      !RECOVERY_DIAGNOSTIC_STAGES.includes(value.stage) || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 86400000 ||
      !["not-started", "pending", "ok", "failed"].includes(value.cleanup) || !Array.isArray(value.catalog) || value.catalog.length > RECOVERY_CATALOG_KEYS.length) fail()
  if (value.native !== null) {
    exact(value.native, ["program", "exitCode", "signal", "stderrHint"])
    if (!programs.includes(value.native.program) || (value.native.exitCode !== null && (!Number.isInteger(value.native.exitCode) || value.native.exitCode < 0 || value.native.exitCode > 255)) ||
        (value.native.signal !== null && !signals.includes(value.native.signal)) || !stderrHints.includes(value.native.stderrHint)) fail()
  }
  const seen = new Set()
  for (const item of value.catalog) {
    exact(item, ["section", "expectedCount", "actualCount", "equal"])
    if (!RECOVERY_CATALOG_KEYS.includes(item.section) || seen.has(item.section) || !count(item.expectedCount) || !count(item.actualCount) || typeof item.equal !== "boolean") fail()
    seen.add(item.section)
  }
  if (version2) validateCatalogDifferences(value)
  if (Buffer.byteLength(JSON.stringify(value)) > 12288) fail()
  return value
}
export function createRecoveryDiagnostics({ now = Date.now, save = async () => {} } = {}) {
  const began = now()
  let value = { schema: "fcuno.private-recovery-diagnostic/v2", status: "running", stage: "runtime-check", elapsedMs: 0, native: null, catalog: [], cleanup: "not-started", catalogDifferences: [] }
  function snapshot() {
    const elapsed = now() - began
    value.elapsedMs = Number.isFinite(elapsed) ? Math.max(0, Math.min(86400000, Math.floor(elapsed))) : 0
    return structuredClone(validateRecoveryDiagnostic(value))
  }
  const persist = () => save(snapshot())
  return Object.freeze({
    snapshot,
    async stage(stage) { if (!RECOVERY_DIAGNOSTIC_STAGES.includes(stage)) fail(); value.stage = stage; value.native = null; await persist() },
    // Only these allowlisted primitives and one heuristic enum may be retained.
    native(program, exitCode, signal, stderrHint = "generic") {
      if (!programs.includes(program)) fail()
      value.native = { program, exitCode: Number.isInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? exitCode : null,
        signal: signals.includes(signal) ? signal : null, stderrHint: stderrHints.includes(stderrHint) ? stderrHint : "generic" }
    },
    async catalog(expected, actual, same) {
      value.catalog = RECOVERY_CATALOG_KEYS.map(section => ({ section, expectedCount: expected[section].length,
        actualCount: actual[section].length, equal: same(expected[section], actual[section], section) }))
      value.catalogDifferences = describeRecoveryCatalogDifferences(expected, actual, value.catalog)
      await persist()
    },
    async cleanup(status) { if (!["pending", "ok", "failed"].includes(status)) fail(); value.cleanup = status; await persist() },
    async failed() { value.status = "failed"; await persist() },
    async complete() { value.status = "complete"; value.stage = "complete"; await persist() },
  })
}
export function validateRecoveryFailureHost(value) {
  exact(value, ["schema", "dockerRunExitCode", "state"])
  if (value.schema !== "fcuno.private-recovery-host-outcome/v1" || !Number.isInteger(value.dockerRunExitCode) || value.dockerRunExitCode < 0 || value.dockerRunExitCode > 255) fail()
  if (value.state !== null) {
    exact(value.state, ["Status", "Running", "ExitCode", "OOMKilled"])
    if (!["created", "running", "paused", "restarting", "removing", "exited", "dead"].includes(value.state.Status) ||
        typeof value.state.Running !== "boolean" || typeof value.state.OOMKilled !== "boolean" ||
        !Number.isInteger(value.state.ExitCode) || value.state.ExitCode < 0 || value.state.ExitCode > 255) fail()
  }
  return value
}
export function recoveryFailure({ host, diagnostic = null }) {
  validateRecoveryFailureHost(host)
  if (diagnostic !== null) validateRecoveryDiagnostic(diagnostic)
  return host.dockerRunExitCode !== 0 || !host.state || host.state.Status !== "exited" || host.state.Running ||
    host.state.ExitCode !== 0 || host.state.OOMKilled || diagnostic?.status !== "complete" || diagnostic?.stage !== "complete" || diagnostic?.cleanup !== "ok"
}
