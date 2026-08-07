export function escapeGoogleDriveQueryLiteral(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
}

export function buildGoogleDriveFolderLookupQuery(parentId: string, name: string) {
  return `trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = '${escapeGoogleDriveQueryLiteral(name)}' and '${escapeGoogleDriveQueryLiteral(parentId)}' in parents`
}

export function quotePostgrestFilterValue(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function buildPostgrestCountryMatchFilter(
  countryId: string,
  countryName: string,
  nameOperator: "eq" | "ilike",
) {
  return `country_id.eq.${quotePostgrestFilterValue(countryId)},country_name.${nameOperator}.${quotePostgrestFilterValue(countryName)}`
}
