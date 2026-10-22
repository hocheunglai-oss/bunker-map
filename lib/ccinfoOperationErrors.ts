type RpcError = { code?: string; message?: string; details?: string }

const country = ["The country changed or was removed. Reopen it before renaming."]
const deletionBaseline = ["The entry changed or was removed. Refresh it before deleting."]
const deletionUnconfirmed = [
  "The port deletion could not be verified. No entries were deleted.",
  "A deleted port is still present. No entries were deleted.",
  "The deletion could not be verified. No entries were deleted.",
  "The deleted entry is still present. No entries were deleted.",
  "The preserved ports could not be verified. No entries were deleted.",
  "The existing file cascade could not be verified. No entries were deleted.",
]
const folder = [
  "This entry was removed. Reopen it.",
  "This folder changed. Reopen it before renaming.",
  "This folder changed or was removed. Reopen it.",
  "The destination folder changed or was removed. Reopen it.",
  "This folder changed. Reopen it before deleting.",
]
const file = ["This file changed or was removed. Reopen it."]
const destination = [
  "The entry was removed. Reopen it.",
  "The destination was removed. Reopen it.",
  "The destination changed or was removed. Reopen it.",
]

// Match only individually identified business RAISE sites. Genuine engine40001
// and unrelated P0001 failures must not look like a colleague's saved edit.
function matches(error: RpcError, detail: string, messages: string[]) {
  return typeof error.message === "string" && messages.includes(error.message)
    && ((error.code === "P0001" && error.details === detail) || error.code === "40001")
}

export const isCcinfoCountryConflict = (error: RpcError) => matches(error, "CCINFO_COUNTRY_CONFLICT", country)
export function classifyCcinfoDeleteError(error: RpcError): "conflict" | "unconfirmed" | null {
  if (matches(error, "CCINFO_DELETE_CONFLICT", deletionBaseline)) return "conflict"
  if (matches(error, "CCINFO_DELETE_UNCONFIRMED", deletionUnconfirmed)) return "unconfirmed"
  return null
}
export const isCcinfoFolderConflict = (error: RpcError) => matches(error, "CCINFO_FOLDER_CONFLICT", folder)
export const isCcinfoFileConflict = (error: RpcError) => matches(error, "CCINFO_FILE_CONFLICT", file)
  || matches(error, "CCINFO_FILE_TARGET_CONFLICT", destination)
