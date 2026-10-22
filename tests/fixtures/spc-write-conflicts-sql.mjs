import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

// Native psql emits verbose diagnostics. Match the actual SQLERRM and DETAIL,
// rather than passing the entire psql transcript off as a PostgREST message.
export function nativeSpcPostgrestError(error) {
  const sql = error.message?.match(/ERROR:\s+([A-Z0-9]{5}): ([^\n]+)/)
  return { code: sql?.[1] || error.code, message: sql?.[2] || error.message,
    details: sql ? error.message.match(/\nDETAIL:  ([^\n]+)/)?.[1] ?? null : null }
}

export function currentSpcWriteDefinition(name) {
  const sql = readFileSync(new URL("../../supabase/migrations/20261022111715_nonretryable_spc_supplier_stem_fixture_conflicts.sql", import.meta.url), "utf8")
  const start = sql.indexOf(`create or replace function public.${name}(`), end = sql.indexOf("$$;", start) + 3
  assert.ok(start >= 0 && end > start)
  return sql.slice(start, end)
}
