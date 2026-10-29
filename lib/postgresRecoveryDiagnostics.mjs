// Deliberately contains no error messages, SQL, identifiers, arguments, rows or
// process environments. Diagnostics are hints, never a recovery acceptance.
import { RECOVERY_CATALOG_KEYS } from "./postgresRecoveryCatalog.mjs"

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
export function validateRecoveryDiagnostic(value) {
  exact(value, ["schema", "status", "stage", "elapsedMs", "native", "catalog", "cleanup"])
  if (value.schema !== "fcuno.private-recovery-diagnostic/v1" || !["running", "failed", "complete"].includes(value.status) ||
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
  return value
}
export function createRecoveryDiagnostics({ now = Date.now, save = async () => {} } = {}) {
  const began = now()
  let value = { schema: "fcuno.private-recovery-diagnostic/v1", status: "running", stage: "runtime-check", elapsedMs: 0, native: null, catalog: [], cleanup: "not-started" }
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
