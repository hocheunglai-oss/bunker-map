import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPostgresRuntimeBundle, POSTGRES_RUNTIME_FILES } from './lib/postgres-runtime-bundle.mjs';

export const ARCHIVE_SHA256 = '3c0ea846d2bd7d457cc0961dc0769388d7610484c1a5f7fe486f89a98256f77e';
export const MANIFEST_SHA256 = '0c46dab3243145b16b5c12ca6b41dee84a4b34c41bae2abecb675ec78e6ebc53';
export const CA_SHA256 = '700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw Error('Pinned PostgreSQL build assets failed verification'); };
const root = fileURLToPath(new URL('../', import.meta.url));
const expectedFiles = new Set(['postgres/manifest.json', ...POSTGRES_RUNTIME_FILES.map(name => `postgres/${name}`)]);
const expectedDirectories = new Set(['postgres/', 'postgres/bin/', 'postgres/lib/', 'postgres/licenses/']);

// Minimal fixed-layout tar reader: no links, extensions, path prefixes or arbitrary
// output paths. The archive digest is also checked BEFORE calling this parser.
export function decodeRuntimeTar(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 16 * 1024 * 1024 || bytes.length % 512) fail();
  const entries = [], seen = new Set();
  let offset = 0;
  const number = field => { const text = field.toString('ascii').replace(/\0/g, '').trim(); if (!/^[0-7]+$/.test(text)) fail(); return parseInt(text, 8); };
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) {
      if (bytes.length - offset < 1024 || !bytes.subarray(offset).every(value => value === 0)) fail();
      offset = bytes.length; break;
    }
    const checksum = number(header.subarray(148, 156));
    if ([...header].reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0) !== checksum) fail();
    const name = header.subarray(0, 100).toString('ascii').replace(/\0.*$/s, '');
    const type = header[156], size = number(header.subarray(124, 136));
    if (seen.has(name) || header.subarray(157, 257).some(value => value !== 0) || header.subarray(345, 500).some(value => value !== 0)) fail();
    seen.add(name);
    if (type === 53) { if (!expectedDirectories.has(name) || size !== 0) fail(); }
    else if ((type !== 48 && type !== 0) || !expectedFiles.has(name) || size <= 0 || size > 8 * 1024 * 1024) fail();
    const start = offset + 512, end = start + size;
    if (end > bytes.length) fail();
    if (type !== 53) entries.push({ name, bytes: bytes.subarray(start, end), mode: name.includes('/licenses/') || name.endsWith('/manifest.json') ? 0o644 : 0o755 });
    offset = start + Math.ceil(size / 512) * 512;
  }
  if (offset !== bytes.length || seen.size !== expectedFiles.size + expectedDirectories.size || entries.length !== expectedFiles.size) fail();
  return entries;
}

async function directory(target) {
  await mkdir(target, { mode: 0o755 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) || await realpath(target) !== target) fail();
}

export async function installPostgresRuntime(projectRoot = root) {
  projectRoot = await realpath(projectRoot);
  const assets = path.join(projectRoot, 'runtime-bundles');
  const archivePath = path.join(assets, 'postgres17-linux-x64.tar.gz');
  const caPath = path.join(assets, 'supabase-prod-ca-2021.crt');
  for (const file of [archivePath, caPath]) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || stat.size > 4 * 1024 * 1024) fail();
  }
  const archive = await readFile(archivePath), ca = await readFile(caPath);
  if (hash(archive) !== ARCHIVE_SHA256 || hash(ca) !== CA_SHA256) fail();
  const entries = decodeRuntimeTar(gunzipSync(archive, { maxOutputLength: 16 * 1024 * 1024 }));
  const runtime = path.join(projectRoot, '.runtime');
  await directory(runtime);
  const destination = path.join(runtime, 'postgres');
  const existing = await lstat(destination).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing) await inspectPostgresRuntimeBundle(destination, MANIFEST_SHA256);
  else {
    const staging = await mkdtemp(path.join(runtime, '.postgres-install-'));
    try {
      for (const name of expectedDirectories) await mkdir(path.join(staging, name), { mode: 0o755 });
      for (const entry of entries) await writeFile(path.join(staging, entry.name), entry.bytes, { flag: 'wx', mode: entry.mode });
      await inspectPostgresRuntimeBundle(path.join(staging, 'postgres'), MANIFEST_SHA256);
      await rename(path.join(staging, 'postgres'), destination);
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
  const caDirectory = path.join(runtime, 'postgres-source');
  await directory(caDirectory);
  const targetCa = path.join(caDirectory, 'root.crt');
  try { await writeFile(targetCa, ca, { flag: 'wx', mode: 0o644 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const caStat = await lstat(targetCa);
  if (!caStat.isFile() || caStat.isSymbolicLink() || (caStat.mode & 0o022) || hash(await readFile(targetCa)) !== CA_SHA256) fail();
  return { archiveSha256: ARCHIVE_SHA256, manifestSha256: MANIFEST_SHA256, certificateSha256: CA_SHA256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installPostgresRuntime().then(() => console.log('Pinned native backup assets verified (no network or database access).')).catch(() => { console.error('Pinned native backup assets failed verification.'); process.exitCode = 1; });
}
