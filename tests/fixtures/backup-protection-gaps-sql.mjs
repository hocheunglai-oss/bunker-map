import { readFileSync } from "node:fs"

export const gapMigration = "supabase/migrations/20261015102256_durable_backup_protection_gaps.sql"
export const gapMigrationSql = () => readFileSync(new URL(`../../${gapMigration}`, import.meta.url), "utf8")
export const gapFixtureSql = () => `
  set time zone 'UTC';
  create role anon; create role authenticated; create role service_role bypassrls;
  create schema private;
  grant usage on schema public to anon,authenticated,service_role;
  ${gapMigrationSql()}
`
export const observation = "2026-10-14T00:00:00.000000Z"
export const due = "2026-10-13T18:00:00.000000Z"
export const epoch = value => new Date(value).getTime()
export const h1 = "20261014000001", h2 = "20261014000002", h3 = "20261014000003"
export const c1 = "a".repeat(64), c2 = "b".repeat(64), c3 = "c".repeat(64)
export const inventory = (dueAt = due, extra = {}) => ({ key: "inventory", dueAt, requiredVersion: h1, requiredFingerprint: c1, ...extra })
export const gap = (key, dueAt = due, extra = {}) => ({ key, dueAt, requiredSinceAt: observation, ...extra })
