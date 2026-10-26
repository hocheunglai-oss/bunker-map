import { createHash } from "node:crypto"
import { evaluateOptionalBackupBudget, validateBackupBudgetObservation, backupTargetKey } from "../../lib/backupOperatingPolicy.mjs"

const MAX_BYTES = 16 * 1024
const fail = () => { throw new Error("Backup budget control could not be authenticated") }
function exact(value, fields) {
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== fields.length || fields.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"))) fail()
}
const identity = value => { backupTargetKey(value); return JSON.stringify([value.bucket, value.objectName, value.generation]) }
const sha = bytes => createHash("sha256").update(bytes).digest("hex")

// No token handling, provider requests, filesystem or mutation APIs. Transport
// MUST authenticate GCS and enforce the pinned bucket IAM/writer boundary;
// CRC/custom metadata or a payload's source string alone are not authenticity.
// inspectPrivateBucket -> {name,projectId,publicAccessPrevention,
//   uniformBucketLevelAccess,trustedBudgetWritersOnly}.
// inspectControl({bucket,objectName[,generation]}) -> {target,sizeBytes,byteSha256}.
// readControl(exactTarget) -> {target,bytes:Uint8Array}.
export function createBackupBudgetGuard({ policy, control, transport, now = Date.now }) {
  exact(control, ["bucket", "objectName", "prefix"])
  if (typeof now !== "function" || typeof control.bucket !== "string" || !control.bucket ||
      typeof control.prefix !== "string" || !/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(control.prefix) || control.prefix.endsWith("/") || control.prefix.includes("//") ||
      typeof control.objectName !== "string" || !control.objectName.startsWith(`${control.prefix}/`) ||
      control.objectName.length > 1024 || /[\x00-\x1f\x7f]/.test(control.objectName) || !control.objectName.isWellFormed() ||
      !["inspectPrivateBucket", "inspectControl", "readControl"].every(key => typeof transport?.[key] === "function")) fail()
  // Validate pinned policy even when no observation is available. This does
  // not accept native-currency provenance from an untrusted control document.
  evaluateOptionalBackupBudget(null, { ...policy, now: now() })
  const options = () => ({ ...policy, now: now() })
  const active = context => {
    if (typeof context?.signal?.throwIfAborted !== "function" || !Number.isSafeInteger(context.deadline) || !Number.isSafeInteger(now()) || now() >= context.deadline) fail()
    context.signal.throwIfAborted()
  }
  const call = async (name, value, context) => {
    active(context)
    // Fail within the caller's deadline even for non-cooperative transports.
    const remaining = context.deadline - now()
    const signal = AbortSignal.any([context.signal, AbortSignal.timeout(remaining)])
    return new Promise((resolve, reject) => {
      let settled = false
      const abort = () => { if (!settled) { settled = true; reject(new Error("Backup budget read cancelled")) } }
      signal.addEventListener("abort", abort, { once: true })
      Promise.resolve().then(() => transport[name](value, { signal, deadline: context.deadline })).then(result => {
        signal.removeEventListener("abort", abort)
        if (settled || signal.aborted) { if (!settled) abort(); return }
        settled = true
        try { active(context); resolve(result) } catch (error) { reject(error) }
      }, error => { signal.removeEventListener("abort", abort); if (!settled) { settled = true; reject(error) } })
      if (signal.aborted) abort()
    })
  }
  const receipt = value => {
    exact(value, ["target", "sizeBytes", "byteSha256"])
    identity(value.target)
    if (value.target.bucket !== control.bucket || value.target.objectName !== control.objectName || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_BYTES ||
        typeof value.byteSha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.byteSha256)) fail()
    return value
  }
  async function readObservation(context) {
    const bucket = await call("inspectPrivateBucket", { bucket: control.bucket }, context)
    exact(bucket, ["name", "projectId", "publicAccessPrevention", "uniformBucketLevelAccess", "trustedBudgetWritersOnly"])
    if (bucket.name !== control.bucket || bucket.projectId !== policy.projectId || bucket.publicAccessPrevention !== "enforced" || bucket.uniformBucketLevelAccess !== true || bucket.trustedBudgetWritersOnly !== true) fail()
    const selected = receipt(await call("inspectControl", { bucket: control.bucket, objectName: control.objectName }, context))
    const result = await call("readControl", selected.target, context)
    exact(result, ["target", "bytes"])
    if (identity(result.target) !== identity(selected.target) || !(result.bytes instanceof Uint8Array) || result.bytes.byteLength !== selected.sizeBytes || sha(result.bytes) !== selected.byteSha256) fail()
    const text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes)
    const parsed = JSON.parse(text), observation = validateBackupBudgetObservation(parsed)
    // The producer writes this exact normalized form. This also rejects
    // duplicate JSON keys, trailing data and prototype-shaped extra fields.
    if (JSON.stringify(observation) !== text) fail()
    const final = receipt(await call("inspectControl", selected.target, context))
    if (identity(final.target) !== identity(selected.target) || final.sizeBytes !== selected.sizeBytes || final.byteSha256 !== selected.byteSha256) fail()
    return observation
  }
  return Object.freeze({
    async checkOptionalWork(_input, context) {
      try {
        const decision = evaluateOptionalBackupBudget(await readObservation(context), options())
        return { ...decision, allowed: decision.optionalWorkAllowed }
      } catch {
        // Do not leak private object paths, provider error bodies or tokens.
        return { ...evaluateOptionalBackupBudget(null, options()), allowed: false, reason: "budget_control_unavailable" }
      }
    },
  })
}
