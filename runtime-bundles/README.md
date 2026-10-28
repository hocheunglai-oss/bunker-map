# Pinned PostgreSQL export runtime

This reviewed 3.3 MiB archive contains PostgreSQL 17.11 Linux x64 clients and
their OpenSSL/zlib libraries and licences. It contains **no credentials or
database content**. The source/build provenance and native CI proof are described
in `docs/postgres-native-runtime.md`; the installer independently pins the archive,
manifest, every file and the official Supabase public root certificate.

`scripts/build-production.mjs` installs these offline into ignored `.runtime/`
before compilation. There is no build-time download, compilation or database
connection. Next.js traces the generated files only into the two backup routes.
macOS builds may package the Linux files but never execute them; the production
runtime independently requires Linux x64 Node 24 and rechecks every file.

The certificate is the official public Supabase Root 2021 CA, downloaded from
`https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`.
Its presence alone is not a connection proof: the source connection also requires
`verify-full`, the pinned host and the separate native metadata compatibility test.
Both export and probe remain off unless explicitly enabled in production.
