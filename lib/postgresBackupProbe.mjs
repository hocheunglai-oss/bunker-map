import { readFile, realpath, mkdtemp, rm } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { fcunoConnectionPolicy as pins } from "../config/fcunoConnections.ts"
import { createNativeChild, fixedNativeEnvironment } from "../scripts/lib/postgres-backup-native.mjs"

// Fixed, bounded metadata only. This cannot start a dump or grant a role.
export const POSTGRES_PROBE_SQL = `BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT jsonb_build_object('database',current_database(),'role',current_user,'sessionRole',session_user,
 'version',current_setting('server_version'),'readOnly',current_setting('transaction_read_only')='on',
 'backendTls',coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()),false),
 'checkedAt',clock_timestamp(),'lastStart',pg_postmaster_start_time(),
 'reader',(select to_jsonb(r)-'rolpassword' from pg_roles r where rolname=current_user),
 'memberships',coalesce((select jsonb_agg(jsonb_build_object('role',r.rolname,'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option))
 from pg_auth_members m join pg_roles r on r.oid=m.roleid where m.member=(select oid from pg_roles where rolname=current_user)),'[]'::jsonb));
ROLLBACK;`

export function validatePostgresProbe(value, now) {
  const role = value?.reader, membership = value?.memberships
  if (!Number.isSafeInteger(now) || value?.database !== pins.postgresBackup.databaseName || value.role !== pins.postgresBackup.databaseLogin ||
      value.sessionRole !== pins.postgresBackup.databaseLogin || typeof value.version !== "string" || !/^17\.[0-9]+(?: \([^\r\n()]{1,120}\))?$/.test(value.version) ||
      value.readOnly !== true || value.backendTls !== true || !Number.isFinite(Date.parse(value.checkedAt)) ||
      Math.abs(Date.parse(value.checkedAt) - now) > 60000 || !Number.isFinite(Date.parse(value.lastStart)) ||
      Date.parse(value.lastStart) > Date.parse(value.checkedAt) || role?.rolname !== pins.postgresBackup.databaseLogin ||
      role.rolsuper !== false || role.rolcreatedb !== false || role.rolcreaterole !== false || role.rolreplication !== false ||
      role.rolbypassrls !== true || role.rolcanlogin !== true || role.rolinherit !== true || role.rolconnlimit !== 2 ||
      !Number.isFinite(Date.parse(role.rolvaliduntil)) || Date.parse(role.rolvaliduntil) <= now ||
      Date.parse(role.rolvaliduntil) > now + 90 * 86400000 || !Array.isArray(membership) || membership.length !== 1 ||
      membership[0].role !== "pg_read_all_data" || membership[0].admin !== false || membership[0].inherit !== true || membership[0].set !== false) {
    throw Error("Native compatibility unavailable")
  }
  return { status: "verified", scope: "native-runtime-and-read-only-metadata", databaseVersion: value.version,
    checkedAt: value.checkedAt, databaseLastStart: value.lastStart, clientTls: "verify-full", backendTls: true,
    restrictedSourceRole: true, intrinsicCannotWrite: false, exportPerformed: false, recoveryVerified: false }
}

async function collect(child, deadline) {
  let timer, bytes = 0
  const chunks = []
  try {
    const output = (async () => {
      for await (const chunk of child.process.stdout) {
        bytes += chunk.length
        if (bytes > 65536) throw Error("Native compatibility unavailable")
        chunks.push(chunk)
      }
      if ((await child.ended).code !== 0) throw Error("Native compatibility unavailable")
      return Buffer.concat(chunks).toString("utf8").trim()
    })()
    return await Promise.race([output, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error("Native compatibility unavailable")), Math.max(1, deadline - Date.now()))
    })])
  } finally { clearTimeout(timer) }
}

export async function probePostgresBackupRuntime({ runtime, verifyBundle, root = process.cwd(), spawnImpl = spawn, now = Date.now }) {
  if (runtime.POSTGRES_BACKUP_PROBE_ENABLED !== "1" || runtime.VERCEL !== "1" || runtime.VERCEL_ENV !== "production" ||
      runtime.VERCEL_PROJECT_ID !== pins.vercel.projectId) throw Error("Native compatibility unavailable")
  const bundle = await verifyBundle(join(root, ".runtime/postgres"), runtime.POSTGRES_BACKUP_BUNDLE_SHA256)
  const caPath = join(root, ".runtime/postgres-source/root.crt")
  if (!/^[0-9a-f]{64}$/.test(runtime.POSTGRES_BACKUP_CA_SHA256 || "") || await realpath(caPath) !== caPath ||
      createHash("sha256").update(await readFile(caPath)).digest("hex") !== runtime.POSTGRES_BACKUP_CA_SHA256) throw Error("Native compatibility unavailable")
  const serialized = runtime.POSTGRES_BACKUP_SOURCE_CREDENTIAL_JSON
  if (typeof serialized !== "string" || serialized.length > 1024) throw Error("Native compatibility unavailable")
  const credential = JSON.parse(serialized)
  const checked = now()
  if (credential.issuedAt > checked || credential.expiresAt < checked + 60000) throw Error("Native compatibility unavailable")
  const directory = await mkdtemp(join(tmpdir(), "fcuno-pg-probe-"))
  const deadline = Date.now() + 20000
  let activeChild = null
  const run = async (path, args, environment, input) => {
    if (Date.now() >= deadline) throw Error("Native compatibility unavailable")
    activeChild = createNativeChild(spawnImpl, path, args, environment)
    try {
      // Ownership starts before stdin access: even a synchronous pipe failure
      // must stop the child and observe its close before removing its files.
      activeChild.process.stdin.end(input)
      return await collect(activeChild, deadline)
    } finally {
      await activeChild.stop()
      activeChild = null
    }
  }
  try {
    const environment = { ...fixedNativeEnvironment({ credential, caPath, workDirectory: directory }),
      PGAPPNAME: "fcuno-read-only-compatibility-probe-v1",
      PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=25000" }
    for (const name of ["psql", "pgDump", "pgRestore"]) {
      const version = await run(bundle.binaries[name].path, ["--version"], { LANG: "C", LC_ALL: "C", TZ: "UTC", OPENSSL_CONF: "/dev/null" })
      if (!/\(PostgreSQL\) 17\.11$/.test(version)) throw Error("Native compatibility unavailable")
    }
    const result = await run(bundle.binaries.psql.path,
      ["-X", "-q", "-A", "-t", "--no-readline", "--no-password", "--set=ON_ERROR_STOP=1"], environment, POSTGRES_PROBE_SQL + "\n")
    return validatePostgresProbe(JSON.parse(result), now())
  } finally {
    // Preserve the owned diagnostic directory if process termination is not confirmed.
    if (activeChild === null) await rm(directory, { recursive: true, force: true })
  }
}
