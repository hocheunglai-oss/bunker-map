import "server-only"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"

export class AuditBrowsingError extends Error {
  constructor(readonly status: 400 | 503, message = status === 400
    ? "Audit history changed or expired. Refresh to start again."
    : "Audit history is temporarily unavailable. Please try again.") { super(message) }
}

export type AuditBrowsePosition = { occurredAt: string; id: string }
export type AuditBrowseGeneration = {
  issuedAt: number
  expiresAt: number
  generation: string
  position: AuditBrowsePosition | null
  watermark: AuditBrowsePosition | null
  mappingDigest: string
}
export type AuditBrowseBinding = {
  scope: "www" | "spc"
  viewerId: string
  permissionDigest: string
  filterDigest: string
  pageSize: number
}
export type AuditBrowseKeyring = { activeKid: string; keys: Map<string, Buffer> }
const TTL = 15 * 60_000
const SKEW = 30_000
const HEX = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!object(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}
export function auditBrowseDigest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")
}
function decode(value: string, length?: number) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding")
  const bytes = Buffer.from(value, "base64url")
  if (bytes.toString("base64url") !== value || length !== undefined && bytes.length !== length) throw new Error("Invalid encoding")
  return bytes
}
export function loadAuditBrowseKeyring(raw = process.env.AUDIT_BROWSING_CURSOR_KEYS_JSON): AuditBrowseKeyring {
  try {
    if (!raw || raw.length > 1024) throw new Error("Missing keyring")
    const value: unknown = JSON.parse(raw)
    if (!object(value) || !exact(value, ["activeKid", "keys"]) || typeof value.activeKid !== "string"
      || !Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 2) throw new Error("Invalid keyring")
    const keys = new Map<string, Buffer>()
    const material = new Set<string>()
    for (const entry of value.keys) {
      if (!object(entry) || !exact(entry, ["kid", "keyBase64url"]) || typeof entry.kid !== "string"
        || !/^[A-Za-z0-9_-]{1,32}$/.test(entry.kid) || keys.has(entry.kid)
        || typeof entry.keyBase64url !== "string") throw new Error("Invalid key")
      const bytes = decode(entry.keyBase64url, 32)
      if (material.has(entry.keyBase64url)) throw new Error("Duplicate key material")
      material.add(entry.keyBase64url)
      keys.set(entry.kid, bytes)
    }
    if (!keys.has(value.activeKid)) throw new Error("Missing active key")
    return { activeKid: value.activeKid, keys }
  } catch { throw new AuditBrowsingError(503) }
}

// Preserve the database's microseconds, including timestamp offsets. Date is
// used only for the whole-second component, never to round a cursor position.
function timestampMicros(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value)
  if (!match || value.startsWith("0000")) throw new Error("Invalid timestamp")
  const plain = Date.parse(`${match[1]}Z`), shifted = Date.parse(`${match[1]}${match[3]}`)
  if (!Number.isFinite(plain) || !Number.isFinite(shifted) || new Date(plain).toISOString().slice(0, 19) !== match[1]) throw new Error("Invalid timestamp")
  return BigInt(shifted) * BigInt(1000) + BigInt((match[2] || "").padEnd(6, "0"))
}
export function validateAuditBrowsePosition(value: unknown): asserts value is AuditBrowsePosition {
  if (!object(value) || !exact(value, ["occurredAt", "id"]) || typeof value.occurredAt !== "string"
    || typeof value.id !== "string" || !UUID.test(value.id)) throw new Error("Invalid position")
  timestampMicros(value.occurredAt)
}
export function compareAuditBrowsePositions(a: AuditBrowsePosition, b: AuditBrowsePosition) {
  const x = timestampMicros(a.occurredAt), y = timestampMicros(b.occurredAt)
  return x === y ? a.id < b.id ? -1 : a.id > b.id ? 1 : 0 : x < y ? -1 : 1
}
function aad(binding: AuditBrowseBinding, kid: string) {
  if (!binding.viewerId || !["www", "spc"].includes(binding.scope) || !HEX.test(binding.permissionDigest)
    || !HEX.test(binding.filterDigest) || !Number.isSafeInteger(binding.pageSize) || binding.pageSize < 1 || binding.pageSize > 150) throw new AuditBrowsingError(503)
  return Buffer.from(JSON.stringify(canonical({ purpose: "fcuno-audit-browse", version: 1, kid, ...binding })))
}
function validateGeneration(value: unknown, now: number): asserts value is AuditBrowseGeneration {
  if (!object(value) || !exact(value, ["issuedAt", "expiresAt", "generation", "position", "watermark", "mappingDigest"])
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || Number(value.issuedAt) > now + SKEW || Number(value.expiresAt) <= now
    || Number(value.expiresAt) - Number(value.issuedAt) !== TTL
    || typeof value.generation !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(value.generation)
    || typeof value.mappingDigest !== "string" || !HEX.test(value.mappingDigest)) throw new Error("Invalid generation")
  if (value.position !== null) validateAuditBrowsePosition(value.position)
  if (value.watermark !== null) validateAuditBrowsePosition(value.watermark)
  if (value.position && (!value.watermark || compareAuditBrowsePositions(value.position as AuditBrowsePosition, value.watermark as AuditBrowsePosition) > 0)) throw new Error("Invalid watermark")
}
export function startAuditBrowseGeneration(mappingDigest: string, now = Date.now()): AuditBrowseGeneration {
  return { issuedAt: now, expiresAt: now + TTL, generation: randomBytes(16).toString("base64url"), position: null, watermark: null, mappingDigest }
}
export function sealAuditBrowseCursor(generation: AuditBrowseGeneration, binding: AuditBrowseBinding, ring: AuditBrowseKeyring, now = Date.now()) {
  validateGeneration(generation, now)
  const kid = ring.activeKid, nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", ring.keys.get(kid)!, nonce)
  cipher.setAAD(aad(binding, kid))
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(generation)), cipher.final()])
  return ["ab1", kid, nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".")
}
export function openAuditBrowseCursor(token: string, binding: AuditBrowseBinding, ring: AuditBrowseKeyring, now = Date.now()): AuditBrowseGeneration {
  try {
    if (token.length > 4096) throw new Error("Invalid token")
    const parts = token.split(".")
    if (parts.length !== 5 || parts[0] !== "ab1" || !/^[A-Za-z0-9_-]{1,32}$/.test(parts[1])) throw new Error("Invalid token")
    const key = ring.keys.get(parts[1])
    if (!key) throw new Error("Invalid key")
    const decipher = createDecipheriv("aes-256-gcm", key, decode(parts[2], 12))
    decipher.setAAD(aad(binding, parts[1]))
    decipher.setAuthTag(decode(parts[4], 16))
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(decode(parts[3])), decipher.final()]).toString("utf8"))
    validateGeneration(value, now)
    return value
  } catch { throw new AuditBrowsingError(400) }
}
