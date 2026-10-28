import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

const image = 'sha256:b75a42959151593e90d6ad7f0ef69abb329916caa397556976375da4c333412e';
const expectedExtensions = { hypopg: '1.4.1', index_advisor: '0.2.0', pg_stat_statements: '1.11', pgcrypto: '1.3', plpgsql: '1.0', supabase_vault: '0.3.1', 'uuid-ossp': '1.1' };
const root = '/recovery';
const binaryRoot = '/nix/var/nix/profiles/default/bin';
const env = Object.freeze({ PATH: `${binaryRoot}:/usr/bin:/bin`, LOCALE_ARCHIVE: '/nix/var/nix/profiles/default/lib/locale/locale-archive', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', HOME: root, PGPASSFILE: '/no-source-password-file', PGCONNECT_TIMEOUT: '5', OPENSSL_CONF: '/dev/null' });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const checks = [];
const clusters = [];
function run(name, args, input, extraEnv = {}, timeout = 60_000) {
  const r = spawnSync(join(binaryRoot, name), args, { env: { ...env, ...extraEnv }, input, encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, shell: false });
  assert.equal(r.error, undefined, `${name}: ${r.error?.code}`);
  assert.equal(r.status, 0, `${name} failed (${r.status}): ${r.stderr.slice(-3000)}`);
  return r.stdout.trim();
}
function sql(cluster, query, database = 'fcuno_synthetic') {
  return run('psql', ['-X', '--no-password', '-qAt', '-v', 'ON_ERROR_STOP=1', '-d', database], query, { PGHOST: cluster.socket, PGPORT: '55432', PGUSER: 'fcuno_recovery_operator' });
}
function newCluster(label) {
  const dir = join(root, label), socket = join(root, `${label}-socket`);
  mkdirSync(dir, { mode: 0o700 }); mkdirSync(socket, { mode: 0o700 });
  run('initdb', ['-D', dir, '--username=fcuno_recovery_operator', '--auth-local=trust', '--auth-host=reject', '--locale-provider=icu', '--icu-locale=en-US', '--locale=en_US.UTF-8', '--encoding=UTF8', '--no-instructions']);
  // Never load the image's Supabase entrypoint, config includes, WAL-G, cron,
  // pgsodium key helper or credentials. One inert extension needs preload.
  writeFileSync(join(dir, 'postgresql.conf'), [
    "listen_addresses=''", `unix_socket_directories='${socket}'`, 'port=55432',
    "shared_preload_libraries='pg_stat_statements'", "session_preload_libraries=''", "local_preload_libraries=''",
    'max_worker_processes=0', 'max_parallel_workers=0', 'max_parallel_workers_per_gather=0',
    'max_wal_senders=0', "wal_level='minimal'", "archive_mode='off'", "archive_command=''", "restore_command=''",
    'shared_buffers=64MB', 'work_mem=4MB', 'maintenance_work_mem=64MB', 'max_connections=12',
    'temp_file_limit=524288', 'log_statement=none', 'logging_collector=off', 'jit=off', 'autovacuum=off',
  ].join('\n') + '\n', { mode: 0o600 });
  const cluster = { dir, socket }; clusters.push(cluster);
  run('pg_ctl', ['-D', dir, '-l', join(dir, 'startup.log'), '-w', '-t', '30', 'start']);
  return cluster;
}
function facts(cluster) {
  return JSON.parse(sql(cluster, `SELECT json_build_object(
    'rows',(SELECT count(*) FROM public.fixture),
    'data',(SELECT md5(string_agg(id::text || ':' || payload || ':' || owner_name, E'\\n' ORDER BY id)) FROM public.fixture),
    'sequence',(SELECT json_build_array(last_value,is_called) FROM public.fixture_id_seq),
    'largeObjects',(SELECT json_agg(json_build_array(oid,md5(lo_get(oid))) ORDER BY oid) FROM pg_largeobject_metadata),
    'extensions',(SELECT json_object_agg(extname,extversion ORDER BY extname) FROM pg_extension),
    'vaultCiphertext',(SELECT md5(string_agg(row_to_json(s)::text, E'\\n' ORDER BY id)) FROM vault.secrets s),
    'vaultCount',(SELECT count(*) FROM vault.secrets),
    'rls',(SELECT json_build_array(relrowsecurity,relforcerowsecurity) FROM pg_class WHERE oid='public.fixture'::regclass),
    'policies',(SELECT json_agg(json_build_array(policyname,roles,qual,with_check) ORDER BY policyname) FROM pg_policies WHERE schemaname='public'),
    'indexes',(SELECT json_agg(indexdef ORDER BY indexname) FROM pg_indexes WHERE schemaname='public'),
    'trigger',(SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='fixture_audit'),
    'function',(SELECT pg_get_functiondef('private.fixture_log()'::regprocedure)),
    'grants',(SELECT json_agg(json_build_array(grantee,privilege_type) ORDER BY grantee,privilege_type) FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='fixture'),
    'owner',(SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='public.fixture'::regclass));`));
}
function databaseLocale(cluster) {
  return JSON.parse(sql(cluster, `SELECT json_build_object('provider',datlocprovider,'icuLocale',datlocale,'storedVersion',datcollversion,'actualVersion',pg_database_collation_actual_version(oid),'collate',datcollate,'ctype',datctype) FROM pg_database WHERE datname=current_database();`));
}

try {
  assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'x64'); assert.equal(process.versions.node.split('.')[0], '24'); assert.equal(process.getuid(), 1000);
  const status = readFileSync('/proc/self/status', 'utf8');
  assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^CapEff:\s+0+$/m);
  const mount = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').find((line) => line.split(' ')[4] === '/');
  assert.ok(mount?.split(' ')[5].split(',').includes('ro'), 'Container root must be read-only');
  assert.deepEqual(Object.keys(networkInterfaces()).sort(), ['lo'], 'Container must have no network interface except loopback');
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) assert.ok(!readFileSync(file, 'utf8').split('\n').slice(1).some((line) => line.trim().split(/\s+/)[3] === '0A'), 'No TCP listener is permitted');
  for (const key of Object.keys(process.env)) assert.ok(!/(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|GOOGLE|AWS|AZURE|SUPABASE|DATABASE_URL)/i.test(key), `Unexpected credential environment key: ${key}`);
  const memoryLimit = readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(); assert.ok(/^\d+$/.test(memoryLimit) && BigInt(memoryLimit) <= 2147483648n, 'Memory must be capped at 2 GiB');
  checks.push('nonroot-readonly-network-none-no-credentials-no-capabilities');
  for (const name of ['postgres', 'psql', 'pg_dump', 'pg_restore']) assert.match(run(name, ['--version']), /\b17\.6\b/);
  const source = newCluster('source');
  sql(source, 'CREATE DATABASE fcuno_synthetic;', 'postgres');
  const locale = databaseLocale(source);
  assert.deepEqual(locale, { provider: 'i', icuLocale: 'en-US', storedVersion: '153.121', actualVersion: '153.121', collate: 'en_US.UTF-8', ctype: 'en_US.UTF-8' });
  checks.push('exact-production-pg17.6-icu153.121');
  sql(source, `CREATE SCHEMA extensions; CREATE SCHEMA vault; CREATE SCHEMA private;
    CREATE EXTENSION hypopg WITH SCHEMA extensions VERSION '1.4.1';
    CREATE EXTENSION index_advisor WITH SCHEMA extensions VERSION '0.2.0';
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions VERSION '1.3';
    CREATE EXTENSION "uuid-ossp" WITH SCHEMA extensions VERSION '1.1';
    CREATE EXTENSION pg_stat_statements WITH SCHEMA extensions VERSION '1.11';
    CREATE EXTENSION supabase_vault WITH SCHEMA vault VERSION '0.3.1';
    CREATE ROLE fixture_owner NOLOGIN; CREATE ROLE fixture_viewer NOLOGIN;
    CREATE TABLE public.fixture(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,payload text NOT NULL,owner_name text NOT NULL);
    INSERT INTO public.fixture(payload,owner_name) SELECT 'synthetic-'||g||'-'||repeat(md5(g::text),8),CASE WHEN g%2=0 THEN 'fixture_viewer' ELSE 'fixture_owner' END FROM generate_series(1,12000)g;
    ALTER TABLE public.fixture OWNER TO fixture_owner;
    CREATE INDEX fixture_payload_idx ON public.fixture(lower(payload));
    ALTER TABLE public.fixture ENABLE ROW LEVEL SECURITY; ALTER TABLE public.fixture FORCE ROW LEVEL SECURITY;
    CREATE POLICY own_rows ON public.fixture TO fixture_viewer USING(owner_name=current_user) WITH CHECK(owner_name=current_user);
    GRANT SELECT ON public.fixture TO fixture_viewer;
    CREATE TABLE private.audit(id bigint PRIMARY KEY);
    CREATE FUNCTION private.fixture_log() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$BEGIN INSERT INTO private.audit VALUES(NEW.id); RETURN NEW; END$$;
    CREATE TRIGGER fixture_audit AFTER INSERT ON public.fixture FOR EACH ROW EXECUTE FUNCTION private.fixture_log();
    INSERT INTO vault.secrets(id,name,description,secret,nonce,created_at,updated_at) VALUES('11111111-1111-4111-8111-111111111111','synthetic-ciphertext','Opaque fixture only; not a real vault secret','c3ludGhldGljLW9wYXF1ZS1jaXBoZXJ0ZXh0',decode(repeat('00',24),'hex'),'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
    SELECT lo_from_bytea(42321,decode(repeat('0123456789abcdef',8192),'hex'));`);
  const sourceFacts = facts(source); assert.deepEqual(sourceFacts.extensions, expectedExtensions); assert.equal(sourceFacts.rows, 12000); assert.equal(sourceFacts.vaultCount, 1);
  assert.equal(sql(source, 'SET ROLE fixture_viewer; SELECT count(*) FROM public.fixture;'), '6000');
  checks.push('all-seven-exact-extension-versions-and-rls');
  const archive = join(root, 'fixture.dump');
  run('pg_dump', ['--format=custom', '--compress=gzip:3', '--create', '--no-password', '--file', archive, '--dbname', 'fcuno_synthetic'], undefined, { PGHOST: source.socket, PGPORT: '55432', PGUSER: 'fcuno_recovery_operator' });
  assert.equal(readFileSync(archive).subarray(0,5).toString(), 'PGDMP');
  const target = newCluster('target');
  sql(target, 'CREATE ROLE fixture_owner NOLOGIN; CREATE ROLE fixture_viewer NOLOGIN;', 'postgres');
  run('pg_restore', ['--exit-on-error', '--create', '--no-password', '--dbname', 'postgres', archive], undefined, { PGHOST: target.socket, PGPORT: '55432', PGUSER: 'fcuno_recovery_operator' });
  assert.deepEqual(databaseLocale(target), locale);
  assert.deepEqual(facts(target), sourceFacts);
  assert.equal(sql(target, 'SET ROLE fixture_viewer; SELECT count(*) FROM public.fixture;'), '6000');
  assert.equal(sql(target, "INSERT INTO public.fixture(payload,owner_name) VALUES('after-restore','fixture_owner') RETURNING id;"), '12001');
  assert.equal(sql(target, 'SELECT id FROM private.audit;'), '12001');
  assert.equal(sql(target, 'SELECT bool_and(NOT rolcanlogin) FROM pg_roles WHERE rolname IN(\'fixture_owner\',\'fixture_viewer\');'), 't');
  checks.push('independent-cluster-custom-gzip-full-restore-exact-facts', 'restored-rls-trigger-identity-and-nologin-roles');
  for (const cluster of clusters) { run('pg_ctl', ['-D', cluster.dir, '-m', 'fast', '-w', '-t', '20', 'stop']); cluster.stopped = true; assert.ok(!existsSync(join(cluster.dir, 'postmaster.pid'))); }
  checks.push('both-owned-clusters-cleanly-stopped');
  const receipt = { schema: 'fcuno.recovery-image-synthetic-proof/v1', checkedAt: new Date().toISOString(), sourceImageDigest: image, node: process.version, platform: `${process.platform}/${process.arch}`, locale, extensions: expectedExtensions, archiveBytes: statSync(archive).size, archiveSha256: sha(readFileSync(archive)), sourceFactsSha256: sha(JSON.stringify(sourceFacts)), checks, productionDataUsed: false, productionAccessUsed: false, actualCloudExecutionVerified: false, vaultDecryptionVerified: false, limitations: ['Synthetic image compatibility only; actual cloud controller/source/archive acceptance remains separate.', 'Opaque Vault configuration ciphertext is preserved; the source Vault encryption key is not included or tested.'] };
  writeFileSync('/output/compatibility-proof.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(receipt));
} finally {
  for (const cluster of clusters.filter((c) => !c.stopped)) {
    const r = spawnSync(join(binaryRoot, 'pg_ctl'), ['-D', cluster.dir, '-m', 'immediate', '-w', '-t', '20', 'stop'], { env, encoding: 'utf8', timeout: 25_000, maxBuffer: 65536 });
    if (r.status !== 0 && existsSync(join(cluster.dir, 'postmaster.pid'))) console.error('Owned synthetic PostgreSQL cluster cleanup was not confirmed');
  }
}
