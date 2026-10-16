import { readSpcEnquiryMeta } from "@/lib/spcEnquiryText"

export type SpcHistoricalMatch<T> = {
  at: number
  value: T
  identityKeys: readonly string[]
}

export function normalizeSpcVesselIdentity(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/gi, " ")
    .trim()
    .toLowerCase()
}

export function cleanSpcImo(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "")
  return digits.length === 7 ? digits : ""
}

export function spcVesselIdentityKeysFromValues(
  vesselName: string | null | undefined,
  imo: string | null | undefined,
) {
  const cleanImo = cleanSpcImo(imo)
  const vessel = normalizeSpcVesselIdentity(vesselName)
  return [cleanImo ? `imo:${cleanImo}` : "", vessel ? `vessel:${vessel}` : ""].filter(Boolean)
}

export function spcVesselIdentityKeys(
  vesselName: string | null | undefined,
  notes: string | null | undefined,
) {
  return spcVesselIdentityKeysFromValues(vesselName, readSpcEnquiryMeta(notes).imo)
}

export function spcVesselIdentitiesMatch(targetKeys: readonly string[], candidateKeys: readonly string[]) {
  const targetImo = targetKeys.find((key) => key.startsWith("imo:"))
  const candidateImo = candidateKeys.find((key) => key.startsWith("imo:"))

  if (targetImo && candidateImo) return targetImo === candidateImo

  const targetVessel = targetKeys.find((key) => key.startsWith("vessel:"))
  const candidateVessel = candidateKeys.find((key) => key.startsWith("vessel:"))
  return Boolean(targetVessel && candidateVessel && targetVessel === candidateVessel)
}

export function addSpcHistoricalMatch<T>(
  map: Map<string, SpcHistoricalMatch<T>[]>,
  keys: string[],
  match: Omit<SpcHistoricalMatch<T>, "identityKeys">,
) {
  const candidate: SpcHistoricalMatch<T> = { ...match, identityKeys: [...keys] }
  for (const key of keys) {
    const matches = map.get(key) || []
    matches.push(candidate)
    map.set(key, matches)
  }
}

export function firstPreviousSpcIdentityMatch<T>(
  map: Map<string, SpcHistoricalMatch<T>[]>,
  keys: string[],
  before: string,
) {
  const beforeTime = Date.parse(before)
  for (const key of keys) {
    const candidates = [...(map.get(key) || [])].sort((left, right) => right.at - left.at)
    const match = candidates.find((candidate) =>
      candidate.at < beforeTime && spcVesselIdentitiesMatch(keys, candidate.identityKeys),
    )
    if (match) return match.value
  }
  return null
}
