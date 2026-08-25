export type SpcAmendmentPresentationChange = {
  label?: string | null
}

export function spcAmendmentSummaryLabels(
  changes: SpcAmendmentPresentationChange[],
) {
  const labels = new Set<string>()
  for (const change of changes) {
    const label = typeof change.label === "string"
      ? change.label.trim().replace(/\s+/g, " ")
      : ""
    if (label) labels.add(`${label} Amended`)
  }
  return Array.from(labels)
}
