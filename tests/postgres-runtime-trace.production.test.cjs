const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, realpathSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
test('all three compiled server routes include every pinned native asset and public CA', async () => {
  const { POSTGRES_RUNTIME_FILES, inspectPostgresRuntimeBundle } = await import('../scripts/lib/postgres-runtime-bundle.mjs');
  const { MANIFEST_SHA256 } = await import('../scripts/install-postgres-runtime.mjs');
  const root = realpathSync(resolve(__dirname, '..'));
  await inspectPostgresRuntimeBundle(resolve(root, '.runtime/postgres'), MANIFEST_SHA256);
  const expected = ['.runtime/postgres/manifest.json', ...POSTGRES_RUNTIME_FILES.map(name => `.runtime/postgres/${name}`), '.runtime/postgres-source/root.crt'];
  for (const route of ['backups/postgres', 'backups/postgres-probe', 'admin/system-health/postgres-backup']) {
    const filename = resolve(root, '.next/server/app/api', route, 'route.js.nft.json');
    const trace = JSON.parse(readFileSync(filename, 'utf8'));
    const files = new Set(trace.files.map(name => resolve(dirname(filename), name)));
    for (const name of expected) assert.ok(files.has(resolve(root, name)), `${route} is missing ${name}`);
  }
});
