import { PriceSetterValidationError, validatePriceSetterCreation, type PriceSetterCreation } from "@/lib/priceSetterMutation"

export type PriceSetterCreationState = {
  actorId: string
  version: string
  pending: { requestId: string; kind: "port" | "divider" } | null
}
export type OwnedPriceSetterCreation = PriceSetterCreation & { actorId: string; expectedVersion: string }
const uuid = /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i
const isUuid = (value: unknown): value is string => typeof value === "string" && uuid.test(value)
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
function version(value: unknown): value is string {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,18})$/.test(value)
    && (value.length < 19 || value <= "9223372036854775807")
}

// Only the request-aware authenticated session can supply this value. A cached
// browser actor, body field or username must never substitute for a missing ID.
export function authenticatedCreationActor(value: unknown) {
  if (!isUuid(value)) throw Error("Unauthorized")
  return value.toLowerCase()
}

export function confirmPriceSetterCreationState(value: unknown, expectedActor?: string): PriceSetterCreationState {
  if (!record(value) || !keys(value, ["actorId", "version", "pending"]) || !isUuid(value.actorId)
    || value.actorId !== value.actorId.toLowerCase() || expectedActor !== undefined && value.actorId !== expectedActor
    || !version(value.version)) throw Error("Could not check previous additions. Reload before adding a row.")
  if (value.pending !== null && (!record(value.pending) || !keys(value.pending, ["requestId", "kind"])
    || !isUuid(value.pending.requestId) || value.pending.requestId !== value.pending.requestId.toLowerCase()
    || !["port", "divider"].includes(value.pending.kind as string) || value.version === "0")) {
    throw Error("Could not check previous additions. Reload before adding a row.")
  }
  return value as PriceSetterCreationState
}

export function validateOwnedPriceSetterCreation(value: unknown): OwnedPriceSetterCreation {
  if (!record(value) || !keys(value, ["operation", "requestId", "kind", "actorId", "expectedVersion"])
    || !isUuid(value.actorId) || !version(value.expectedVersion)) {
    throw new PriceSetterValidationError("Reload the page before adding a row. Your page may be out of date.")
  }
  const base = validatePriceSetterCreation({ operation: value.operation, requestId: value.requestId, kind: value.kind })
  return { ...base, actorId: value.actorId.toLowerCase(), expectedVersion: value.expectedVersion }
}

export function validatePriceSetterAcknowledgement(value: unknown) {
  if (!record(value) || !keys(value, ["actorId", "requestId"]) || !isUuid(value.actorId) || !isUuid(value.requestId)) {
    throw new PriceSetterValidationError("Reload before checking the earlier addition.")
  }
  return { actorId: value.actorId.toLowerCase(), requestId: value.requestId.toLowerCase() }
}

export function confirmPriceSetterAcknowledgement(value: unknown, input: { actorId: string; requestId: string }) {
  if (!record(value) || !keys(value, ["actorId", "requestId", "acknowledged"]) || value.actorId !== input.actorId
    || value.requestId !== input.requestId || value.acknowledged !== true) throw Error("Could not confirm the earlier addition was checked. Please retry.")
  return value as { actorId: string; requestId: string; acknowledged: true }
}
