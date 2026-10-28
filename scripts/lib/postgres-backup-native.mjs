import { spawn as nativeSpawn } from "node:child_process"
import { readFile, realpath, mkdtemp, rm } from "node:fs/promises"
import { join, isAbsolute } from "node:path"
import { tmpdir } from "node:os"
import { createHash, randomUUID } from "node:crypto"
import { fcunoConnectionPolicy } from "../../config/fcunoConnections.ts"
import { POSTGRES_BACKUP_PROTOCOL, assertExportContext, guardedExport, validateExportMetadata, encodePostgresExport } from "../../lib/postgresBackupProtocol.mjs"
import { RECOVERY_CATALOG_EXPRESSION } from "../../lib/postgresRecoveryCatalog.mjs"

const policy = fcunoConnectionPolicy.postgresBackup
const host = policy.sessionPoolerHost
const poolerUser = `${policy.databaseLogin}.${fcunoConnectionPolicy.supabase.projectRef}`
const fail = () => { throw new Error("Fixed native PostgreSQL export failed") }

// All statements are source-owned constants. A request cannot select a query,
// role, snapshot, host, environment variable, file, format or subprocess flag.
// No table rows or credential/password hashes are read into the metadata body.
export const FIXED_SNAPSHOT_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path = pg_catalog;
SELECT jsonb_build_object(
 'source', jsonb_build_object('database',current_database(),'role',current_user,'sessionRole',session_user,
  'serverVersion',current_setting('server_version'),'backendTls',coalesce((select ssl from pg_stat_ssl where pid=pg_backend_pid()),false),
  'clientTls','verify-full','readOnly',current_setting('transaction_read_only')='on','snapshot',pg_export_snapshot()),
 'catalog', jsonb_build_object(
  'tables',coalesce((select jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'readable',has_table_privilege(c.oid,'SELECT')) order by n.nspname,c.relname)
   from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast' and n.nspname !~ '^pg_temp_'),'[]'::jsonb),
  'roles',coalesce((select jsonb_agg(to_jsonb(r) - 'rolpassword' order by r.rolname) from pg_roles r),'[]'::jsonb),
  'memberships',coalesce((select jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'grantor',g.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option) order by r.rolname,m.rolname)
   from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor),'[]'::jsonb),
  'database',(select jsonb_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),'encoding',pg_encoding_to_char(d.encoding),
   'localeProvider',d.datlocprovider,'collate',d.datcollate,'ctype',d.datctype,'icuLocale',d.datlocale,'collationVersion',d.datcollversion,'actualCollationVersion',pg_database_collation_actual_version(d.oid),'acl',d.datacl,'comment',shobj_description(d.oid,'pg_database'),
   'roleSettings',coalesce((select jsonb_agg(jsonb_build_object('role',coalesce(r.rolname,'ALL'),'database',case when s.setdatabase=0 then null else current_database() end,'settings',s.setconfig) order by s.setdatabase,s.setrole)
    from pg_db_role_setting s left join pg_roles r on r.oid=s.setrole where s.setdatabase in (0,d.oid)),'[]'::jsonb)) from pg_database d where datname=current_database()),
  'extensions',coalesce((select jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',pg_get_userbyid(e.extowner)) order by e.extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace),'[]'::jsonb),
  'largeObjectCount',(select count(*) from pg_largeobject_metadata),
  'recovery',${RECOVERY_CATALOG_EXPRESSION}
 ));`

export function fixedDumpArguments(snapshot) {
  if (typeof snapshot !== "string" || !/^[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]*$/.test(snapshot)) fail()
  // Compression is client-side. It does not add load to PostgreSQL nor reduce
  // source coverage. The level is fixed and its runtime must be measured.
  return ["--format=custom", "--compress=gzip:3", "--create", "--no-password", "--lock-wait-timeout=2000", `--snapshot=${snapshot}`]
}
export function fixedNativeEnvironment({ credential, caPath, workDirectory }) {
  if (!credential || Object.keys(credential).sort().join(",") !== "expiresAt,issuedAt,password" ||
      typeof credential.password !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(credential.password) || credential.password.startsWith("sbp_") ||
      !Number.isSafeInteger(credential.issuedAt) || !Number.isSafeInteger(credential.expiresAt) ||
      credential.expiresAt <= credential.issuedAt || credential.expiresAt - credential.issuedAt > 90 * 86400000 ||
      !isAbsolute(caPath) || !isAbsolute(workDirectory)) fail()
  // No process.env spread: inherited PGOPTIONS, PGSERVICE, LD_PRELOAD,
  // NODE_OPTIONS, PATH, user startup/password files are never consulted.
  return { LANG: "C", LC_ALL: "C", TZ: "UTC", OPENSSL_CONF: "/dev/null", PGHOST: host, PGPORT: "5432", PGDATABASE: policy.databaseName,
    PGUSER: poolerUser, PGPASSWORD: credential.password, PGSSLMODE: "verify-full", PGSSLROOTCERT: caPath,
    PGSSLCERT: join(workDirectory, "absent-client-cert"), PGSSLKEY: join(workDirectory, "absent-client-key"),
    PGPASSFILE: join(workDirectory, "absent-password-file"), PGSERVICEFILE: join(workDirectory, "absent-service-file"),
    PGCONNECT_TIMEOUT: "10", PGAPPNAME: "fcuno-fixed-weekly-export-v1",
    PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=20000 -c lock_timeout=2000 -c idle_in_transaction_session_timeout=250000 -c timezone=UTC -c bytea_output=hex -c client_encoding=UTF8" }
}
async function pinnedFile(path, expectedSha256) {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/.test(expectedSha256)) fail()
  const resolved = await realpath(path)
  if (resolved !== path || createHash("sha256").update(await readFile(path)).digest("hex") !== expectedSha256) fail()
  return path
}
export function createNativeChild(spawn, executable, args, environment) {
  const process = spawn(executable, args, { env: environment, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
  let closed = false
  const ended = new Promise(resolve => {
    // 'error' can mean kill() failed while the process is still alive. Only
    // the distinct 'close' event establishes termination, including failed
    // spawns (Node emits close after their error event).
    process.on("error", () => {})
    process.once("close", (code, signal) => { closed = true; resolve({ code, signal }) })
  })
  // Drain, but never retain or publish server errors, which can contain data.
  process.stderr.on("data", () => {})
  process.stdin.on("error", () => {})
  const stop = async () => {
    if (closed) return ended
    process.kill("SIGTERM")
    const timer = setTimeout(() => { if (!closed) process.kill("SIGKILL") }, 1000)
    const fallback = setTimeout(() => { if (!closed) process.stdout.destroy() }, 2000)
    let deadlineTimer
    // A sent signal is not observed termination. If the OS never confirms
    // close, reject so the caller preserves its durable source-load lease.
    try { return await Promise.race([ended, new Promise((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error("Native PostgreSQL process termination unconfirmed")), 2500) })]) }
    finally { clearTimeout(timer); clearTimeout(fallback); clearTimeout(deadlineTimer) }
  }
  return { process, ended, stop, closed: () => closed }
}
async function firstJsonLine(process, context) {
  const iterator = process.stdout[Symbol.asyncIterator](), pieces = []
  let size = 0
  for (;;) {
    const part = await guardedExport(iterator.next(), context)
    if (part.done || !(part.value instanceof Uint8Array)) fail()
    size += part.value.length
    if (size > policy.maximumMetadataBytes) fail()
    pieces.push(part.value)
    const bytes = Buffer.concat(pieces)
    const end = bytes.indexOf(10)
    if (end !== -1) {
      if (bytes.subarray(end + 1).toString("utf8").trim()) fail()
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)))
    }
  }
}

/** Runtime config and supplier are source-owned. No admin API or token mint. */
export function createFixedNativeExporter({ binaries, certificate, getCredential, privateKey,
  verifyRuntimeFiles, spawn = nativeSpawn, now = Date.now } = {}) {
  if (typeof getCredential !== "function" || typeof spawn !== "function" || typeof now !== "function") fail()
  return async function open(context) {
    assertExportContext(context)
    const remaining = Math.min(policy.maximumExportMs, context.deadline - now())
    if (!Number.isSafeInteger(remaining) || remaining <= 0) fail()
    context = { ...context, deadline: now() + remaining,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(remaining)]) }
    if (verifyRuntimeFiles) await guardedExport(verifyRuntimeFiles(), context)
    // Pins are checked every opening, before retrieving a source-only token.
    const psql = await pinnedFile(binaries.psql.path, binaries.psql.sha256)
    const pgDump = await pinnedFile(binaries.pgDump.path, binaries.pgDump.sha256)
    const caPath = await pinnedFile(certificate.path, certificate.sha256)
    const credential = await guardedExport(getCredential(), context)
    if (credential.issuedAt > now() || credential.expiresAt < context.deadline + 15000) fail()
    const workDirectory = await mkdtemp(join(tmpdir(), "fcuno-pg-export-"))
    let connection = null, dump = null, finished = false, stopping = null
    const stop = () => stopping ??= (async () => {
      await Promise.all([dump?.stop(), connection?.stop()])
      // Only the exact mkdtemp-owned empty working directory, never user data.
      await rm(workDirectory, { recursive: true, force: true })
    })()
    const abort = () => { void stop().catch(() => {}) }
    context.signal.addEventListener("abort", abort, { once: true })
    try {
      const environment = fixedNativeEnvironment({ credential, caPath, workDirectory })
      connection = createNativeChild(spawn, psql, ["-X", "-q", "-A", "-t", "--no-readline", "--no-password", "--set=ON_ERROR_STOP=1"], environment)
      connection.process.stdin.write(FIXED_SNAPSHOT_SQL + "\n")
      const result = await firstJsonLine(connection.process, context)
      const metadata = validateExportMetadata({ schema: POSTGRES_BACKUP_PROTOCOL,
        projectRef: fcunoConnectionPolicy.supabase.projectRef, organizationId: fcunoConnectionPolicy.supabase.organizationId,
        runId: randomUUID(), startedAt: new Date(now()).toISOString(), source: result.source, catalog: result.catalog })
      assertExportContext(context)
      dump = createNativeChild(spawn, pgDump, fixedDumpArguments(metadata.source.snapshot), environment)
      dump.process.stdin.end()
      const archive = (async function* () {
        const iterator = dump.process.stdout[Symbol.asyncIterator]()
        for (;;) {
          const part = await guardedExport(iterator.next(), context)
          if (part.done) break
          for (let offset = 0; offset < part.value.length; offset += policy.chunkBytes) {
            assertExportContext(context); yield part.value.subarray(offset, offset + policy.chunkBytes)
          }
        }
      })()
      const finish = async () => {
        const result = await guardedExport(dump.ended, context)
        if (result.code !== 0 || connection.closed()) fail()
        connection.process.stdin.end("ROLLBACK;\n\\q\n")
        if ((await guardedExport(connection.ended, context)).code !== 0) fail()
        finished = true; return 0
      }
      const bytes = (async function* () {
        try { yield* encodePostgresExport({ metadata, archive, finish, privateKey }, context) }
        finally { context.signal.removeEventListener("abort", abort); await stop() }
      })()
      return { metadata, bytes, close: async () => { context.signal.removeEventListener("abort", abort); await stop() }, completed: () => finished }
    } catch {
      context.signal.removeEventListener("abort", abort); await stop(); fail()
    }
  }
}
