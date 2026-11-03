import { createClient } from "@supabase/supabase-js"
import { readFile, writeFile, rename, mkdir, stat } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import {
  loadMigrationSnapshot, migrationSourceUrl, runHetznerMigration, PhonebookMigrationError, validateMigrationSourceCredential,
  type MigrationCheckpoint, type MigrationTarget,
} from "../lib/phonebookMigrationHetzner"

const help = `Usage: node --import tsx scripts/phonebook-migrate-hetzner.ts --target-lock /private/path/target.json --checkpoint /private/path/checkpoint.json [--apply] [--concurrency 4]

Dry-run is the default: reads source and destination, never uploads or deletes.
--apply uploads only missing/different contacts with conditional writes and readback.
Checkpoint contains IDs/hashes only; existing destination cards are always reverified.
Never edits production environment variables or deletes destination/source contacts.

Target lock JSON (keep outside the repository, permissions 0600):
{"expectedOrigin":"https://nxexample.your-storageshare.de","expectedUsername":"WRITER_USERNAME","addressBookUrl":"https://nxexample.your-storageshare.de/remote.php/dav/addressbooks/users/WRITER_USERNAME/BOOK_NAME/"}

Required environment variables (do not put values into shell history):
  PHONEBOOK_MIGRATION_SUPABASE_KEY  FCUNO service-role or secret server credential (read-only use)
  HETZNER_CARDDAV_USERNAME         Must match the target lock writer
  HETZNER_CARDDAV_PASSWORD         Dedicated writer app password
Optional CARDDAV_ADDRESSBOOK_URL rejects migration to the current provider origin.
No .env files are loaded automatically. No credentials or contact fields are printed.
`

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help")) { console.log(help); return }
  const parsed: Record<string, string> = {}
  let apply = false
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === "--apply") { apply = true; continue }
    if (!["--target-lock", "--checkpoint", "--concurrency"].includes(argument) || !args[index + 1] || args[index + 1].startsWith("--") || parsed[argument]) throw new PhonebookMigrationError("Invalid or repeated argument. Use --help.")
    parsed[argument] = args[++index]
  }
  if (!parsed["--target-lock"] || !parsed["--checkpoint"]) throw new PhonebookMigrationError("Target lock and checkpoint paths are required. Use --help.")
  const targetPath = path.resolve(parsed["--target-lock"])
  const checkpointPath = path.resolve(parsed["--checkpoint"])
  if (targetPath === checkpointPath) throw new PhonebookMigrationError("Target lock and checkpoint must be different files.")
  const metadata = await stat(targetPath)
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) throw new PhonebookMigrationError("Target lock must be a private regular file (chmod 600).")
  const target: MigrationTarget = JSON.parse(await readFile(targetPath, "utf8"))
  const key = process.env.PHONEBOOK_MIGRATION_SUPABASE_KEY
  if (!key) throw new PhonebookMigrationError("Missing PHONEBOOK_MIGRATION_SUPABASE_KEY.")
  validateMigrationSourceCredential(key)
  const client = createClient(migrationSourceUrl, key, { auth: { persistSession: false, autoRefreshToken: false } })
  let checkpoint: MigrationCheckpoint | undefined
  try { checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PhonebookMigrationError("Cannot read migration checkpoint.") }
  const result = await runHetznerMigration({ target, apply, checkpoint,
    username: process.env.HETZNER_CARDDAV_USERNAME || "", password: process.env.HETZNER_CARDDAV_PASSWORD || "",
    currentAddressBookUrl: process.env.CARDDAV_ADDRESSBOOK_URL,
    concurrency: parsed["--concurrency"] ? Number(parsed["--concurrency"]) : 4,
    loadSource: () => loadMigrationSnapshot(client),
    saveCheckpoint: async value => {
      await mkdir(path.dirname(checkpointPath), { recursive: true, mode: 0o700 })
      const temporary = `${checkpointPath}.${randomUUID()}.tmp`
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" })
      await rename(temporary, checkpointPath)
    },
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.failed || !result.sourceUnchanged || (apply && !result.candidateVerified)) process.exitCode = 2
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    // Provider, filesystem and SDK error messages can contain URLs, secrets, or PII.
    console.error(error instanceof PhonebookMigrationError ? error.message : "Migration stopped safely. Check target configuration, source access, network, and checkpoint permissions; no production cutover occurred.")
    process.exitCode = 1
  })
}
