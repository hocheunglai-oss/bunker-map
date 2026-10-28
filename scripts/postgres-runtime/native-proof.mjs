import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import path from 'node:path';
import { verifyPostgresRuntimeBundle } from './postgres-runtime-bundle.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.equal(Number(process.versions.node.split('.')[0]), 24);
assert.notEqual(process.getuid(), 0, 'initdb must run unprivileged');
const runtime = '/opt/fcuno-runtime/postgres';
const fixture = '/opt/fcuno-test/postgres/bin';
const root = await mkdtemp('/tmp/fcuno-native-proof-');
const manifestSha256 = createHash('sha256').update(await readFile(`${runtime}/manifest.json`)).digest('hex');
const { binaries } = await verifyPostgresRuntimeBundle(runtime, manifestSha256);
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: root, TMPDIR: root, OPENSSL_CONF: '/dev/null', PGCONNECT_TIMEOUT: '5', PGSSLMODE: 'verify-full', PGSSLROOTCERT: '/opt/fcuno-test/tls/ca.crt', PGHOST: 'localhost', PGPORT: '55489', PGUSER: 'fcunotest', PGDATABASE: 'fixture' };
assert.equal(env.LD_LIBRARY_PATH, undefined);
const run = (command, args, extra = {}) => execFileSync(command, args, { env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
const sql = (text, extra = {}) => run(binaries.psql.path, ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', text], extra).trim();
const sourceData = path.join(root, 'source');
const targetData = path.join(root, 'restored');
let sourceStarted = false;
let targetStarted = false;
const checks = [];
try {
  for (const binary of Object.values(binaries)) assert.match(run(binary.path, ['--version']), /17\.11/);
  checks.push('pinned-linux-x64-node24-all-client-versions');
  // Source listens only on loopback; docker --network none supplies no outside
  // network. The recovery cluster is separate and contains synthetic data only.
  for (const [data, port] of [[sourceData, 55489], [targetData, 55490]]) {
    run(path.join(fixture, 'initdb'), ['-D', data, '--no-locale', '--encoding=UTF8', '--auth-local=trust', '--auth-host=trust']);
    await copyFile('/opt/fcuno-test/tls/server.crt', `${data}/server.crt`);
    await copyFile('/opt/fcuno-test/tls/server.key', `${data}/server.key`);
    await chmod(`${data}/server.key`, 0o600);
    await writeFile(`${data}/postgresql.conf`, `listen_addresses='127.0.0.1'\nport=${port}\nunix_socket_directories='${root}'\nssl=on\nssl_cert_file='server.crt'\nssl_key_file='server.key'\nshared_buffers='16MB'\nmax_connections=10\n`, { flag: 'a' });
    await writeFile(`${data}/pg_hba.conf`, 'local all all trust\nhostssl all all 127.0.0.1/32 trust\nhostnossl all all 127.0.0.1/32 reject\n');
    run(path.join(fixture, 'pg_ctl'), ['-D', data, '-l', `${root}/${port}.log`, '-w', 'start']);
    if (port === 55489) sourceStarted = true; else targetStarted = true;
  }
  assert.equal(sql('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()', { PGDATABASE: 'postgres' }), 't');
  checks.push('verify-full-tls-connection');
  assert.throws(() => sql('SELECT 1', { PGDATABASE: 'postgres', PGHOST: 'wrong-host.invalid', PGHOSTADDR: '127.0.0.1' }), /does not match host name|certificate.*match/);
  checks.push('wrong-hostname-rejected');
  assert.throws(() => sql('SELECT 1', { PGDATABASE: 'postgres', PGSSLROOTCERT: '/opt/fcuno-test/tls/wrong-ca.crt' }), /certificate verify failed/);
  checks.push('wrong-ca-rejected');
  assert.throws(() => sql('SELECT 1', { PGDATABASE: 'postgres', PGSSLMODE: 'disable' }), /rejects connection|no encryption/);
  checks.push('unencrypted-connection-rejected');
  sql('CREATE DATABASE fixture', { PGDATABASE: 'postgres' });
  sql('CREATE ROLE application_reader', { PGDATABASE: 'postgres' });
  sql('CREATE ROLE application_reader', { PGDATABASE: 'postgres', PGPORT: '55490' });
  sql(`CREATE SCHEMA source_app;
    CREATE TABLE source_app.contacts (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL, payload text NOT NULL, updated integer NOT NULL DEFAULT 0);
    INSERT INTO source_app.contacts(label,payload) SELECT 'Synthetic '||g, repeat(md5(g::text),40) FROM generate_series(1,12000) g;
    CREATE INDEX contacts_label ON source_app.contacts(label);
    CREATE FUNCTION source_app.touch() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN NEW.updated=OLD.updated+1; RETURN NEW; END$$;
    CREATE TRIGGER touch BEFORE UPDATE ON source_app.contacts FOR EACH ROW EXECUTE FUNCTION source_app.touch();
    ALTER TABLE source_app.contacts ENABLE ROW LEVEL SECURITY;
    CREATE POLICY fixture_read ON source_app.contacts FOR SELECT TO application_reader USING (id > 0);
    GRANT USAGE ON SCHEMA source_app TO application_reader;
    GRANT SELECT ON source_app.contacts TO application_reader;
    CREATE MATERIALIZED VIEW source_app.summary AS SELECT count(*) AS total FROM source_app.contacts;
    SELECT lo_from_bytea(45678, decode(repeat('cafe',5000),'hex'));
    COMMENT ON TABLE source_app.contacts IS 'Synthetic restore evidence only';`);
  const summarySql = `SELECT jsonb_build_object(
    'rows',(SELECT count(*) FROM source_app.contacts),
    'content',(SELECT md5(string_agg(id::text||label||payload||updated::text,'|' ORDER BY id)) FROM source_app.contacts),
    'largeObject',md5(lo_get(45678)),
    'sequence',(SELECT last_value FROM source_app.contacts_id_seq),
    'rls',(SELECT relrowsecurity FROM pg_class WHERE oid='source_app.contacts'::regclass),
    'policy',(SELECT count(*) FROM pg_policy WHERE polrelid='source_app.contacts'::regclass),
    'grant',has_table_privilege('application_reader','source_app.contacts','SELECT'),
    'view',(SELECT total FROM source_app.summary),
    'index',(SELECT count(*) FROM pg_indexes WHERE schemaname='source_app'),
    'trigger',(SELECT count(*) FROM pg_trigger WHERE tgrelid='source_app.contacts'::regclass AND NOT tgisinternal),
    'comment',obj_description('source_app.contacts'::regclass))`;
  const sourceSummary = JSON.parse(sql(summarySql));
  const archive = `${root}/synthetic.dump`;
  const dump = spawn(binaries.pgDump.path, ['--format=custom', '--compress=gzip:3', '--create', '--no-password', '--lock-wait-timeout=2000'], { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  dump.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4096); });
  const exit = once(dump, 'close');
  await pipeline(dump.stdout, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
  const [code] = await exit;
  assert.equal(code, 0, `Synthetic dump failed: ${stderr}`);
  assert.ok((await stat(archive)).size > 4096 && (await stat(archive)).size < 2 * 1024 * 1024, 'gzip archive is materially compressed');
  assert.match(run(binaries.pgRestore.path, ['--list', archive]), /source_app contacts/);
  checks.push('custom-format-gzip3-archive-created');
  run(binaries.pgRestore.path, ['--exit-on-error', '--create', '--dbname=postgres', archive], { PGPORT: '55490' });
  assert.deepEqual(JSON.parse(sql(summarySql, { PGPORT: '55490' })), sourceSummary);
  checks.push('isolated-restore-rows-schema-sequence-rls-grants-trigger-view-large-object-match');
  assert.equal(sql("UPDATE source_app.contacts SET label='Synthetic update' WHERE id=1 RETURNING updated", { PGPORT: '55490' }).split('\n')[0], '1');
  assert.equal(sql("INSERT INTO source_app.contacts(label,payload) VALUES ('Synthetic new','x') RETURNING id", { PGPORT: '55490' }).split('\n')[0], '12001');
  checks.push('restored-trigger-and-identity-execute');
  const receipt = {
    schema: 'fcuno-postgres-native-proof/v1', passed: true, sourceData: 'synthetic-only', externalNetwork: false,
    platform: `${process.platform}-${process.arch}`, nodeVersion: process.version, postgresVersion: '17.11',
    manifestSha256, archiveSize: (await stat(archive)).size, archiveSha256: createHash('sha256').update(await readFile(archive)).digest('hex'),
    restoredRows: sourceSummary.rows, checks, productionCompatibilityTested: false, productionDatabaseAccessed: false,
  };
  await mkdir('/evidence', { recursive: true });
  await writeFile('/evidence/native-proof.json', `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o644 });
  console.log(JSON.stringify(receipt));
} finally {
  if (sourceStarted) run(path.join(fixture, 'pg_ctl'), ['-D', sourceData, '-m', 'fast', '-w', 'stop']);
  if (targetStarted) run(path.join(fixture, 'pg_ctl'), ['-D', targetData, '-m', 'fast', '-w', 'stop']);
}
