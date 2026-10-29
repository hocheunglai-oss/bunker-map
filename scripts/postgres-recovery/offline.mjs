import { spawn } from "node:child_process"
import { createHash, createPublicKey, verify, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { readFile, writeFile, mkdir, mkdtemp, rm, lstat, realpath, rename } from "node:fs/promises"
import { once } from "node:events"
import { join, resolve, isAbsolute } from "node:path"
import { fileURLToPath } from "node:url"
import { networkInterfaces } from "node:os"
import { validatePostgresManifest } from "../../lib/postgresBackupReceipt.mjs"
import { RECOVERY_CATALOG_EXPRESSION, RECOVERY_CATALOG_KEYS, validateRecoveryCatalog } from "../../lib/postgresRecoveryCatalog.mjs"
import { createRecoveryDiagnostics, createNativeStderrHint } from "../../lib/postgresRecoveryDiagnostics.mjs"
import { equivalentRecoveryColumns } from "../../lib/postgresRecoveryColumns.mjs"
import { equivalentRecoverySchemas, equivalentRecoveryDatabase, equivalentRecoveryAclSection } from "../../lib/postgresRecoveryAcl.mjs"

const MAX_LINE = 64 * 1024 * 1024, MAX_TEXT = 16 * 1024 * 1024
const operator = "fcuno_recovery_operator"
const failure = () => { throw new Error("Private PostgreSQL recovery verification failed") }
const sha = bytes => createHash("sha256").update(bytes).digest("hex")
const quote = name => { if (typeof name !== "string" || !name || name.includes("\0") || Buffer.byteLength(name) > 256) failure(); return `"${name.replaceAll('"', '""')}"` }
const literal = value => { if (typeof value !== "string" || value.includes("\0")) failure(); return `'${value.replaceAll("'", "''")}'` }
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const sameCatalogSection = (expected, actual, section) => section === "columns" ? equivalentRecoveryColumns(expected, actual) :
  section === "schemas" ? equivalentRecoverySchemas(expected, actual) :
  ["relations", "functions", "types"].includes(section) ? equivalentRecoveryAclSection(expected, actual, section) : same(expected, actual)

export async function* boundedLines(stream) {
  let pending = Buffer.alloc(0)
  for await (const chunk of stream) {
    if (!(chunk instanceof Uint8Array)) failure()
    pending = Buffer.concat([pending, chunk])
    for (;;) {
      const end = pending.indexOf(10)
      if (end < 0) break
      if (end > MAX_LINE) failure()
      yield pending.subarray(0, end)
      pending = pending.subarray(end + 1)
    }
    if (pending.length > MAX_LINE) failure()
  }
  if (pending.length) failure()
}

// Decode ONLY PostgreSQL's generated COPY identifier grammar. SQL from the
// archive is executed solely inside the network-isolated restore process;
// these identifiers are re-quoted before a verification SELECT is constructed.
export function parseCopyHeader(line) {
  const text = Buffer.isBuffer(line) ? line.toString("utf8") : line
  const id = '(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)'
  const match = new RegExp(`^COPY (${id})\\.(${id}) \\(((${id})(?:, ${id})*)\\) FROM stdin;$`).exec(text)
  if (!match) failure()
  const decode = value => value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value
  const columns = match[3].match(new RegExp(id, "g")).map(decode)
  if (!columns.length || new Set(columns).size !== columns.length) failure()
  return { schema: decode(match[1]), name: decode(match[2]), columns }
}

export function parseSequenceState(text) {
  const lines = text.split("\n").filter(line => line.startsWith("SELECT pg_catalog.setval("))
  if (lines.length !== 1) failure()
  const match = /^SELECT pg_catalog\.setval\('((?:[^']|'')+)', (-?[0-9]+), (true|false)\);$/.exec(lines[0])
  if (!match) failure()
  const name = match[1].replaceAll("''", "'")
  const id = '(?:"(?:[^"]|"")+"|[a-z_][a-z0-9_$]*)'
  const parts = new RegExp(`^(${id})\\.(${id})$`).exec(name)
  if (!parts) failure()
  const decode = value => value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value
  return { schema: decode(parts[1]), name: decode(parts[2]), lastValue: match[2], isCalled: match[3] === "true" }
}

export function parseToc(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_TEXT) failure()
  const entries = text.split("\n").filter(line => line && !line.startsWith(";"))
  const seen = new Set()
  for (const line of entries) {
    const match = /^([1-9][0-9]*); [0-9]+ [0-9]+ [^\r\n\x00]+$/.exec(line)
    if (!match || seen.has(match[1])) failure()
    seen.add(match[1])
  }
  if (!entries.length) failure()
  return { entries, tableData: entries.filter(line => /^\d+; \d+ \d+ TABLE DATA /.test(line)),
    sequenceData: entries.filter(line => /^\d+; \d+ \d+ SEQUENCE SET /.test(line)) }
}

// Whole-row SHA-256 leaves are externally sorted. Duplicate rows remain
// duplicated, and the final hash + row count form a cryptographic multiset
// comparison without retaining an entire table or sorting business text.
export async function fingerprintRows(lines, { sortBinary, directory, signal, env, diagnostics }) {
  const process = spawn(sortBinary, ["-S", "32M", "-T", directory], { env, shell: false, stdio: ["pipe", "pipe", "pipe"], signal })
  process.stderr.on("data", () => {})
  process.stdin.on("error", () => {})
  const ended = new Promise((resolve, reject) => { process.once("error", reject); process.once("close", (code, signal) => {
    if (code === 0) resolve()
    else { diagnostics?.native("sort", code, signal); reject(new Error("Private row comparison failed")) }
  }) })
  // Attach rejection immediately, before the producer starts.
  void ended.catch(() => {})
  let rows = 0
  const output = (async () => { const hash = createHash("sha256"); for await (const chunk of process.stdout) hash.update(chunk); return hash.digest("hex") })()
  void output.catch(() => {})
  try {
    for await (const line of lines) {
      signal.throwIfAborted()
      if (++rows > Number.MAX_SAFE_INTEGER) failure()
      if (!process.stdin.write(sha(line) + "\n")) await once(process.stdin, "drain", { signal })
    }
    process.stdin.end()
    await ended
    return { rows, sha256: await output }
  } catch (error) { process.kill("SIGKILL"); throw error }
}

async function fileHash(path, signal) {
  const hash = createHash("sha256"); let size = 0
  for await (const bytes of createReadStream(path, { signal })) { size += bytes.length; hash.update(bytes) }
  return { size, sha256: hash.digest("hex") }
}
async function checkedFile(path) {
  if (!isAbsolute(path) || (await realpath(path)) !== path) failure()
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022) failure()
  return path
}

export async function runOfflineRecovery({ archivePath, manifest, publicKey, binaries, workRoot, signal, sourceImageDigest = "local-synthetic-fixture", diagnostics = createRecoveryDiagnostics() }) {
  await diagnostics.stage("manifest-verification")
  validatePostgresManifest(manifest)
  if (sha(Buffer.from(JSON.stringify(manifest.metadata))) !== manifest.completion.metadataSha256 ||
      !verify(null, Buffer.from(JSON.stringify(manifest.completion)), publicKey, Buffer.from(manifest.signature, "base64url"))) failure()
  await diagnostics.stage("archive-verification")
  await checkedFile(archivePath)
  const archive = await fileHash(archivePath, signal)
  if (archive.size !== manifest.completion.archiveBytes || archive.sha256 !== manifest.completion.archiveSha256) failure()
  await diagnostics.stage("catalog-scope")
  const metadata = manifest.metadata, catalog = metadata.catalog
  validateRecoveryCatalog(catalog.recovery)
  // Do not pretend native pg_dump saves materialized contents (it refreshes
  // them), or ordinary non-config extension data (it normally omits it).
  // Future introduction of either shape requires a separately reviewed proof.
  if (catalog.tables.some(table => ["m", "f"].includes(table.kind)) ||
      catalog.recovery.extensionTables.some(table => !table.config) || catalog.largeObjectCount !== 0) failure()
  if (catalog.roles.some(role => role.rolname === operator)) failure()
  const sourceBootstrap = catalog.roles.filter(role => String(role.oid) === "10")
  if (sourceBootstrap.length !== 1 || sourceBootstrap[0].rolsuper !== true) failure()
  quote(sourceBootstrap[0].rolname)
  await diagnostics.stage("workspace-setup")
  if (!isAbsolute(workRoot) || (await realpath(workRoot)) !== workRoot) failure()
  const directory = await mkdtemp(join(workRoot, "fcuno-recovery-"))
  const data = join(directory, "data"), socket = join(directory, "socket")
  await mkdir(socket, { mode: 0o700 })
  const env = { LANG: "C", LC_ALL: "C", TZ: "UTC", HOME: directory, PATH: "/usr/bin:/bin",
    PGHOST: socket, PGPORT: "55491", PGUSER: operator, PGDATABASE: "template1", PGCONNECT_TIMEOUT: "5",
    PGPASSFILE: join(directory, "absent-password"), PGSERVICEFILE: join(directory, "absent-service"),
    PGOPTIONS: "-c search_path=pg_catalog -c timezone=UTC -c bytea_output=hex -c client_encoding=UTF8 -c datestyle=ISO -c intervalstyle=postgres -c extra_float_digits=3 -c statement_timeout=120000 -c lock_timeout=2000",
    ...(binaries.localeArchive ? { LOCALE_ARCHIVE: binaries.localeArchive } : {}) }
  let running = false, primaryFailure = false
  function start(name, args, input) {
    const process = spawn(binaries[name], args, { env, shell: false, stdio: ["pipe", "pipe", "pipe"], signal })
    const stderrHint = createNativeStderrHint()
    process.stderr.on("data", stderrHint.write) // Only a fixed heuristic enum survives, never private text.
    process.stdin.on("error", () => {})
    const done = new Promise((resolve, reject) => { process.once("error", reject); process.once("close", (code, signal) => {
      if (code === 0) resolve()
      else { diagnostics.native(name, code, signal, stderrHint.value()); reject(new Error("Isolated native recovery command failed")) }
    }) })
    void done.catch(() => {})
    process.stdin.end(input)
    return { stream: process.stdout, done, stop: () => process.kill("SIGKILL") }
  }
  async function text(name, args, input, maximum = MAX_TEXT) {
    const child = start(name, args, input), parts = []; let length = 0
    try { for await (const part of child.stream) { if ((length += part.length) > maximum) failure(); parts.push(part) } await child.done; return Buffer.concat(parts).toString("utf8").trim() }
    catch (error) { child.stop(); throw error }
  }
  const sql = (query, database = "postgres") => text("psql", ["-X", "-qAt", "--set=ON_ERROR_STOP=1", "--no-password", "--dbname", database], query)
  try {
    await diagnostics.stage("binary-validation")
    for (const name of ["initdb", "pgCtl", "psql", "pgRestore", "sort"]) if (!isAbsolute(binaries[name])) failure()
    await diagnostics.stage("initdb")
    await text("initdb", ["-D", data, `--username=${sourceBootstrap[0].rolname}`, "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"])
    const preload = binaries.preload === "" ? "" : "pg_stat_statements"
    const flags = ["-p", "55491", "-k", socket, "-h", "", "-c", `shared_preload_libraries=${preload}`, "-c", "session_preload_libraries=", "-c", "local_preload_libraries=",
      "-c", "max_connections=8", "-c", "shared_buffers=64MB", "-c", "work_mem=8MB", "-c", "maintenance_work_mem=64MB", "-c", "max_parallel_workers=0", "-c", "max_worker_processes=0",
      "-c", "autovacuum=off", "-c", "archive_mode=off", "-c", "logging_collector=off", "-c", "log_statement=none", "-c", "log_min_error_statement=panic"]
    // pg_ctl alone requires one options string; all values are fixed or from
    // this exact mkdtemp-owned path, never archive/request strings.
    await diagnostics.stage("start-server")
    await text("pgCtl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", flags.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(" "), "-w", "start"])
    running = true
    // PostgreSQL treats bootstrap role OID10 as the implicit grantor of
    // global memberships. Preserve its source identity, then create a separate
    // verification-only operator and disable the original bootstrap login.
    await diagnostics.stage("create-operator")
    env.PGUSER = sourceBootstrap[0].rolname
    await sql(`CREATE ROLE ${quote(operator)} SUPERUSER LOGIN; ALTER ROLE ${quote(sourceBootstrap[0].rolname)} NOLOGIN;`, "template1")
    env.PGUSER = operator
    if (await sql("select current_setting('listen_addresses')", "template1") !== "") failure()
    // Global roles are not part of pg_dump. Preserve original attributes and
    // memberships only inside this sealed server, force EVERY source role to
    // NOLOGIN, and copy no password hash or native source credential.
    await diagnostics.stage("restore-roles")
    const builtins = new Set(JSON.parse(await sql("select json_agg(rolname order by rolname) from pg_roles", "template1")))
    for (const role of catalog.roles) {
      if (builtins.has(role.rolname)) { if (!role.rolname.startsWith("pg_") && role.rolname !== sourceBootstrap[0].rolname) failure(); continue }
      const attributes = [["rolsuper", "SUPERUSER"], ["rolcreatedb", "CREATEDB"], ["rolcreaterole", "CREATEROLE"], ["rolinherit", "INHERIT"], ["rolreplication", "REPLICATION"], ["rolbypassrls", "BYPASSRLS"]]
      if (attributes.some(([key]) => typeof role[key] !== "boolean")) failure()
      await sql(`CREATE ROLE ${quote(role.rolname)} NOLOGIN ${attributes.map(([key, option]) => role[key] ? option : `NO${option}`).join(" ")};`, "template1")
    }
    for (const role of catalog.roles) {
      if (role.rolname.startsWith("pg_")) continue
      if (!Number.isSafeInteger(role.rolconnlimit) || role.rolconnlimit < -1 ||
          (role.rolvaliduntil !== null && typeof role.rolvaliduntil !== "string")) failure()
      await sql(`ALTER ROLE ${quote(role.rolname)} CONNECTION LIMIT ${role.rolconnlimit}${role.rolvaliduntil === null ? "" : ` VALID UNTIL ${literal(role.rolvaliduntil)}`};`, "template1")
    }
    await diagnostics.stage("restore-memberships")
    let memberships = [...catalog.memberships]
    while (memberships.length) {
      const remaining = []
      for (const membership of memberships) {
        try { await sql(`GRANT ${quote(membership.role)} TO ${quote(membership.member)} WITH ADMIN ${membership.admin ? "TRUE" : "FALSE"}, INHERIT ${membership.inherit ? "TRUE" : "FALSE"}, SET ${membership.set ? "TRUE" : "FALSE"} GRANTED BY ${quote(membership.grantor)};`, "template1") }
        catch { remaining.push(membership) }
      }
      if (remaining.length === memberships.length) failure()
      memberships = remaining
    }
    await diagnostics.stage("read-toc")
    const toc = parseToc(await text("pgRestore", ["--create", "--list", archivePath]))
    await sql("DROP DATABASE postgres;", "template1")
    const bootstrapEntries = toc.entries.filter(line => /^\d+; \d+ \d+ (?:DATABASE(?: PROPERTIES)? - |SCHEMA - |COMMENT - DATABASE |ACL - DATABASE )/.test(line))
    const extensionEntries = toc.entries.filter(line => /^\d+; \d+ \d+ EXTENSION - /.test(line))
    const covered = new Set([...bootstrapEntries, ...extensionEntries])
    const remainder = toc.entries.filter(line => !covered.has(line))
    if (!bootstrapEntries.some(line => /^\d+; \d+ \d+ DATABASE - postgres /.test(line)) ||
        bootstrapEntries.length + extensionEntries.length + remainder.length !== toc.entries.length) failure()
    const initialList = join(directory, "bootstrap.list"), remainingList = join(directory, "remaining.list")
    await writeFile(initialList, bootstrapEntries.join("\n") + "\n", { mode: 0o600, flag: "wx" })
    await writeFile(remainingList, remainder.join("\n") + "\n", { mode: 0o600, flag: "wx" })
    await diagnostics.stage("bootstrap-restore")
    const bootstrap = start("pgRestore", ["--exit-on-error", "--create", "--use-list", initialList, "--dbname=template1", `--role=${sourceBootstrap[0].rolname}`, archivePath])
    bootstrap.stream.resume(); await bootstrap.done
    // pg_dump intentionally omits extension ownership. Recreate packages with
    // exact source owners BEFORE restoring their config-table contents. Any
    // temporary SUPERUSER attribute is local, NOLOGIN and restored immediately.
    await diagnostics.stage("create-extensions")
    for (const extension of catalog.extensions) {
      const owner = catalog.roles.find(role => role.rolname === extension.owner)
      if (!owner || typeof owner.rolsuper !== "boolean") failure()
      if (!owner.rolsuper) await sql(`ALTER ROLE ${quote(owner.rolname)} SUPERUSER;`)
      try { await sql(`SET ROLE ${quote(owner.rolname)}; CREATE EXTENSION IF NOT EXISTS ${quote(extension.name)} WITH SCHEMA ${quote(extension.schema)} VERSION ${literal(extension.version)}; RESET ROLE;`) }
      finally { if (!owner.rolsuper) await sql(`ALTER ROLE ${quote(owner.rolname)} NOSUPERUSER;`) }
    }
    await diagnostics.stage("verify-extensions")
    const extensions = JSON.parse(await sql("select coalesce(jsonb_agg(jsonb_build_object('name',e.extname,'version',e.extversion,'schema',n.nspname,'owner',pg_get_userbyid(e.extowner)) order by e.extname),'[]'::jsonb) from pg_extension e join pg_namespace n on n.oid=e.extnamespace"))
    // pg_dump omits initdb's pinned plpgsql extension from the TOC. Its exact
    // version and owner are still checked against the independently signed
    // source catalog, alongside all explicitly archived extensions.
    if (!same(extensions, catalog.extensions) || extensionEntries.length !== catalog.extensions.filter(item => item.name !== "plpgsql").length) failure()
    await diagnostics.stage("restore-archive")
    const restore = start("pgRestore", ["--exit-on-error", "--use-list", remainingList, "--dbname=postgres", `--role=${sourceBootstrap[0].rolname}`, archivePath])
    restore.stream.resume(); await restore.done
    // Apply captured per-role settings as exact GUC strings, not a quoted
    // whole search_path list. Passwords and login access remain excluded.
    await diagnostics.stage("restore-role-settings")
    for (const setting of catalog.database.roleSettings || []) for (const item of setting.settings || []) {
      const at = item.indexOf("="); if (at <= 0) failure()
      const name = item.slice(0, at), value = item.slice(at + 1)
      if (!/^[A-Za-z][A-Za-z0-9_.]*$/.test(name)) failure()
      const target = setting.role === "ALL" ? `ALTER DATABASE postgres` : `ALTER ROLE ${quote(setting.role)}${setting.database === null ? "" : " IN DATABASE postgres"}`
      await sql(`BEGIN; SELECT set_config(${literal(name)},${literal(value)},true); ${target} SET ${quote(name)} FROM CURRENT; COMMIT;`)
    }
    await diagnostics.stage("verify-catalog")
    const restoredCatalog = JSON.parse(await sql(`SELECT ${RECOVERY_CATALOG_EXPRESSION};`))
    validateRecoveryCatalog(restoredCatalog)
    await diagnostics.catalog(catalog.recovery, restoredCatalog, sameCatalogSection)
    if (!RECOVERY_CATALOG_KEYS.every(section => sameCatalogSection(catalog.recovery[section], restoredCatalog[section], section))) failure()
    await diagnostics.stage("verify-tables")
    const tables = JSON.parse(await sql(`select coalesce(json_agg(json_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,'readable',true) order by n.nspname,c.relname),'[]'::json) from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p','m','f') and n.nspname not in ('pg_catalog','information_schema') and n.nspname !~ '^pg_toast' and n.nspname !~ '^pg_temp_'`))
    if (!same(tables, catalog.tables)) failure()
    const expectedTables = new Set(catalog.tables.filter(table => table.kind === "r").map(table => JSON.stringify([table.schema, table.name])))
    const checkedTables = new Set(), fingerprints = []
    await diagnostics.stage("compare-table-rows")
    for (const [index, entry] of toc.tableData.entries()) {
      const list = join(directory, `table-${index}.list`)
      await writeFile(list, entry + "\n", { mode: 0o600, flag: "wx" })
      const child = start("pgRestore", ["--data-only", "--use-list", list, "--file=-", archivePath])
      let header = null, ended = false
      async function* archiveRows() {
        for await (const line of boundedLines(child.stream)) {
          if (!header) { if (line.subarray(0, 5).toString() === "COPY ") header = parseCopyHeader(line); continue }
          if (line.equals(Buffer.from("\\."))) { if (ended) failure(); ended = true; continue }
          if (!ended) yield line
          else if (line.subarray(0, 5).toString() === "COPY ") failure()
        }
        await child.done
        if (!header || !ended) failure()
      }
      let expected
      try { expected = await fingerprintRows(archiveRows(), { sortBinary: binaries.sort, directory, signal, env, diagnostics }) }
      catch (error) { child.stop(); throw error }
      const identity = JSON.stringify([header.schema, header.name])
      if (!expectedTables.has(identity) || checkedTables.has(identity)) failure()
      checkedTables.add(identity)
      const columns = header.columns.map(quote).join(",")
      const query = `COPY (SELECT ${columns} FROM ONLY ${quote(header.schema)}.${quote(header.name)}) TO STDOUT;`
      const actual = start("psql", ["-X", "-q", "--set=ON_ERROR_STOP=1", "--no-password", "--dbname=postgres"], query)
      let obtained
      try { obtained = await fingerprintRows(boundedLines(actual.stream), { sortBinary: binaries.sort, directory, signal, env, diagnostics }); await actual.done }
      catch (error) { actual.stop(); throw error }
      if (!same(obtained, expected)) failure()
      fingerprints.push({ table: identity, ...expected })
      await rm(list)
    }
    if (checkedTables.size !== expectedTables.size) failure()
    await diagnostics.stage("compare-sequences")
    const sequenceProofs = [], expectedSequences = new Set(catalog.recovery.sequences.map(item => JSON.stringify([item.schema, item.name])))
    for (const [index, entry] of toc.sequenceData.entries()) {
      const path = join(directory, `sequence-${index}.list`)
      await writeFile(path, entry + "\n", { mode: 0o600, flag: "wx" })
      const expected = parseSequenceState(await text("pgRestore", ["--data-only", "--use-list", path, "--file=-", archivePath]))
      const identity = JSON.stringify([expected.schema, expected.name])
      if (!expectedSequences.delete(identity)) failure()
      const actual = JSON.parse(await sql(`SELECT json_build_object('lastValue',last_value::text,'isCalled',is_called) FROM ${quote(expected.schema)}.${quote(expected.name)};`))
      if (!same(actual, { lastValue: expected.lastValue, isCalled: expected.isCalled })) failure()
      sequenceProofs.push(expected); await rm(path)
    }
    if (expectedSequences.size) failure()
    await diagnostics.stage("verify-database")
    const database = JSON.parse(await sql(`select jsonb_build_object('name',d.datname,'owner',pg_get_userbyid(d.datdba),'encoding',pg_encoding_to_char(d.encoding),'localeProvider',d.datlocprovider,'collate',d.datcollate,'ctype',d.datctype,'icuLocale',d.datlocale,'collationVersion',d.datcollversion,'actualCollationVersion',pg_database_collation_actual_version(d.oid),'acl',d.datacl,'comment',shobj_description(d.oid,'pg_database')) from pg_database d where d.datname=current_database()`))
    const expectedDatabase = Object.fromEntries(Object.entries(catalog.database).filter(([key]) => key !== "roleSettings"))
    if (!equivalentRecoveryDatabase(expectedDatabase, database)) failure()
    await diagnostics.stage("verify-memberships")
    const restoredMemberships = JSON.parse(await sql(`select coalesce(jsonb_agg(jsonb_build_object('role',r.rolname,'member',m.rolname,'grantor',g.rolname,'admin',a.admin_option,'inherit',a.inherit_option,'set',a.set_option) order by r.rolname,m.rolname),'[]'::jsonb) from pg_auth_members a join pg_roles r on r.oid=a.roleid join pg_roles m on m.oid=a.member join pg_roles g on g.oid=a.grantor`))
    if (!same(restoredMemberships, catalog.memberships)) failure()
    await diagnostics.stage("verify-roles")
    const roleFacts = roles => roles.filter(role => role.rolname !== operator).map(role => Object.fromEntries(Object.entries(role).filter(([key]) => !["oid", "rolpassword", "rolcanlogin"].includes(key))))
    const restoredRoles = JSON.parse(await sql("select jsonb_agg(to_jsonb(r)-'rolpassword' order by r.rolname) from pg_roles r"))
    if (!same(roleFacts(restoredRoles), roleFacts(catalog.roles))) failure()
    await diagnostics.stage("verify-login-roles")
    const loginRoles = JSON.parse(await sql("select json_agg(rolname order by rolname) from pg_roles where rolcanlogin"))
    if (!same(loginRoles, [operator])) failure()
    await diagnostics.stage("verify-vault")
    const vault = catalog.tables.find(table => table.schema === "vault" && table.name === "secrets")
    if (vault && await sql('select count(*) from "vault"."secrets"') !== "0") failure()
    return { schema: "fcuno.cloud-postgresql-recovery/v1", status: "isolated-logical-recovery-verified", projectRef: metadata.projectRef,
      archiveSha256: archive.sha256, archiveBytes: archive.size, metadataSha256: manifest.completion.metadataSha256,
      runId: manifest.runId, week: manifest.week, verifiedAt: new Date().toISOString(), runtime: sourceImageDigest,
      tables: fingerprints.length, tableContentProofSha256: sha(Buffer.from(JSON.stringify(fingerprints))), catalogSections: 12,
      tocEntries: toc.entries.length, unaccountedTocEntries: 0, sequences: sequenceProofs.length, sequenceProofSha256: sha(Buffer.from(JSON.stringify(sequenceProofs))),
      sourceRoleCopiesNoLogin: true, productionConnections: 0,
      excludes: ["hosted-service configuration", "role passwords", "external storage bytes", "Vault root encryption key"] }
  } catch (error) {
    primaryFailure = true
    try { await diagnostics.failed() } catch { /* Diagnostic IO cannot replace the primary failure. */ }
    throw error
  } finally {
    let diagnosticFailure, cleanupFailure
    try { await diagnostics.cleanup("pending") } catch (error) { diagnosticFailure = error }
    try {
      if (running) {
        // Cleanup gets an independent bounded opportunity even after work aborts.
        const stopped = spawn(binaries.pgCtl, ["-D", data, "-m", "immediate", "-w", "stop"], { env, shell: false, stdio: "ignore", timeout: 10000, killSignal: "SIGKILL" })
        await new Promise((resolve, reject) => { stopped.once("error", reject); stopped.once("close", code => code === 0 ? resolve() : reject(new Error("Recovery cleanup unconfirmed"))) })
      }
      await rm(directory, { recursive: true, force: true })
    } catch (error) { cleanupFailure = error }
    try { await diagnostics.cleanup(cleanupFailure ? "failed" : "ok") } catch (error) { diagnosticFailure ||= error }
    // A failed diagnostic write must never skip stopping the owned database.
    // Preserve the primary stage; cleanup/diagnostic failure still fails closed.
    if (!primaryFailure && (cleanupFailure || diagnosticFailure)) throw cleanupFailure || diagnosticFailure
  }
}

export async function runCloudOfflineCli() {
  const diagnostics = createRecoveryDiagnostics({ save: async value => {
    const temporary = `/output/.diagnostic-${randomUUID()}.json`
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" })
    await rename(temporary, "/output/diagnostic.json")
  } })
  try {
  await diagnostics.stage("runtime-check")
  if (process.argv.slice(2).join(" ") !== "--verify-cloud-input" || process.platform !== "linux" || process.getuid() !== 1000 ||
      Object.values(networkInterfaces()).flat().some(item => item && !item.internal)) failure()
  const status = await readFile("/proc/self/status", "utf8")
  if (!/^CapEff:\s+0+$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status)) failure()
  await diagnostics.stage("input-read")
  const manifest = JSON.parse(await readFile("/input/manifest.json", "utf8")), publicKey = createPublicKey(await readFile("/input/verification-key.pem"))
  const binary = name => `/nix/var/nix/profiles/default/bin/${name}`
  const result = await runOfflineRecovery({ archivePath: "/input/archive.dump", manifest, publicKey, workRoot: "/recovery", signal: AbortSignal.timeout(1500000), diagnostics,
    sourceImageDigest: "sha256:b75a42959151593e90d6ad7f0ef69abb329916caa397556976375da4c333412e",
    binaries: { initdb: binary("initdb"), pgCtl: binary("pg_ctl"), psql: binary("psql"), pgRestore: binary("pg_restore"), sort: "/usr/bin/sort",
      localeArchive: "/nix/var/nix/profiles/default/lib/locale/locale-archive" } })
  await diagnostics.stage("write-success")
  await writeFile("/output/recovery.json", JSON.stringify(result), { mode: 0o600, flag: "wx" })
  await diagnostics.complete()
  } catch (error) { try { await diagnostics.failed() } catch { /* No raw diagnostic IO error output. */ } throw error }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCloudOfflineCli().catch(() => { process.exitCode = 1 })
