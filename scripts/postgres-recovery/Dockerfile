# Synthetic compatibility image only. No source connection, secrets or cloud SDK.
FROM --platform=linux/amd64 supabase/postgres@sha256:b75a42959151593e90d6ad7f0ef69abb329916caa397556976375da4c333412e AS postgres
FROM --platform=linux/amd64 node@sha256:2dd9a4f758e173b65fee15388f7706af6fb01ef50cf7a2c0538711d67a6981ae AS compatibility

# Retain the complete pinned Nix runtime closure, including its own ELF loaders,
# OpenSSL, ICU and extension libraries. Do not mix host PostgreSQL libraries.
COPY --from=postgres /nix /nix
COPY --from=postgres /usr/lib/postgresql /usr/lib/postgresql
COPY --from=postgres /usr/share/postgresql /usr/share/postgresql
COPY scripts/postgres-recovery/compatibility-proof.mjs /opt/fcuno/compatibility-proof.mjs
ENV PATH=/nix/var/nix/profiles/default/bin:/usr/local/bin:/usr/bin:/bin \
    LOCALE_ARCHIVE=/nix/var/nix/profiles/default/lib/locale/locale-archive \
    LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
WORKDIR /opt/fcuno
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/node", "/opt/fcuno/compatibility-proof.mjs"]

# Production recovery contains no source adapter, credential or cloud SDK.
FROM compatibility AS recovery
COPY config/fcunoConnections.ts /opt/fcuno/config/fcunoConnections.ts
COPY lib/postgresBackupReceipt.mjs lib/postgresBackupProtocol.mjs lib/postgresRecoveryCatalog.mjs lib/postgresRecoveryDiagnostics.mjs lib/postgresRecoveryColumns.mjs lib/storageMediaBackup.mjs /opt/fcuno/lib/
COPY scripts/postgres-recovery/offline.mjs /opt/fcuno/scripts/postgres-recovery/offline.mjs
ENTRYPOINT ["/usr/local/bin/node", "/opt/fcuno/scripts/postgres-recovery/offline.mjs", "--verify-cloud-input"]

# Secret-free synthetic source/test tooling exists only in this CI target.
FROM recovery AS native-controller-proof
COPY lib/postgresBackupCapability.mjs /opt/fcuno/lib/postgresBackupCapability.mjs
COPY scripts/lib/postgres-backup-native.mjs /opt/fcuno/scripts/lib/postgres-backup-native.mjs
COPY tests/postgres-backup-native.test.mjs /opt/fcuno/tests/postgres-backup-native.test.mjs
COPY supabase/migrations/20260723080340_backup_reliability_guards.sql /opt/fcuno/supabase/migrations/
COPY supabase/migrations/*_fixed_postgresql_export_admission.sql /opt/fcuno/supabase/migrations/
ENV NATIVE_PG_BIN=/nix/var/nix/profiles/default/bin FCUNO_CLOUD_CONTROLLER_PROOF=1 TMPDIR=/recovery
ENTRYPOINT ["/usr/local/bin/node", "--test", "/opt/fcuno/tests/postgres-backup-native.test.mjs"]
