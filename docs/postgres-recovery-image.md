# Isolated recovery image compatibility proof

This is an offline **synthetic** compatibility check, not production backup execution or acceptance. It creates two owned PostgreSQL clusters, a 12,000-row fixture, an opaque Vault configuration row and a large object; dumps custom-format gzip; restores into the separate cluster; compares data, extension versions, RLS/policies, grants, schema objects and sequence state; then executes the restored trigger and checks role isolation. Both clusters must stop cleanly before success.

The server closure is the official Supabase PostgreSQL `17.6.1.084` Linux amd64 manifest `sha256:b75a42959151593e90d6ad7f0ef69abb329916caa397556976375da4c333412e`. The complete Nix closure is copied into pinned Node24 bookworm. The original Supabase entrypoint, managed schema initializers, default config includes, WAL-G scripts and source credentials are never invoked or provided. The proof requires the observed FCUNO extension versions and ICU collation version `153.121`; mismatch fails rather than silently changing the requirement.

Run on an authorized Linux Docker host using `bash scripts/postgres-recovery/run-synthetic-proof.sh`. The inner container is non-root, network-none, capability-free, read-only-rooted, and memory-capped at 2 GiB. Only owned synthetic scratch and nonsecret result directories are mounted. No Docker socket, cloud credentials or source database connection enter it. The wrapper creates no cloud services and publishes no image.

The production acceptance controller is separate. It must use reviewed source-archive identity, signature, bounded-input and verification logic, and must be tested on the existing cloud worker before actual acceptance can be claimed. This image proof does not establish that 2 GiB is enough for the real database or that the actual archive restores.

Vault ciphertext round-trip is deliberately not Vault plaintext recovery. The external source Vault encryption key is neither exported nor supplied. See the official [Supabase recovery/key warning](https://supabase.com/docs/guides/self-hosting/postgres-upgrade-17#pgsodium--supabase-vault-errors). A full backup policy must disclose that distinction.
