# Fixed PostgreSQL native runtime candidate

This is packaging and synthetic verification only. It does not deploy a Vercel
function, install a production credential, trigger a backup, or connect to FCUNO.

The workflow builds PostgreSQL 17.11 from the checksum-pinned official source in
an immutable official AWS Lambda Node24 x86_64 image based on Amazon Linux 2023.
Vercel documents AL2023 as its build image; this compatible baseline is **not** a
claim that the actual deployed Vercel function has already been tested. Package
repositories are pinned to the image release. The emitted RPM inventory and its
hash document the build dependencies. An image update requires a reviewed digest
change and a new native proof. No unverified prebuilt client is downloaded.

The artifact includes psql, pg_dump, pg_restore, libpq, OpenSSL 3 and zlib, and
their licenses. The compiler supplies a literal origin-relative DT_RPATH;
library resolution does not rely on `LD_LIBRARY_PATH` or an installed PostgreSQL.
The manifest pins every file, its ELF dependencies and build provenance. The
production helper requires Linux x64 / Node24, the externally reviewed manifest
SHA-256, a fixed complete file set, safe modes, no symlinks, and all file hashes.
The deploy integration must preserve read-only deployment files to avoid a
verification-to-execution race. This verifier is not a sandbox for hostile code.

The offline, non-root proof runs the shipped clients in the clean image, with no
compiler packages and no outside network. It proves valid TLS, rejects an invalid
hostname, invalid CA and plaintext connection, exports a real gzip-compressed
custom archive, restores to a second synthetic server, and compares rows, a large
object, sequence state, indexes, policies, grants, a materialized view and a
trigger. It then executes the restored identity and trigger. Only this synthetic
receipt and the binary artifact leave the runner; no database export is uploaded.

Production integration must additionally:

- Pin the reviewed emitted manifest hash outside the bundle, include the entire
  `.runtime/postgres/` directory in the function trace, and call
  `verifyPostgresRuntimeBundle(fixedRoot, expectedManifestSha256)` before reading
  credentials. Do not accept any of those paths or pins from request data.
- Use the separately pinned Supabase CA, `sslmode=verify-full`, a clean child
  environment and `OPENSSL_CONF=/dev/null`; do not use system roots as a fallback.
- Run a non-exporting compatibility smoke on the real Vercel Node24 runtime
  before enabling export. Neither CI success nor a build-image match proves
  source permissions, production performance, retention, or restore completeness.
- Retain the workflow run, exact source commit, artifact SHA, manifest SHA and
  native proof receipt. The recipe is pinned; bit-identical independent rebuilds
  have not been claimed or proven.
