import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  buildGoogleDriveFolderLookupQuery,
  buildPostgrestCountryMatchFilter,
  escapeGoogleDriveQueryLiteral,
  quotePostgrestFilterValue,
} from "@/lib/queryEscaping"

function googleDriveQueryStructure(query: string) {
  let inLiteral = false
  let structure = ""

  for (let index = 0; index < query.length; index += 1) {
    const character = query[index]
    if (inLiteral && character === "\\") {
      index += 1
      continue
    }
    if (character === "'") {
      inLiteral = !inLiteral
      continue
    }
    if (!inLiteral) structure += character
  }

  assert.equal(inLiteral, false, "Google Drive query literals must remain balanced")
  return structure
}

function splitPostgrestFilterClauses(filter: string) {
  const clauses: string[] = []
  let start = 0
  let inQuotedValue = false

  for (let index = 0; index < filter.length; index += 1) {
    const character = filter[index]
    if (inQuotedValue && character === "\\") {
      index += 1
      continue
    }
    if (character === '"') {
      inQuotedValue = !inQuotedValue
      continue
    }
    if (!inQuotedValue && character === ",") {
      clauses.push(filter.slice(start, index))
      start = index + 1
    }
  }

  assert.equal(inQuotedValue, false, "PostgREST quoted values must remain balanced")
  clauses.push(filter.slice(start))
  return clauses
}

test("Google Drive folder lookup preserves ordinary folder names", () => {
  assert.equal(escapeGoogleDriveQueryLiteral("Bunker Map Backups"), "Bunker Map Backups")
  assert.equal(
    buildGoogleDriveFolderLookupQuery("root-folder-id", "Bunker Map Backups"),
    "trashed = false and mimeType = 'application/vnd.google-apps.folder' and name = 'Bunker Map Backups' and 'root-folder-id' in parents",
  )
})

test("Google Drive folder lookup escapes backslashes before apostrophes", () => {
  const maliciousName = "Reports\\' or trashed = false or name = 'Owned"
  const query = buildGoogleDriveFolderLookupQuery("root-folder-id", maliciousName)

  assert.equal(
    escapeGoogleDriveQueryLiteral(maliciousName),
    "Reports\\\\\\' or trashed = false or name = \\'Owned",
  )
  assert.equal(
    googleDriveQueryStructure(query),
    "trashed = false and mimeType =  and name =  and  in parents",
  )
})

test("PostgREST country filters preserve ordinary values inside quoted literals", () => {
  assert.equal(quotePostgrestFilterValue("HONG KONG"), '"HONG KONG"')
  assert.equal(
    buildPostgrestCountryMatchFilter("country-id", "HONG KONG", "ilike"),
    'country_id.eq."country-id",country_name.ilike."HONG KONG"',
  )
})

test("PostgREST country filters keep grammar characters inside one quoted value", () => {
  const maliciousName = 'HK\\",country_id.eq.attacker),or=(country_name.eq.Owned'
  const filter = buildPostgrestCountryMatchFilter("country-id", maliciousName, "eq")

  assert.equal(
    quotePostgrestFilterValue(maliciousName),
    '"HK\\\\\\\",country_id.eq.attacker),or=(country_name.eq.Owned"',
  )
  assert.deepEqual(splitPostgrestFilterClauses(filter), [
    'country_id.eq."country-id"',
    'country_name.eq."HK\\\\\\\",country_id.eq.attacker),or=(country_name.eq.Owned"',
  ])
})

test("all affected query sinks use the shared grammar-specific builders", () => {
  const driveRoutes = [
    "../app/api/ccinfo/upload/route.ts",
    "../app/api/ccinfo/upload-session/route.ts",
    "../app/api/ccinfo/files/route.ts",
    "../app/api/backups/bunker-map-drive/route.ts",
  ]

  for (const route of driveRoutes) {
    const source = readFileSync(new URL(route, import.meta.url), "utf8")
    assert.match(source, /q: buildGoogleDriveFolderLookupQuery\(parentId, name\)/)
    assert.doesNotMatch(source, /name\.replace\(\/'\/g/)
  }

  const pageSource = readFileSync(
    new URL("../app/admin/ccinfo/page.tsx", import.meta.url),
    "utf8",
  )
  assert.match(
    pageSource,
    /\.or\(buildPostgrestCountryMatchFilter\(id, countryName, "ilike"\)\)/,
  )
  assert.match(
    pageSource,
    /\.or\(buildPostgrestCountryMatchFilter\(selectedId, currentRecord\.name, "eq"\)\)/,
  )
  assert.doesNotMatch(pageSource, /countryName\.replace\(\/,\/g/)
  assert.doesNotMatch(pageSource, /currentRecord\.name\.replace\(\/,\/g/)
})
