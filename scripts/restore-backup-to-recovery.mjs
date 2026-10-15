const backupPath = process.argv[2]

if (!backupPath) {
  console.error(
    "Usage: npm run backup:restore:recovery -- /absolute/path/to/backup.json"
  )
  process.exit(2)
}

// Both formats are intentionally disabled. Do not load or parse the artifact
// merely to choose a refusal message: current archives exceed Node's maximum
// string size, and refusing a restore must remain safe at any archive size.
console.error(
  [
    "REFUSED: JSON REST restores are disabled for both v2 and legacy artifacts.",
    "The immutable Exchange truth ledger, certification and attendance discrepancy",
    "evidence, sequences, and trigger ordering require a whole-database restore.",
    "They are non-transactional, cannot reproduce database objects or audit ordering,",
    "and can silently turn missing sections into empty tables.",
    "Use a validated whole-database managed restore/PITR or owner-level pg_dump/pg_restore",
    "in an isolated recovery project, following docs/backup-restore-runbook.md.",
    "Validate the artifact with npm run backup:validate first.",
    "No artifact bytes were read, no database client was created and no writes were attempted.",
  ].join(" ")
)
process.exit(2)
