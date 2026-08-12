type SpcSessionPresentationInput = {
  role: string | null | undefined
  displayName: string | null | undefined
  username: string | null | undefined
}

function cleanLabel(value: string | null | undefined) {
  return value?.trim() || ""
}

export function getSpcSessionPresentationLabel({
  displayName,
  username,
}: SpcSessionPresentationInput) {
  return cleanLabel(displayName) || cleanLabel(username)
}
