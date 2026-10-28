import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export const POSTGRES_RUNTIME_VERSION = '17.11';
export const POSTGRES_RUNTIME_SOURCE_SHA256 = 'dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979';
export const POSTGRES_RUNTIME_BASE_IMAGE = 'public.ecr.aws/lambda/nodejs@sha256:5e24cf7b98b54d2d782476d9579f8043c5c30e42d7ef97759a67b2940f696b2d';
export const POSTGRES_RUNTIME_FILES = Object.freeze([
  'bin/pg_dump', 'bin/pg_restore', 'bin/psql',
  'lib/libcrypto.so.3', 'lib/libpq.so.5', 'lib/libssl.so.3', 'lib/libz.so.1',
  'licenses/postgresql-COPYRIGHT', 'licenses/openssl-LICENSE.txt', 'licenses/zlib-README',
]);
const BUNDLED_LIBRARIES = new Set(['libpq.so.5', 'libssl.so.3', 'libcrypto.so.3', 'libz.so.1']);
const SYSTEM_LIBRARIES = new Set(['libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'libresolv.so.2', 'librt.so.1', 'ld-linux-x86-64.so.2']);
const HASH = /^[0-9a-f]{64}$/;
const fail = () => { throw new Error('PostgreSQL runtime bundle verification failed'); };
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Pure file inspection is exported for portable tests. Production callers must use
// verifyPostgresRuntimeBundle, which also enforces the actual execution platform.
export async function inspectPostgresRuntimeBundle(rootDirectory, expectedManifestSha256) {
  if (!path.isAbsolute(rootDirectory) || path.resolve(rootDirectory) !== rootDirectory || !HASH.test(expectedManifestSha256 || '')) fail();
  if (await realpath(rootDirectory) !== rootDirectory) fail();
  for (const directory of ['', 'bin', 'lib', 'licenses']) {
    const stat = await lstat(path.join(rootDirectory, directory));
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022)) fail();
  }
  const expected = new Set(['manifest.json', ...POSTGRES_RUNTIME_FILES]);
  const found = [];
  for (const directory of ['', 'bin', 'lib', 'licenses']) {
    for (const entry of await readdir(path.join(rootDirectory, directory), { withFileTypes: true })) {
      if (!directory && ['bin', 'lib', 'licenses'].includes(entry.name) && entry.isDirectory()) continue;
      const name = directory ? `${directory}/${entry.name}` : entry.name;
      if (!entry.isFile() || !expected.has(name)) fail();
      found.push(name);
    }
  }
  if (found.length !== expected.size) fail();
  const manifestPath = path.join(rootDirectory, 'manifest.json');
  const manifestStat = await lstat(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o022) || manifestStat.size > 128 * 1024) fail();
  const manifestBytes = await readFile(manifestPath);
  if (sha256(manifestBytes) !== expectedManifestSha256) fail();
  let manifest;
  try { manifest = JSON.parse(manifestBytes); } catch { fail(); }
  if (manifest?.schema !== 'fcuno-postgres-runtime/v1' || manifest.platform !== 'linux-x64' || manifest.postgresVersion !== POSTGRES_RUNTIME_VERSION || manifest.sourceSha256 !== POSTGRES_RUNTIME_SOURCE_SHA256 || manifest.baseImage !== POSTGRES_RUNTIME_BASE_IMAGE || manifest.ssl !== 'openssl' || manifest.compression !== 'zlib' || !manifest.files || typeof manifest.files !== 'object') fail();
  if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...POSTGRES_RUNTIME_FILES].sort())) fail();
  for (const relativePath of POSTGRES_RUNTIME_FILES) {
    const filePath = path.join(rootDirectory, relativePath);
    const stat = await lstat(filePath);
    const entry = manifest.files[relativePath];
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || await realpath(filePath) !== filePath || !HASH.test(entry?.sha256 || '') || !Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > 32 * 1024 * 1024 || stat.size !== entry.size) fail();
    const bytes = await readFile(filePath);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) fail();
    if (relativePath.startsWith('licenses/')) continue;
    // ELF64, little endian, x86-64. Dependencies and RPATH are independently
    // extracted during the native build and authenticated by the manifest pin.
    if (bytes.length < 64 || bytes.subarray(0, 6).toString('hex') !== '7f454c460201' || bytes.readUInt16LE(18) !== 62 || !Array.isArray(entry.needed) || entry.needed.some((name) => !BUNDLED_LIBRARIES.has(name) && !SYSTEM_LIBRARIES.has(name))) fail();
    if (relativePath.startsWith('bin/') && (!(stat.mode & 0o111) || entry.rpath !== '$ORIGIN/../lib:$ORIGIN' || entry.runpath)) fail();
    if (relativePath === 'lib/libpq.so.5' && (entry.rpath !== '$ORIGIN/../lib:$ORIGIN' || entry.runpath)) fail();
  }
  return Object.freeze({
    binaries: Object.freeze({
      psql: Object.freeze({ path: path.join(rootDirectory, 'bin/psql'), sha256: manifest.files['bin/psql'].sha256 }),
      pgDump: Object.freeze({ path: path.join(rootDirectory, 'bin/pg_dump'), sha256: manifest.files['bin/pg_dump'].sha256 }),
      pgRestore: Object.freeze({ path: path.join(rootDirectory, 'bin/pg_restore'), sha256: manifest.files['bin/pg_restore'].sha256 }),
    }),
    manifestSha256: expectedManifestSha256,
  });
}

export async function verifyPostgresRuntimeBundle(rootDirectory, expectedManifestSha256) {
  if (process.platform !== 'linux' || process.arch !== 'x64' || Number(process.versions.node.split('.')[0]) !== 24) fail();
  return inspectPostgresRuntimeBundle(rootDirectory, expectedManifestSha256);
}
