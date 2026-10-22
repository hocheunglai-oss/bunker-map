type SpcWriteDomain = "supplier" | "stem" | "fixture"

// A local draft/receipt conflict is not a database serialization failure.
export class SpcLocalWriteConflict extends Error {
  readonly code = "SPC_LOCAL_WRITE_CONFLICT"
}

const supplierCasMessage = "Supplier data changed. Reload and retry the save."
const supplierCasDetail = "supplier-store-cas-contention"
const refusals: Record<SpcWriteDomain, ReadonlyArray<readonly [string, string, string | null]>> = {
  supplier: [
    [supplierCasMessage, supplierCasDetail, supplierCasDetail],
    ["Supplier data was not saved.", "supplier-store-write-unconfirmed", null],
    ["Supplier audit was not saved. No changes were applied.", "supplier-store-write-unconfirmed", null],
  ],
  stem: [
    ["This STEM request no longer matches the saved enquiry. Refresh and try again.", "SPC_STEM_CONFLICT", null],
    ["The fixture for this STEM is no longer available. Refresh and ask an administrator to review it.", "SPC_STEM_CONFLICT", null],
    ["This enquiry changed while you were editing. Refresh and try again.", "SPC_STEM_CONFLICT", null],
    ["This enquiry already has a fixture. Refresh and ask an administrator to review it.", "SPC_STEM_CONFLICT", null],
    ["The STEM enquiry was not saved. Refresh and review before trying again.", "SPC_STEM_UNCONFIRMED", null],
    ["The STEM fixture was not created. Your enquiry was not changed. Refresh and try again.", "SPC_STEM_UNCONFIRMED", null],
  ],
  fixture: [
    ["This fixture is no longer available. Refresh and try again.", "SPC_FIXTURE_CONFLICT", null],
    ["This fixture changed while you were editing. Your draft was not saved. Refresh and review the latest fixture.", "SPC_FIXTURE_CONFLICT", null],
    ["The fixture was not deleted. Refresh and review the latest fixture.", "SPC_FIXTURE_UNCONFIRMED", null],
    ["The fixture was not saved. Refresh and review the latest fixture.", "SPC_FIXTURE_UNCONFIRMED", null],
    ["The fixture supplier could not be synchronized. Your draft was not saved. Refresh and try again.", "SPC_FIXTURE_UNCONFIRMED", null],
  ],
}

export function spcWriteRefusalMessage(error: unknown, domain: SpcWriteDomain): string | null {
  if (error instanceof SpcLocalWriteConflict) return error.message
  if (!error || typeof error !== "object" || !("code" in error) || !("message" in error)) return null
  const details = "details" in error ? error.details : null
  const tuple = refusals[domain].find(([message, marker, legacyDetails]) => error.message === message && (
    (error.code === "P0001" && details === marker)
    || (error.code === "40001" && (details ?? null) === legacyDetails)
  ))
  return tuple?.[0] ?? null
}

// Only these two SQL guards mean a supplier writer won the baseline. Never
// CAS-retry a rolled-back write/audit acknowledgement failure.
export function isSpcSupplierCasContention(error: unknown): boolean {
  return spcWriteRefusalMessage(error, "supplier") === supplierCasMessage
    && !(error instanceof SpcLocalWriteConflict)
}

export function isUnclassifiedSpcDatabaseError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error
    && error.code && error.code !== "22023" && error.code !== "42501")
}
