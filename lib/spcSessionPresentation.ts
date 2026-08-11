import { normaliseSpcRole } from "@/lib/spcPages"

type SpcSessionPresentationInput = {
  role: string | null | undefined
  displayName: string | null | undefined
  username: string | null | undefined
}

function cleanLabel(value: string | null | undefined) {
  return value?.trim() || ""
}

export function getSpcSessionPresentationLabel({
  role,
  displayName,
  username,
}: SpcSessionPresentationInput) {
  if (normaliseSpcRole(role) === "ADMIN") return "ADMINISTRATOR"
  return cleanLabel(displayName) || cleanLabel(username)
}
