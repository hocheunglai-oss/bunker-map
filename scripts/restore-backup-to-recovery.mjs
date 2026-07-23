import fs from "node:fs"

const backupPath = process.argv[2]

if (!backupPath) {
  console.error(
    "Usage: npm run backup:restore:recovery -- /absolute/path/to/backup.json"
  )
  process.exit(2)
}

const backup = JSON.parse(fs.readFileSync(backupPath, "utf8"))

if (
  backup?.schemaVersion === 2 ||
  backup?.integrity?.schema === "bunker-map-backup-integrity/v2"
) {
  console.error(
    [
      "REFUSED: backup format v2 contains the immutable Exchange truth ledger.",
      "A service-role REST upsert cannot reproduce that evidence exactly: the ledger,",
      "snapshots, certification rows, sequence values, and trigger ordering require an",
      "owner-level whole-database restore (Supabase managed backup/PITR or pg_dump/psql).",
      "Validate the artifact with npm run backup:validate, then follow",
      "docs/backup-restore-runbook.md. No recovery-project writes were attempted.",
    ].join(" ")
  )
  process.exit(2)
}

console.error(
  [
    "REFUSED: legacy JSON REST restores are disabled too.",
    "They are non-transactional, cannot reproduce database objects or audit ordering,",
    "and can silently turn missing sections into empty tables.",
    "Use a validated whole-database managed restore/PITR or owner-level pg_dump/pg_restore",
    "in an isolated recovery project, following docs/backup-restore-runbook.md.",
    "No database client was created and no writes were attempted.",
  ].join(" ")
)
process.exit(2)
