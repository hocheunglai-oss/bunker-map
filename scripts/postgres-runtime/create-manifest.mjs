import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { POSTGRES_RUNTIME_FILES, POSTGRES_RUNTIME_VERSION, POSTGRES_RUNTIME_SOURCE_SHA256, POSTGRES_RUNTIME_BASE_IMAGE, verifyPostgresRuntimeBundle } from './postgres-runtime-bundle.mjs';

const root = '/opt/fcuno-output/postgres';
const files = {};
for (const name of POSTGRES_RUNTIME_FILES) {
  const bytes = await readFile(path.join(root, name));
  const entry = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (!name.startsWith('licenses/')) {
    const dynamic = execFileSync('/usr/bin/readelf', ['-dW', path.join(root, name)], { encoding: 'utf8' });
    entry.needed = [...dynamic.matchAll(/\(NEEDED\).*\[([^\]]+)\]/g)].map((match) => match[1]).sort();
    entry.rpath = dynamic.match(/\(RPATH\).*\[([^\]]+)\]/)?.[1] || '';
    entry.runpath = dynamic.match(/\(RUNPATH\).*\[([^\]]+)\]/)?.[1] || '';
    const symbols = execFileSync('/usr/bin/readelf', ['--version-info', path.join(root, name)], { encoding: 'utf8' });
    entry.glibcVersions = [...new Set(symbols.match(/GLIBC_[0-9.]+/g))].sort();
    // Real loader resolution must use our own libraries, never the installed
    // builder prefix or opportunistically available system OpenSSL/zlib/libpq.
    const linked = execFileSync('/usr/bin/ldd', [path.join(root, name)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    if (/not found/.test(linked)) throw new Error('Missing runtime dependency');
    if (name.startsWith('bin/') || name === 'lib/libpq.so.5') {
      for (const match of linked.matchAll(/(lib(?:pq\.so\.5|ssl\.so\.3|crypto\.so\.3|z\.so\.1)) => (\S+)/g)) {
        if (path.resolve(match[2]) !== path.join(root, 'lib', match[1])) throw new Error(`Unbundled dependency for ${name}`);
      }
    }
  }
  files[name] = entry;
}
const manifest = {
  schema: 'fcuno-postgres-runtime/v1', platform: 'linux-x64', postgresVersion: POSTGRES_RUNTIME_VERSION,
  sourceSha256: POSTGRES_RUNTIME_SOURCE_SHA256, baseImage: POSTGRES_RUNTIME_BASE_IMAGE,
  ssl: 'openssl', compression: 'zlib',
  compiler: execFileSync('/usr/bin/gcc', ['--version'], { encoding: 'utf8' }).split('\n')[0],
  amazonLinuxRelease: (await readFile('/opt/fcuno-output/al2023-release.txt', 'utf8')).trim(),
  packageInventorySha256: createHash('sha256').update(await readFile('/opt/fcuno-output/build-rpms.txt')).digest('hex'),
  files,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(path.join(root, 'manifest.json'), serialized, { mode: 0o644 });
const digest = createHash('sha256').update(serialized).digest('hex');
await verifyPostgresRuntimeBundle(root, digest);
console.log(JSON.stringify({ schema: manifest.schema, postgresVersion: manifest.postgresVersion, manifestSha256: digest, files: Object.keys(files).length }));
