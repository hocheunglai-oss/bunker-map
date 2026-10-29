import test from "node:test"
import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, realpath } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { generateKeyPairSync, createHash } from "node:crypto"
import { createFixedNativeExporter, createNativeChild, fixedDumpArguments, fixedNativeEnvironment } from "../scripts/lib/postgres-backup-native.mjs"
import { decodePostgresExport } from "../lib/postgresBackupProtocol.mjs"
import { createPostgresBackupHandler, POSTGRES_BACKUP_URL } from "../lib/postgresBackupCapability.mjs"
import { fcunoConnectionPolicy } from "../config/fcunoConnections.ts"
import { runOfflineRecovery } from "../scripts/postgres-recovery/offline.mjs"
import { POSTGRES_RECEIPT_SCHEMA } from "../lib/postgresBackupReceipt.mjs"
import { RECOVERY_CATALOG_EXPRESSION } from "../lib/postgresRecoveryCatalog.mjs"
import { equivalentRecoveryColumns } from "../lib/postgresRecoveryColumns.mjs"

const exec = promisify(execFile), hash = bytes => createHash("sha256").update(bytes).digest("hex")
const bin = process.env.NATIVE_PG_BIN
const cloudProof = process.env.FCUNO_CLOUD_CONTROLLER_PROOF === "1"
const fixturePassword = "synthetic_fixture_password_not_a_real_secret_000000"
const tlsHost = fcunoConnectionPolicy.postgresBackup.sessionPoolerHost
const poolerUser = `${fcunoConnectionPolicy.postgresBackup.databaseLogin}.${fcunoConnectionPolicy.supabase.projectRef}`

for (const killError of [false, true]) test(`unobserved native termination rejects cleanup even with kill error=${killError}`, async () => {
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() })
  const signals = []
  process.kill = signal => { signals.push(signal); if (killError) process.emit("error", new Error("synthetic kill failure")); return !killError }
  const child = createNativeChild(() => process, "/synthetic/psql", [], {})
  await assert.rejects(child.stop(), /termination unconfirmed/)
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  assert.equal(child.closed(), false)
  for (const stream of [process.stdin, process.stdout, process.stderr]) stream.destroy()
})

test("real PG17 TLS export, signed streaming decode and isolated restore preserve synthetic database", { timeout: 60000 }, async () => {
  assert.ok(bin, "NATIVE_PG_BIN is mandatory; no skipped native proof")
  const root = await realpath(await mkdtemp(join(cloudProof ? "/recovery" : process.platform === "darwin" ? "/private/tmp" : tmpdir(), "fcuno-native-export-proof-")))
  const environment = { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin", OPENSSL_CONF: "/dev/null",
    ...(cloudProof ? { LOCALE_ARCHIVE: "/nix/var/nix/profiles/default/lib/locale/locale-archive" } : {}) }
  const native = async (name, args, options = {}) => exec(join(bin, name), args, { env: environment, timeout: 15000, ...options })
  const clusters = []
  let exported
  try {
    for (const label of ["source", "recovery"]) {
      const directory = join(root, label), data = join(directory, "data"), socket = join(directory, "socket")
      await mkdir(directory); await mkdir(socket)
      await native("initdb", ["-D", data, "--username=fixture_owner", "--auth-local=trust", "--auth-host=scram-sha-256",
        ...(cloudProof ? ["--locale-provider=icu", "--icu-locale=en-US", "--locale=en_US.UTF-8"] : ["--no-locale"]), "--encoding=UTF8"])
      const port = label === "source" ? "55489" : "55490"
      if (label === "source") {
        if (cloudProof) {
          // CI creates this one-use SYNTHETIC certificate outside the image.
          // The production recovery image receives no key or TLS fixture.
          for (const name of ["server.key", "server.crt"]) await writeFile(join(directory, name), await readFile(`/fixture-tls/${name}`), { flag: "wx", mode: 0o600 })
        } else {
          const tlsConfig = join(directory, "openssl.cnf")
          await writeFile(tlsConfig, `[req]\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\n[extensions]\nsubjectAltName=DNS:${tlsHost}\n`, { flag: "wx", mode: 0o600 })
          await exec("/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${tlsHost}`,
            "-config", tlsConfig, "-keyout", join(directory, "server.key"), "-out", join(directory, "server.crt")], { env: environment, timeout: 15000 })
        }
        await chmod(join(directory, "server.key"), 0o600)
      }
      const options = ["-p", port, "-k", socket, "-h", label === "source" ? "127.0.0.1" : "",
        ...(cloudProof ? ["-c", "shared_preload_libraries=pg_stat_statements", "-c", "max_worker_processes=0"] : []),
        ...(label === "source" ? ["-c", "ssl=on", "-c", `ssl_cert_file=${join(directory, "server.crt")}`, "-c", `ssl_key_file=${join(directory, "server.key")}`] : [])]
      // pg_ctl receives a fixture-owned quoted options string, not user input.
      await native("pg_ctl", ["-D", data, "-l", join(directory, "postgres.log"), "-o", options.map(x => `'${x.replaceAll("'", "'\\''")}'`).join(" "), "-w", "start"])
        .catch(async error => { throw new Error((await readFile(join(directory, "postgres.log"), "utf8")), { cause: error }) })
      clusters.push({ data, socket, port })
    }
    const sql = async (cluster, text) => (await native("psql", ["-X", "-qAt", "--set=ON_ERROR_STOP=1", "-h", cluster.socket,
      "-p", cluster.port, "-U", "fixture_owner", "-d", "postgres", "-c", text])).stdout.trim()
    await sql(clusters[0], `CREATE ROLE fixture_operator NOSUPERUSER CREATEROLE BYPASSRLS;
      GRANT pg_read_all_data TO fixture_operator WITH ADMIN TRUE;
      SET ROLE fixture_operator;
      CREATE ROLE fcuno_backup_export_login LOGIN INHERIT BYPASSRLS CONNECTION LIMIT 2 PASSWORD '${fixturePassword}' VALID UNTIL '${new Date(Date.now() + 30 * 86400000).toISOString()}';
      GRANT pg_read_all_data TO fcuno_backup_export_login WITH ADMIN FALSE, INHERIT TRUE, SET FALSE;
      RESET ROLE;
      CREATE ROLE application_user NOLOGIN;
      CREATE SCHEMA auth; CREATE SCHEMA storage;
      CREATE TABLE public.rows(removed_leading text, id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        removed_before_body text, body text NOT NULL, removed_before_extra text, extra jsonb, removed_trailing text);
      ALTER TABLE public.rows DROP COLUMN removed_leading, DROP COLUMN removed_before_body,
        DROP COLUMN removed_before_extra, DROP COLUMN removed_trailing;
      INSERT INTO public.rows(body,extra) SELECT repeat('synthetic-'||n::text,200), jsonb_build_object('number',n,'unicode','香港') FROM generate_series(1,200) n;
      ALTER TABLE public.rows ENABLE ROW LEVEL SECURITY;
      CREATE POLICY own_rows ON public.rows FOR SELECT TO application_user USING(id > 0);
      CREATE TABLE auth.fixture_users(id uuid PRIMARY KEY, email text);
      INSERT INTO auth.fixture_users VALUES('11111111-1111-4111-8111-111111111111','synthetic@example.invalid');
      CREATE TABLE storage.fixture_objects(id bigint PRIMARY KEY, name text);
      INSERT INTO storage.fixture_objects VALUES(1,'synthetic.txt');
      CREATE VIEW public.row_names AS SELECT id,left(body,8) AS label FROM public.rows;
      CREATE MATERIALIZED VIEW public.row_count AS SELECT count(*) AS total FROM public.rows;
      CREATE FUNCTION public.fixture_answer() RETURNS integer LANGUAGE sql IMMUTABLE AS 'select 42';
      CREATE FUNCTION public.fixture_trigger() RETURNS trigger LANGUAGE plpgsql AS 'begin return new; end';
      CREATE TRIGGER fixture_guard BEFORE INSERT ON public.rows FOR EACH ROW EXECUTE FUNCTION public.fixture_trigger();
      CREATE INDEX fixture_extra_idx ON public.rows USING gin(extra);
      COMMENT ON DATABASE postgres IS 'synthetic backup metadata';
      COMMENT ON TABLE public.rows IS 'synthetic table comment';
      GRANT SELECT ON public.rows TO application_user;
      ALTER ROLE application_user IN DATABASE postgres SET search_path = public,auth;
      SELECT lo_from_bytea(70001,decode('0123456789abcdef','hex'));
      GRANT SELECT ON LARGE OBJECT 70001 TO fcuno_backup_export_login;`)
    if (cloudProof) {
      await sql(clusters[0], `CREATE SCHEMA extensions; CREATE SCHEMA vault;
        CREATE EXTENSION hypopg WITH SCHEMA extensions VERSION '1.4.1';
        CREATE EXTENSION index_advisor WITH SCHEMA extensions VERSION '0.2.0';
        CREATE EXTENSION supabase_vault WITH SCHEMA vault VERSION '0.3.1';
        CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions VERSION '1.11';
        CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions VERSION '1.1';
        GRANT USAGE,CREATE ON SCHEMA extensions TO application_user;
        ALTER ROLE application_user SUPERUSER; SET ROLE application_user;
        CREATE EXTENSION pgcrypto WITH SCHEMA extensions VERSION '1.3'; RESET ROLE;
        ALTER ROLE application_user NOSUPERUSER;`)
      assert.equal(await sql(clusters[0], "select pg_database_collation_actual_version(oid) from pg_database where datname='postgres'"), "153.121")
    }
    const binaries = {}
    for (const [key, name] of [["psql", "psql"], ["pgDump", "pg_dump"]]) {
      const path = await realpath(join(bin, name)); binaries[key] = { path, sha256: hash(await readFile(path)) }
    }
    const caPath = await realpath(join(root, "source/server.crt")), calls = []
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const start = Date.parse(new Date(Date.now() - 86400000).toISOString().slice(0, 10) + "T18:15:00.000Z"), clock = () => start
    const context = { signal: AbortSignal.timeout(25000), deadline: start + 25000, now: clock }
    const open = createFixedNativeExporter({ binaries, certificate: { path: caPath, sha256: hash(await readFile(caPath)) }, privateKey, now: clock,
      getCredential: async () => ({ password: fixturePassword, issuedAt: start - 1000, expiresAt: start + 600000 }),
      // The fixture pins the destination to loopback and models the shared
      // pooler's tenant-qualified login mapping to the unchanged database role.
      // This proves native TLS/snapshot/export semantics, not a live pooler.
      // Production code has no configurable hostaddr, user or fixture flag.
      spawn(executable, args, options) {
        calls.push({ executable, args, options })
        assert.equal(options.env.PGHOST, tlsHost); assert.equal(options.env.PGSSLMODE, "verify-full")
        assert.equal(options.env.PGUSER, poolerUser); assert.equal(options.shell, false)
        return spawn(executable, args, { ...options, env: { ...options.env, PGHOSTADDR: "127.0.0.1", PGPORT: clusters[0].port, PGUSER: fcunoConnectionPolicy.postgresBackup.databaseLogin } })
      } })
    const handler = createPostgresBackupHandler({ now: clock,
      runtime: { enabled: true, vercel: "1", environment: "production", projectId: fcunoConnectionPolicy.vercel.projectId, googleSubject: "123456789012345678901" },
      verifyToken: async () => ({ iss: fcunoConnectionPolicy.storageMediaBackup.googleTokenIssuer, aud: POSTGRES_BACKUP_URL,
        sub: "123456789012345678901", email: fcunoConnectionPolicy.storageMediaBackup.googleServiceAccount, email_verified: true,
        iat: start / 1000, exp: start / 1000 + 3600 }),
      admission: { acquire: async input => ({ week: input.week, owner: input.owner, fence: 1 }), finish: async () => {} },
      openNative: async () => { exported = await open(context); return exported } })
    const response = await handler(new Request(POSTGRES_BACKUP_URL, { method: "POST", headers: {
      authorization: "Bearer aaa.bbb.ccc", "content-type": "application/json" }, body: '{"operation":"weekly-full-v1"}' }))
    assert.equal(response.status, 200)
    const archive = []; let metadata, complete
    // Fragment transport into irregular chunks to exercise actual framing.
    async function* transport() { for await (const bytes of response.body) for (let n = 0; n < bytes.length; n += 123) yield bytes.subarray(n, n + 123) }
    for await (const item of decodePostgresExport(transport(), publicKey, context)) {
      if (item.type === "metadata") metadata = item.metadata
      else if (item.type === "archive") archive.push(item.bytes)
      else complete = item.completion
    }
    assert.equal(exported.completed(), true)
    assert.equal(metadata.source.backendTls, true)
    assert.equal(metadata.source.role, "fcuno_backup_export_login")
    assert.equal(metadata.catalog.tables.length, cloudProof ? 5 : 4)
    assert.equal(metadata.catalog.largeObjectCount, 1)
    assert.equal(complete.dumpExitCode, 0)
    assert.ok(complete.archiveBytes > 1000)
    assert.ok(complete.archiveBytes < 100000, "fixed gzip compresses the synthetic repetitive fixture")
    assert.equal(calls.length, 2)
    assert.equal(calls[0].options.env.PATH, undefined)
    assert.equal(calls[0].options.env.SUPABASE_SERVICE_ROLE_KEY, undefined)
    assert.deepEqual(calls[1].args, fixedDumpArguments(metadata.source.snapshot))
    const path = join(root, "archive.dump")
    await writeFile(path, Buffer.concat(archive), { mode: 0o600, flag: "wx" })
    const toc = (await native("pg_restore", ["--list", path])).stdout
    for (const kind of ["TABLE DATA", "POLICY", "FUNCTION", "TRIGGER", "INDEX", "ACL", "BLOB", "MATERIALIZED VIEW DATA"]) assert.ok(toc.includes(kind), kind)
    // A dump has no global roles: restore the metadata capsule into NOLOGIN
    // roles first, rather than silently omit owners/grants or copy passwords.
    await sql(clusters[1], "CREATE ROLE fcuno_backup_export_login NOLOGIN; CREATE ROLE application_user NOLOGIN;")
    await native("pg_restore", ["--exit-on-error", "--host", clusters[1].socket, "--port", clusters[1].port,
      "--username", "fixture_owner", "--dbname", "postgres", path])
    const fingerprint = `select jsonb_build_object(
      'rows',(select md5(string_agg(row_to_json(t)::text,',' order by id)) from public.rows t),
      'users',(select md5(string_agg(row_to_json(t)::text,',' order by id)) from auth.fixture_users t),
      'objects',(select md5(string_agg(row_to_json(t)::text,',' order by id)) from storage.fixture_objects t),
      'lo',(select encode(lo_get(70001),'hex')),'function',public.fixture_answer(),
      'sequence',(select last_value from public.rows_id_seq),'view',(select total from public.row_count),
      'policy',(select qual from pg_policies where tablename='rows'),
      'comment',obj_description('public.rows'::regclass,'pg_class'),
      'acl',(select relacl::text from pg_class where oid='public.rows'::regclass));`
    assert.equal(await sql(clusters[1], fingerprint), await sql(clusters[0], fingerprint))
    const restoredColumns = JSON.parse(await sql(clusters[1], `SELECT ${RECOVERY_CATALOG_EXPRESSION};`)).columns
    assert.notDeepEqual(metadata.catalog.recovery.columns, restoredColumns, "logical restore compacts dropped physical slots")
    assert.equal(equivalentRecoveryColumns(metadata.catalog.recovery.columns, restoredColumns), true,
      "every visible column property and its order must survive the real logical restore")
    assert.equal(await sql(clusters[1], "select rolcanlogin from pg_roles where rolname='application_user'"), "f")
    assert.equal(await sql(clusters[0], "select count(*) from pg_stat_activity where application_name='fcuno-fixed-weekly-export-v1'"), "0")
    // Exercise the SAME native restore/content verifier that runs sealed in
    // Cloud Build. Unsupported matview and LO recovery remain fail-closed;
    // this second synthetic source represents the current supported scope.
    await sql(clusters[0], "DROP MATERIALIZED VIEW public.row_count; SELECT lo_unlink(70001);")
    // Exact grants can occupy different ACL array positions after pg_dump
    // omits unchanged defaults. Preserve all grantors/options, including a
    // delegated chain and role names requiring PostgreSQL array escaping.
    await sql(clusters[0], `CREATE ROLE fixture_db_owner NOLOGIN; CREATE ROLE fixture_grantor NOLOGIN;
        CREATE ROLE fixture_recipient NOLOGIN;
        ALTER DATABASE postgres OWNER TO fixture_db_owner;
        CREATE SCHEMA acl_fixture AUTHORIZATION fixture_db_owner;
        SET ROLE fixture_db_owner;
        GRANT USAGE ON SCHEMA acl_fixture TO fixture_grantor WITH GRANT OPTION;
        GRANT CONNECT ON DATABASE postgres TO fixture_grantor WITH GRANT OPTION;
        RESET ROLE; SET ROLE fixture_grantor;
        GRANT USAGE ON SCHEMA acl_fixture TO fixture_recipient;
        GRANT CONNECT ON DATABASE postgres TO fixture_recipient;
        RESET ROLE; SET ROLE fixture_db_owner;
          REVOKE ALL ON DATABASE postgres FROM PUBLIC;
          GRANT TEMPORARY,CONNECT ON DATABASE postgres TO PUBLIC;
          GRANT USAGE ON SCHEMA public TO fixture_grantor WITH GRANT OPTION;
          REVOKE ALL ON SCHEMA public FROM PUBLIC;
          GRANT USAGE ON SCHEMA public TO PUBLIC;
          RESET ROLE; SET ROLE fixture_grantor;
          GRANT USAGE ON SCHEMA public TO fixture_recipient;
          RESET ROLE;
          CREATE ROLE "acl,reader ""quoted"" {} / =\\back" NOLOGIN;
          SET ROLE fixture_db_owner;
          GRANT USAGE ON SCHEMA public TO "acl,reader ""quoted"" {} / =\\back";
          RESET ROLE; SET ROLE fixture_grantor;
          GRANT CONNECT ON DATABASE postgres TO "acl,reader ""quoted"" {} / =\\back";
          RESET ROLE;`)
    // The same default omission can reorder ACLs on every other known ACL
    // catalog object. Nothing except ACL item order may compare differently.
    await sql(clusters[0], `GRANT EXECUTE ON FUNCTION public.fixture_answer() TO fixture_recipient;
      REVOKE ALL ON FUNCTION public.fixture_answer() FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION public.fixture_answer() TO PUBLIC;
      GRANT SELECT ON TABLE public.rows TO fixture_recipient;
      REVOKE ALL ON TABLE public.rows FROM fixture_owner;
      GRANT ALL ON TABLE public.rows TO fixture_owner;
      CREATE TYPE public.acl_color AS ENUM ('red','green');
      GRANT USAGE ON TYPE public.acl_color TO fixture_recipient;
      REVOKE ALL ON TYPE public.acl_color FROM PUBLIC;
      GRANT USAGE ON TYPE public.acl_color TO PUBLIC;`)
    // pg_dump also omits an explicit ACL equal to PostgreSQL's hard-wired
    // default. A simple GRANT then REVOKE leaves that representation behind.
    // Keep bootstrap/database/object owners distinct and prove quoted names
    // against native acldefault(), not a test copy of the comparison formula.
    await sql(clusters[0], `GRANT USAGE ON SCHEMA auth TO fixture_recipient;
      REVOKE USAGE ON SCHEMA auth FROM fixture_recipient;
      GRANT SELECT ON auth.fixture_users TO fixture_recipient;
      REVOKE SELECT ON auth.fixture_users FROM fixture_recipient;`)
    const defaultOwners = ["fixture_default_owner", "MixedCase", "123name", "select", "NULL", "space owner", "slash/equals=owner", 'double"quote', "back\\slash", "香港owner", "braces{},comma", "single'quote"]
    const quoteIdentifier = value => `"${value.replaceAll('"', '""')}"`
    for (const [index, owner] of defaultOwners.entries()) {
      const role = quoteIdentifier(owner), schema = `default_acl_${index}`
      await sql(clusters[0], `CREATE ROLE ${role} NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION ${role};
        CREATE VIEW ${schema}.example AS SELECT 1 AS id;
        ALTER VIEW ${schema}.example OWNER TO ${role};
        CREATE SEQUENCE ${schema}.example_sequence;
        ALTER SEQUENCE ${schema}.example_sequence OWNER TO ${role};
        GRANT ALL ON SCHEMA ${schema} TO ${role};
        GRANT ALL ON ${schema}.example TO ${role};
        GRANT ALL ON SEQUENCE ${schema}.example_sequence TO ${role};`)
      const nativeDefaults = JSON.parse(await sql(clusters[0], `SELECT json_build_object(
        'schema',(SELECT acldefault('n',nspowner)::text FROM pg_namespace WHERE nspname='${schema}'),
        'relation',(SELECT acldefault('r',relowner)::text FROM pg_class WHERE oid='${schema}.example'::regclass),
        'sequence',(SELECT acldefault('s',relowner)::text FROM pg_class WHERE oid='${schema}.example_sequence'::regclass),
        'actualSchema',(SELECT nspacl::text FROM pg_namespace WHERE nspname='${schema}'),
        'actualRelation',(SELECT relacl::text FROM pg_class WHERE oid='${schema}.example'::regclass),
        'actualSequence',(SELECT relacl::text FROM pg_class WHERE oid='${schema}.example_sequence'::regclass));`))
      // The full production recovery verifier below must accept all these
      // native defaults after pg_dump restores their ACL columns as NULL.
      assert.equal(nativeDefaults.actualSchema, nativeDefaults.schema)
      assert.equal(nativeDefaults.actualRelation, nativeDefaults.relation)
      assert.equal(nativeDefaults.actualSequence, nativeDefaults.sequence)
    }
    const cloudExport = await open(context), cloudParts = []; let cloudMetadata, cloudComplete
    for await (const item of decodePostgresExport(cloudExport.bytes, publicKey, context)) {
      if (item.type === "metadata") cloudMetadata = item.metadata
      if (item.type === "archive") cloudParts.push(item.bytes)
      if (item.type === "complete") cloudComplete = item
    }
    await cloudExport.close()
    assert.equal(String(cloudMetadata.catalog.roles.find(role => role.rolname === "fixture_owner").oid), "10")
    assert.deepEqual(cloudMetadata.catalog.recovery.columns.filter(column => column.schema === "public" && column.relation === "rows")
      .map(column => [column.name, column.position]), [["id", 2], ["body", 4], ["extra", 6]])
    const cloudBytes = Buffer.concat(cloudParts), cloudPath = join(root, "cloud.dump"), cloudRun = "native-cloud-fixture"
    await writeFile(cloudPath, cloudBytes, { flag: "wx", mode: 0o600 })
    const cloudManifest = { schema: POSTGRES_RECEIPT_SCHEMA, status: "copied-and-byte-verified", runId: cloudRun, week: (await import("../lib/postgresBackupProtocol.mjs")).postgresBackupWeek(start),
      metadata: cloudMetadata, completion: cloudComplete.completion, signature: cloudComplete.signature,
      parts: [{ target: { bucket: fcunoConnectionPolicy.storageMediaBackup.targetBucket,
        objectName: `${fcunoConnectionPolicy.postgresBackup.targetPrefix}/runs/${cloudRun}/archive/000000`, generation: "1" },
      sizeBytes: cloudBytes.length, crc32c: "AAAAAA==", byteSha256: hash(cloudBytes) }] }
    if (cloudProof) for (const [name, bytes] of [["archive.dump", cloudBytes], ["manifest.json", JSON.stringify(cloudManifest)], ["verification-key.pem", publicKey.export({ type: "spki", format: "pem" })]])
      await writeFile(`/output/${name}`, bytes, { flag: "wx", mode: 0o600 })
    const proof = await runOfflineRecovery({ archivePath: cloudPath, manifest: cloudManifest, publicKey, workRoot: root,
      signal: AbortSignal.timeout(30000), binaries: { initdb: join(bin, "initdb"), pgCtl: join(bin, "pg_ctl"), psql: join(bin, "psql"),
        pgRestore: join(bin, "pg_restore"), sort: "/usr/bin/sort", ...(cloudProof ? { localeArchive: environment.LOCALE_ARCHIVE } : { preload: "" }) } })
    assert.equal(proof.status, "isolated-logical-recovery-verified")
    assert.equal(proof.tables, cloudProof ? 4 : 3); assert.equal(proof.catalogSections, 12); assert.equal(proof.unaccountedTocEntries, 0)
    // A real extension config WHERE filter can silently exclude source rows.
    // Reproduce only in this disposable synthetic catalog and reject before
    // launching pg_dump, even though a filtered archive could restore cleanly.
    await sql(clusters[0], `ALTER EXTENSION plpgsql ADD TABLE public.rows;
      UPDATE pg_extension SET extconfig=ARRAY['public.rows'::regclass::oid],extcondition=ARRAY['WHERE id < 0'] WHERE extname='plpgsql';`)
    const beforeRejected = calls.length
    await assert.rejects(open(context))
    assert.equal(calls.length, beforeRejected + 1, "only fixed metadata psql, no pg_dump")
    await sql(clusters[0], `UPDATE pg_extension SET extconfig=NULL,extcondition=NULL WHERE extname='plpgsql'; ALTER EXTENSION plpgsql DROP TABLE public.rows;`)
    // Real source admission SQL, after the export/restore comparison. No fake
    // persistence adapter: native transactions and privilege checks execute.
    await sql(clusters[0], `CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA private; CREATE SCHEMA supabase_migrations;
      CREATE TABLE supabase_migrations.schema_migrations(version text);`)
    await sql(clusters[0], await readFile(new URL("../supabase/migrations/20260723080340_backup_reliability_guards.sql", import.meta.url), "utf8"))
    await sql(clusters[0], await readFile(new URL("../supabase/migrations/20261028054706_fixed_postgresql_export_admission.sql", import.meta.url), "utf8"))
    const owner1 = "11111111-1111-4111-8111-111111111111", owner2 = "22222222-2222-4222-8222-222222222222"
    const claim = (owner, time) => sql(clusters[0], `select private.claim_postgresql_export_at('${owner}','${time}');`)
    assert.equal(await claim(owner1, "2026-10-27T12:00:00Z"), "")
    assert.equal(await claim(owner1, "2026-10-27T21:59:30Z"), "")
    assert.equal(await sql(clusters[0], "select count(*) from private.postgresql_export_admission"), "0")
    const first = JSON.parse(await claim(owner1, "2026-10-27T18:00:00Z"))
    assert.deepEqual(first, { week: "2026-10-26", owner: owner1, fence: 1 })
    assert.equal(await claim(owner2, "2026-10-27T18:00:01Z"), "")
    assert.equal(await sql(clusters[0], `select public.finish_fixed_postgresql_export('${owner2}',1,false)`), "f")
    assert.equal(await sql(clusters[0], `select public.finish_fixed_postgresql_export('${owner1}',1,true)`), "t")
    assert.equal(await claim(owner2, "2026-10-27T18:30:00Z"), "")
    const second = JSON.parse(await claim(owner2, "2026-10-27T19:10:00Z"))
    assert.equal(second.fence, 2)
    assert.equal(await sql(clusters[0], `select public.finish_fixed_postgresql_export('${owner1}',1,false)`), "f")
    assert.equal(await sql(clusters[0], `select public.finish_fixed_postgresql_export('${owner2}',2,false)`), "t")
    assert.equal(await claim(owner1, "2026-10-27T20:20:00Z"), "")
    assert.equal(await sql(clusters[0], "select attempts from private.postgresql_export_admission"), "2")
    assert.equal(await sql(clusters[0], "select count(*) from public.bunker_map_backup_lock"), "0")
    assert.equal(await sql(clusters[0], `select has_function_privilege('service_role','public.claim_fixed_postgresql_export(uuid)','execute')
      and not has_function_privilege('anon','public.claim_fixed_postgresql_export(uuid)','execute')
      and not has_function_privilege('authenticated','public.finish_fixed_postgresql_export(uuid,bigint,boolean)','execute')
      and not has_function_privilege('service_role','private.claim_postgresql_export_at(uuid,timestamp with time zone)','execute')
      and not has_table_privilege('service_role','private.postgresql_export_admission','update')`), "t")
    await sql(clusters[0], "truncate private.postgresql_export_admission")
    const race = await Promise.all([claim(owner1, "2026-10-27T18:00:00Z"), claim(owner2, "2026-10-27T18:00:00Z")])
    assert.equal(race.filter(Boolean).length, 1)
    const winner = JSON.parse(race.find(Boolean))
    assert.equal(await sql(clusters[0], "select attempts from private.postgresql_export_admission"), "1")
    await sql(clusters[0], `select public.finish_fixed_postgresql_export('${winner.owner}',${winner.fence},false);
      truncate private.postgresql_export_admission;
      select public.claim_bunker_map_backup_lock('daily-supabase-drive-v2','${owner2}',900);`)
    assert.equal(await claim(owner1, "2026-10-27T18:00:00Z"), "")
    assert.equal(await sql(clusters[0], "select count(*) from private.postgresql_export_admission"), "0")
  } finally {
    await exported?.close()
    for (const cluster of clusters.reverse()) await native("pg_ctl", ["-D", cluster.data, "-m", "fast", "-w", "stop"]).catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("native plan has no caller-controlled SQL/options/credentials fallback", () => {
  for (const value of ["x;select lo_create(1)", "00000001-00000002-1 --role=postgres", "", "postgres"]) assert.throws(() => fixedDumpArguments(value))
  const environment = fixedNativeEnvironment({ credential: { password: fixturePassword, issuedAt: 1, expiresAt: 100000 }, caPath: "/owned/ca.pem", workDirectory: "/owned/temp" })
  assert.equal(environment.PGHOST, tlsHost)
  assert.equal(environment.PGSSLMODE, "verify-full")
  assert.equal(environment.PGUSER, poolerUser)
  for (const forbidden of ["PGSERVICE", "PGHOSTADDR", "PATH", "HOME", "LD_PRELOAD", "NODE_OPTIONS"]) assert.equal(environment[forbidden], undefined)
  assert.throws(() => fixedNativeEnvironment({ credential: { password: fixturePassword, issuedAt: 1, expiresAt: 100 * 86400000 }, caPath: "/owned/ca.pem", workDirectory: "/owned/temp" }))
})
