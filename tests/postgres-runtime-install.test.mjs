import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, symlink, realpath, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { installPostgresRuntime, decodeRuntimeTar, MANIFEST_SHA256 } from '../scripts/install-postgres-runtime.mjs';
import { inspectPostgresRuntimeBundle } from '../scripts/lib/postgres-runtime-bundle.mjs';
const assets = fileURLToPath(new URL('../runtime-bundles/', import.meta.url));
async function fixture() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'fcuno-offline-runtime-'));
  await mkdir(path.join(root, 'runtime-bundles'));
  for (const name of ['postgres17-linux-x64.tar.gz', 'supabase-prod-ca-2021.crt']) await copyFile(path.join(assets, name), path.join(root, 'runtime-bundles', name));
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}
test('reviewed real archive installs offline, verifies every file and reuses a valid cache', async () => {
  const f = await fixture();
  try {
    assert.equal((await installPostgresRuntime(f.root)).manifestSha256, MANIFEST_SHA256);
    const binary = path.join(f.root, '.runtime/postgres/bin/psql'), before = await lstat(binary);
    await inspectPostgresRuntimeBundle(path.join(f.root, '.runtime/postgres'), MANIFEST_SHA256);
    await installPostgresRuntime(f.root);
    assert.equal((await lstat(binary)).ino, before.ino);
    assert.deepEqual((await readdir(path.join(f.root, '.runtime'))).sort(), ['postgres', 'postgres-source']);
  } finally { await f.close(); }
});
test('modified archive or public CA is rejected before generating runtime files', async () => {
  for (const name of ['postgres17-linux-x64.tar.gz', 'supabase-prod-ca-2021.crt']) {
    const f = await fixture();
    try { await writeFile(path.join(f.root, 'runtime-bundles', name), 'altered'); await assert.rejects(installPostgresRuntime(f.root)); await assert.rejects(lstat(path.join(f.root, '.runtime')), { code: 'ENOENT' }); }
    finally { await f.close(); }
  }
});
test('existing modified cache is not overwritten or accepted', async () => {
  const f = await fixture();
  try {
    await installPostgresRuntime(f.root);
    const binary = path.join(f.root, '.runtime/postgres/bin/psql');
    await writeFile(binary, 'altered'); await assert.rejects(installPostgresRuntime(f.root));
    assert.equal(await readFile(binary, 'utf8'), 'altered');
  } finally { await f.close(); }
});
test('symlink runtime directory and CA destination are rejected without following writes', async () => {
  for (const mode of ['runtime', 'certificate']) {
    const f = await fixture();
    try {
      const outside = path.join(f.root, 'untouched'); await mkdir(outside);
      if (mode === 'runtime') await symlink(outside, path.join(f.root, '.runtime'));
      else {
        await mkdir(path.join(f.root, '.runtime')); await mkdir(path.join(f.root, '.runtime/postgres-source'));
        await writeFile(path.join(outside, 'sentinel'), 'preserve');
        await symlink(path.join(outside, 'sentinel'), path.join(f.root, '.runtime/postgres-source/root.crt'));
      }
      await assert.rejects(installPostgresRuntime(f.root));
      if (mode === 'runtime') assert.deepEqual(await readdir(outside), []);
      else assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserve');
    } finally { await f.close(); }
  }
});
function replaceHeader(bytes, change) {
  const result = Buffer.from(bytes), header = result.subarray(0, 512);
  change(header); header.fill(32, 148, 156);
  const sum = [...header].reduce((a, b) => a + b, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return result;
}
test('fixed tar parser rejects traversal, links, extensions, bad checksums and trailing data', async () => {
  const original = gunzipSync(await readFile(path.join(assets, 'postgres17-linux-x64.tar.gz')));
  assert.equal(decodeRuntimeTar(original).length, 11);
  for (const bytes of [
    replaceHeader(original, h => { h.fill(0, 0, 100); h.write('../outside/'); }),
    replaceHeader(original, h => { h[156] = 50; }),
    replaceHeader(original, h => { h[156] = 120; }),
    replaceHeader(original, h => { h[345] = 97; }),
    Buffer.from(original).fill(0, 148, 156),
    Buffer.concat([original, Buffer.alloc(512, 1)]),
  ]) assert.throws(() => decodeRuntimeTar(bytes));
});
test('production entrypoint installs before compiler; only backup routes trace runtime assets', async () => {
  const build = await readFile(new URL('../scripts/build-production.mjs', import.meta.url), 'utf8');
  assert.match(build, /installPostgresRuntime\(\)\.then\(\(\) => runProductionBuild\(\)\)/);
  const config = await import('../next.config.js').then(value => value.default);
  const traced = Object.entries(config.outputFileTracingIncludes).filter(([, values]) => values.some(value => value.includes('.runtime/'))).map(([key]) => key).sort();
  assert.deepEqual(traced, ['/api/admin/system-health/postgres-backup', '/api/backups/postgres']);
});
