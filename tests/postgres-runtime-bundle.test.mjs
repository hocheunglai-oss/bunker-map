import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, chmod, symlink, unlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { POSTGRES_RUNTIME_FILES, POSTGRES_RUNTIME_VERSION, POSTGRES_RUNTIME_SOURCE_SHA256, POSTGRES_RUNTIME_BASE_IMAGE, inspectPostgresRuntimeBundle, verifyPostgresRuntimeBundle } from '../scripts/lib/postgres-runtime-bundle.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const root = await mkdtemp(path.join(await import('node:fs/promises').then((m) => m.realpath(os.tmpdir())), 'pg-runtime-unit-'));
  for (const name of ['bin', 'lib', 'licenses']) await mkdir(path.join(root, name), { mode: 0o755 });
  const files = {};
  for (const name of POSTGRES_RUNTIME_FILES) {
    const bytes = Buffer.alloc(80, 0);
    Buffer.from('7f454c460201', 'hex').copy(bytes);
    bytes.writeUInt16LE(62, 18);
    await writeFile(path.join(root, name), bytes, { mode: name.startsWith('licenses/') ? 0o644 : 0o755 });
    files[name] = { size: bytes.length, sha256: hash(bytes), needed: ['libc.so.6'], rpath: name.startsWith('bin/') || name === 'lib/libpq.so.5' ? '$ORIGIN/../lib:$ORIGIN' : '', runpath: '' };
  }
  const manifest = { schema: 'fcuno-postgres-runtime/v1', platform: 'linux-x64', postgresVersion: POSTGRES_RUNTIME_VERSION, sourceSha256: POSTGRES_RUNTIME_SOURCE_SHA256, baseImage: POSTGRES_RUNTIME_BASE_IMAGE, ssl: 'openssl', compression: 'zlib', files };
  async function save() { const value = JSON.stringify(manifest); await writeFile(path.join(root, 'manifest.json'), value, { mode: 0o644 }); return hash(value); }
  return { root, manifest, save, digest: await save(), async close() { await rm(root, { recursive: true, force: true }); } };
}

test('valid pinned manifest returns fixed binaries, without executing them', async () => {
  const f = await fixture();
  try { const value = await inspectPostgresRuntimeBundle(f.root, f.digest); assert.equal(value.binaries.pgDump.path, `${f.root}/bin/pg_dump`); assert.equal(value.manifestSha256, f.digest); } finally { await f.close(); }
});
test('missing, malformed and mismatching externally supplied manifest pins fail', async () => {
  const f = await fixture();
  try { for (const pin of [undefined, '', 'x', '0'.repeat(64)]) await assert.rejects(inspectPostgresRuntimeBundle(f.root, pin)); } finally { await f.close(); }
});
test('modified library, even with unchanged client hashes, fails', async () => {
  const f = await fixture();
  try { await writeFile(`${f.root}/lib/libcrypto.so.3`, Buffer.alloc(80, 1)); await assert.rejects(inspectPostgresRuntimeBundle(f.root, f.digest)); } finally { await f.close(); }
});
test('symlink, extra file, writable directory and writable binary each fail', async () => {
  for (const change of [
    async (f) => { await unlink(`${f.root}/lib/libz.so.1`); await symlink('libcrypto.so.3', `${f.root}/lib/libz.so.1`); },
    async (f) => writeFile(`${f.root}/lib/rogue.so`, 'bad'),
    async (f) => chmod(`${f.root}/lib`, 0o777),
    async (f) => chmod(`${f.root}/bin/psql`, 0o777),
  ]) { const f = await fixture(); try { await change(f); await assert.rejects(inspectPostgresRuntimeBundle(f.root, f.digest)); } finally { await f.close(); } }
});
test('repinned malformed dependency, path traversal, version, ELF and RPATH fail', async () => {
  for (const change of [
    (f) => { f.manifest.files['bin/psql'].needed = ['libunknown.so']; },
    (f) => { f.manifest.files['../outside'] = f.manifest.files['bin/psql']; },
    (f) => { f.manifest.postgresVersion = '16.0'; },
    (f) => { f.manifest.files['bin/pg_dump'].rpath = '/usr/lib64'; },
    (f) => { f.manifest.files['bin/pg_dump'].runpath = '$ORIGIN/../lib'; },
    async (f) => { const bytes = await readFile(`${f.root}/bin/psql`); bytes.writeUInt16LE(183, 18); await writeFile(`${f.root}/bin/psql`, bytes); f.manifest.files['bin/psql'].sha256 = hash(bytes); },
  ]) { const f = await fixture(); try { await change(f); await assert.rejects(inspectPostgresRuntimeBundle(f.root, await f.save())); } finally { await f.close(); } }
});
test('runtime entrypoint refuses a non-Linux-x64-Node24 host', async () => {
  const f = await fixture();
  try {
    if (process.platform === 'linux' && process.arch === 'x64' && process.versions.node.startsWith('24.')) assert.equal((await verifyPostgresRuntimeBundle(f.root, f.digest)).manifestSha256, f.digest);
    else await assert.rejects(verifyPostgresRuntimeBundle(f.root, f.digest));
  } finally { await f.close(); }
});
