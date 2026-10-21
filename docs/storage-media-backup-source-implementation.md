# Temporary FCUNO Storage backup source — staged implementation

This source-access stage is based on released commit
`b8d4eb020c19d168e5fb5f021473fd6a75a38f8c`, tree
`41555465c1123494cfe99123c297a0307baf48ed`. It does not configure providers,
deploy, run a backup, or change the existing Drive backup workflow/resources.

## Read-only protocol

The exact production source URL is derived from `config/fcunoConnections.ts`.
Every request requires a Google-signed ID token with the exact audience,
issuer, verified email, and existing Cloud Run job service account. Anonymous,
browser-origin/cookie, alternate-URL, wrong-project and preview requests deny.
The credential is obtained only from the existing job's metadata identity;
the runner has no Supabase credential or permanent service-account key.

The source remains off unless all runtime activation gates are present:

- `STORAGE_MEDIA_BACKUP_ENABLED=1`;
- exact Vercel production project runtime identifiers;
- canonical ISO `STORAGE_MEDIA_BACKUP_ACCESS_STARTS_AT` and
  `STORAGE_MEDIA_BACKUP_ACCESS_EXPIRES_AT`, spanning at most one hour;
- `STORAGE_MEDIA_BACKUP_APPROVED_INVENTORY_SHA256`, the exact identity snapshot
  approved for this copy, computed with exported `storageSourceInventorySha256`.

No activation values have been set. Snapshot identities contain the literal
bucket/path, genuine object ID/version, and size; sort/canonical hashing does
not normalise paths. The approved bucket, 15-object count and 224,309,367-byte
total are pinned in canonical configuration. Private object paths/versions
must not be committed to the public repository.

`POST {operation:"inventory"}` enumerates all flat cursor pages in the one
approved bucket and calls Storage info for genuine IDs/versions/sizes/ETags.
It checks the entire approved snapshot and returns exact identities with
five-minute HMAC receipts, bound to the activation window and snapshot. Only
those receipts permit `inspect` or `read`; they are not provider credentials
and still require Google identity authentication on each request.

`POST {operation:"inspect",source,receipt}` checks exact current identity and
returns its strong opaque ETag. `POST {operation:"read",source,receipt}` checks
identity, then streams the authenticated Storage GET server-side with exact
`If-Match`. It requires HTTP 200, matching strong ETag and full upstream size,
no transform/range/content encoding, and rechecks identity/ETag after upstream
EOF before ending the downstream stream. All source responses are private and
no-store. No source bearer URL or Supabase credential is returned.

The outgoing stream deliberately has no `Content-Length`: a client must see
HTTP stream EOF only after the post-read fence. Expected size is carried in
`X-Fcuno-Storage-Expected-Bytes`; identity is bound by a SHA-256 response header.
One upstream chunk is retained and emitted in at most 256 KiB pieces under
downstream backpressure, with no whole-body buffering or filesystem spool.
Request cancellation, response cancellation, fixed activation expiry, and a
240-second total read deadline abort the upstream operation. The route's
300-second Vercel limit leaves shutdown/headroom; longer files fail closed.

Storage keys are opaque and segment-encoded. Standalone dot segments cannot
be represented by WHATWG URL and fail closed; they are never normalised into
another object. Timestamps and ETags are never substituted for object version
or cryptographic byte hashes.

## Why no signed source URLs

The earlier signed-URL candidate is preserved separately as local evidence.
It is not the selected rollout design: Supabase documents that Smart CDN may
serve a cached signed URL after token expiry. Streaming avoids transferring
that cacheable bearer capability.

## Copy runner integration

The separate one-time entrypoint is
`node scripts/backup-storage-media-to-gcs.mjs --execute-approved-snapshot`.
It refuses local execution, another job/project/bucket, key-file fallback, and
missing explicit confirmation. It reads no local environment or token files.
The existing Drive Docker command, scheduler semantics and Drive-copy runner
are unchanged; the Dockerfile adds only the new runner's required source files.
No additional packages or lockfile changes are required.

The existing Drive OAuth credential is used only for fixed-origin GETs, after
the OAuth account matches canonical policy. The runner resolves the exact
existing backup-folder hierarchy, selects the two latest verified database
artifacts, and trusts their independently recorded raw SHA/length receipts.
It streams each artifact through the cleared R2 extractor and checks Drive
metadata/version before and after EOF. Only then is the authenticated database
checkpoint used; no checkpoint is invented from partial metadata.

The cleared provider-neutral helpers compute SHA-256 and CRC32C on source and
independent target readback. Native-fetch GCS JSON API adapters use existing
job metadata ADC tokens, exact decimal-string generations, create-only writes,
and generation-fenced control CAS. They expose no deletion API or unconditional
write retry. The existing target must have exact location, Uniform access,
versioning and enforced Public Access Prevention; the code cannot change those
settings. Failed immutable uploads remain for private inspection rather than
being deleted. A last-success pointer advances only after exact-generation
manifest readback, final approved-source and retained-pair checks, and lease
ownership/generation CAS. Expired source receipts are renewed only after the
whole exact snapshot is re-enumerated and compared.

Offline tests include the complete approved-size 224,309,367-byte synthetic
copy/readback under a 256 MiB heap cap, a >2 GiB receipt-gated extraction under
a 64 MiB heap cap without artifact/spool writes, and failure/cancellation,
provenance, rotation, stale-owner and CAS regressions. These are synthetic
checks, not evidence of a live backup.

## Inactive production delivery and activation limits

Code may be deployed while all four activation settings remain absent. After
delivery, verify the production deployment identity, then GET and POST the
canonical route anonymously and with a fake bearer token. Every request must
return 404 `not_found`, private/no-store headers, no provider redirect, source
identity, byte stream or credential, and no cookie. Preview and alternate-URL
requests must also deny. Do not enable the window merely to test disabled mode.

Actual GCP build/image execution and all four activation values remain a
separate, explicitly approved rollout. Before activation, recheck the exact
account/project/job resources, target bucket's enforced PAP/Uniform/versioning,
fresh complete source snapshot hash, and existing secret references. The live
hosted Storage list/info/stream contract must be checked fail-closed before any
success claim; an initial contract failure cannot publish a copy manifest.
No successful live copy, complete database restore, or historical legacy-byte
correspondence is established by these offline checks. Recovery mapping records
`historicalByteCorrespondence:"unproved"` and the exact pair observed at check
time, not a transactional claim that it remains latest forever. No automatic
recurring media backup or source-retention deletion is enabled by this change.

No live provider calls, environment pulls, IAM grants, deployments, uploads,
deletions, or permanent keys were used to prepare this implementation.

## Primary provider contracts

- [Supabase Storage schema](https://supabase.com/docs/guides/storage/schema/design)
- [Storage info implementation](https://github.com/supabase/storage/blob/v1.50.0/src/storage/renderer/info.ts)
- [Flat cursor listing](https://github.com/supabase/supabase-js/blob/v2.110.2/packages/core/storage-js/src/lib/types.ts)
- [Signed-URL caching limitation](https://supabase.com/docs/guides/storage/cdn/smart-cdn#signed-urls-and-cdn-caching)
- [Google metadata ID tokens](https://cloud.google.com/run/docs/authenticating/service-to-service#use_the_metadata_server)
- [Vercel streaming responses](https://vercel.com/docs/functions/streaming-functions)
