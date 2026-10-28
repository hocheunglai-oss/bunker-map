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
