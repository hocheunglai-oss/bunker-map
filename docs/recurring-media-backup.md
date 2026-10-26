# Recurring uploaded-file backup

This is independent file protection, not a PostgreSQL export. It does not close
the separate weekly native-database-copy dependency or claim that old database
records necessarily refer to today's file bytes.

## Separate from the one-time copy

The legacy `--execute-approved-snapshot` protocol keeps its exact 15-object,
224,309,367-byte approval, inventory hash and at-most-one-hour activation. Its
source receipts, copy manifest, retained-JSON-pair mapping, GCS paths and control
record are unchanged. A recurring gate does not enable that legacy mode.

Recurring execution requires `--execute-recurring-daily`, the production-only
`STORAGE_MEDIA_BACKUP_RECURRING_ENABLED=1` gate, a canonical activation timestamp,
the existing pinned Google Cloud Run job identity, a verified Drive publisher
and the optional-work budget guard. Missing controls fail closed.

## Source boundary

The existing FCUNO source route accepts only a Google-signed ID token for the
fixed route audience and pinned backup service-account email. It does not
accept browser cookies, user-provided URLs, SQL or alternative buckets. The
Supabase application credential remains inside FCUNO; it is never delegated
to Google Cloud or embedded in a signed download URL.

Recurring access is limited to 02:00–06:00 Asia/Hong_Kong. There is no permanent
outside-window bypass. Two complete bounded inventory walks must agree before
the source issues five-minute receipts. Each receipt binds one literal object
path, stable ID, version, size, exact inventory digest and daily access window.
Receipt renewal must find exactly the same inventory. Reads use strong ETag
preconditions, exact byte length, before/after source checks, strict HTTPS and
private/no-store responses. Cancellation and expiry stop the underlying read.

Operational caps are pinned in `config/fcunoConnections.ts`: at most 1,000
objects, 1 GiB total inventory and 256 MiB per object. JSON/stream/deadline limits
can reject an inventory before those numerical caps are reached; rejection is
not a successful backup. Exceeding a cap requires a reviewed policy change.

## Immutable daily evidence

New objects and versions are written create-only below
`fcuno-storage-media/daily/runs/<run-id>/objects/`. Unchanged source identities
may reuse previous exact GCS generations only after independently reading them
back and rechecking the current source identity. Equal names or counts alone
never establish coverage. Copies retain SHA-256, CRC32C, exact size, generation
and actual verification time. No source or backup deletion operation is exposed.

The complete `fcuno.storage-media-daily/v2` manifest records every current source
identity and its verified target generation, including unreferenced files and
an honestly empty inventory. The immutable manifest itself is uploaded and
independently read back. A generation-CAS lease under the separate daily control
path fences work and publication. A stale owner cannot replace a newer success.

Success is committed only after the Drive health envelope is independently read
back and its nested manifest bytes match. Failed or budget-paused attempt
receipts preserve the last good success. Only the current lease owner may
publish an attempt. A same-day scheduler retry checks the prior exact manifest
and inventory and does not copy again or manufacture a fresh success timestamp.

## Budget, retention and monitoring

The budget check runs before optional file-copy work. Unknown, stale or paused
budget evidence pauses optional work; safety metadata, existing copies and
essential Drive backups remain protected. A USD10 policy is not a guaranteed
all-service billing ceiling. No new paid service or billing account is implied.

Retention remains dry-run only. Every exact generation referenced by any
still-retained database checkpoint or media manifest must remain protected.
There is no automatic pruning or lifecycle deletion in this implementation.

The website reads the small authenticated Drive health envelope, not GCS
credentials. It compares exact current source identities, uses overnight
deadlines and grace periods, and distinguishes unknown protection from a
verified recovery. Detailed private paths and contact information are excluded
from human-facing alerts.

## Cloud-only operational setup

This section records the intended production wiring and release procedure; it
is **not** evidence of a completed execution. Obtain the canonical application
and cloud identities from `config/fcunoConnections.ts` and verify the signed-in
operator is `wider.custom@gmail.com` before cloud administration. The deployment
review must capture the actual API responses, rather than manufacture evidence
digests or treat a configuration flag as proof.

| Resource | Pinned target |
| --- | --- |
| Google Cloud project / number | `bunker-map-drive-uploader` / `210526897676` |
| Existing Cloud Run job / region | `bunker-map-drive-file-backup` / `us-central1` |
| Existing job service account | `bunker-map-drive-backup@bunker-map-drive-uploader.iam.gserviceaccount.com` |
| Private backup bucket | `bunker-map-drive-uploader-bunker-map-drive-file-backups` |
| Existing billing budget | `billingAccounts/018B3D-80BC56-D81278/budgets/75363d19-f390-48ea-b7a5-ee1b84c42554` |
| Budget notification topic | `projects/bunker-map-drive-uploader/topics/fcuno-backup-budget` |
| Job pull subscription | `projects/bunker-map-drive-uploader/subscriptions/fcuno-backup-budget-reader` |
| Schedule-only managed identity | `fcuno-media-backup-scheduler@bunker-map-drive-uploader.iam.gserviceaccount.com` |

### Budget source and least-privilege access

The reviewed existing budget is monthly, specified at **HKD77.50**, includes all
services and `INCLUDE_ALL_CREDITS`, and filters only
`projects/210526897676`. This measures the configured credit-inclusive project
cost, not gross charges or spending in other projects. The native amount is a
conservative implementation of the approved USD10 policy, not a fabricated
USD-valued observation. Pause optional work at actual costs of at least 90%
(HKD69.75) or a provider forecast threshold of at least 100%. Billing information
is delayed: neither this threshold nor the budget notification is an exact
all-service hard spending cap.

Attach this exact topic to the existing budget without replacing unrelated
notification preferences. Grant its automatic billing-publication capability
only to the official billing publisher, not an application user:
`serviceAccount:billing-budget-alert@system.gserviceaccount.com` (singular
`alert`). Audit the actual topic IAM and project/inherited permissions before
pinning the reviewed trusted operators. Give the existing job account consume
access on only the named pull subscription. Keep it pull-only, attached to the
exact topic, without a message filter, push endpoint or dead-letter diversion.
Use **24-hour message retention**. Bounded polling and generation-CAS protect
against out-of-order delivery; retention also limits stale backlog. Polling
continues across up to three consecutive empty replies, with a maximum of 100
batches. Empty replies do not prove that the queue is empty. Optional copying
requires a fresh, matching provider publication actually delivered and durably
handled during that check; cached low-cost evidence plus empty replies cannot
authorize it. Billing remains a delayed, best-effort signal, not proof of the
current total cost. Never acknowledge an unverified publication just to clear
a queue.

The additional project custom role `fcunoBackupGuardMetadataReader` contains
only these read permissions:

- `storage.buckets.getIamPolicy`
- `pubsub.topics.getIamPolicy`
- `pubsub.subscriptions.get`

Use the exact role
`projects/bunker-map-drive-uploader/roles/fcunoBackupGuardMetadataReader`
with these separate scopes:

- Keep its project-level binding restricted **only** to
  `resource.name == "projects/_/buckets/bunker-map-drive-uploader-bunker-map-drive-file-backups"`.
- Bind that same role directly on the exact topic and directly on the exact
  subscription above. Both resource-local bindings must be unconditional
  (no `condition` field), with the existing job service account as their sole
  member:
  `serviceAccount:bunker-map-drive-backup@bunker-map-drive-uploader.iam.gserviceaccount.com`.
  Preserve the subscription's separate consume-only grant.

Do not put Pub/Sub names into the project condition or substitute a project
number to make it match. Google's [supported condition attributes](https://docs.cloud.google.com/iam/docs/conditions-attribute-reference)
list resource-name support for Pub/Sub **Lite**, not standard Pub/Sub; an
unavailable attribute cannot grant access. Google supports
[project custom roles on resources in that project](https://docs.cloud.google.com/iam/docs/roles-overview#custom_roles)
and [resource-local Pub/Sub IAM bindings](https://docs.cloud.google.com/pubsub/docs/access-control).
The [Pub/Sub permission reference](https://docs.cloud.google.com/iam/docs/roles-permissions/pubsub)
also shows why Viewer alone is insufficient: Pub/Sub Viewer includes
`pubsub.subscriptions.get`, but not `pubsub.topics.getIamPolicy`; Subscriber
does not supply either metadata read. Do not replace this narrow role with
Owner, Editor, Billing Administrator or new credentials.

Read back the actual custom-role definition, record its etag and SHA-256 in
private deployment evidence, and require exactly the three read permissions
listed above. Audit both direct bindings and the Storage-only condition.
Then prove the exact reads succeed and unrelated resource reads are refused
from the running job's data identity, not merely the administrator's session.
The runtime's topic-policy check accepts this custom role only by that exact
role path, absent condition and sole pinned job-account member; it never
accepts this exception on the bucket. Runtime checks the subscription's
identity and configuration, not its complete IAM policy or the custom-role
definition. Definition review remains a deployment responsibility. Existing
highly trusted role administrators can change a custom role's permissions;
that trusted-administrator boundary is not eliminated by the runtime's name
and member checks. Do not describe the role name itself as permission proof.

The job additionally reuses its already-approved bucket object access and
existing Drive OAuth credential. Google metadata ADC must identify the pinned
service account; local gcloud credentials, service-account key files and Mac
credentials are never fallback paths.

The runtime checks the private, uniform-access bucket and project number, the
resource-local writer/publisher principal sets, and the subscription/topic
relationship. The deployment review separately checks project and ancestor
IAM and the actual billing filter; runtime does not pretend these are
authenticated merely by a payload's `source` string. This boundary trusts the
existing job and reviewed project administrators; it does not protect against
their compromise. An unrelated read-only IAM addition does not invalidate a
whole-policy fingerprint and create a needless pause. A new writer or unknown
resource-local role does require review and pauses optional work.

### Non-secret runtime configuration

Set these only on the intended production deployment and existing cloud job,
with the same canonical UTC activation timestamp:

- `STORAGE_MEDIA_BACKUP_RECURRING_ENABLED=1`
- `STORAGE_MEDIA_BACKUP_RECURRING_ACTIVATED_AT=<actual activation ISO timestamp>`

The cloud job also needs `STORAGE_MEDIA_BACKUP_BUDGET_CONFIG_JSON`, conforming
exactly to `readStorageMediaBudgetRuntimeConfig` in
`scripts/lib/storage-media-budget-runtime.mjs`:

- Schema `fcuno.media-budget-runtime/v1`; the project number and complete budget,
  topic and subscription names above.
- `currency=HKD`, `budgetAmountMicros=77500000`, and
  `budgetProvenance=approved-conservative-native-budget`.
- `billingTimeZone` verified against an authentic provider publication's
  `costIntervalStart`, not guessed from this Mac, the job region or HKT.
- `trustedWriterMembers` containing the pinned job service account and only
  actually reviewed writer/operator principals. Existing legacy aliases may be
  listed only as `projectOwner:bunker-map-drive-uploader` and
  `projectEditor:bunker-map-drive-uploader`, after auditing their actual members.
- `trustedPublisherMembers` containing the official billing publisher and any
  actually reviewed resource-local administrator principals.
- `deploymentEvidence` containing a canonical `reviewedAt` and actual retained
  `budgetSha256`, `projectIamSha256`, `ancestorIamSha256` and
  `subscriptionSha256` digests. Document the absence of a project parent when
  hashing the ancestor review; an empty-looking field is not evidence.

**Dated billing-calendar verification — 2026-10-26:** the first authentic
matching budget publication, published at `2026-10-26T10:54:15.528Z`, reported
`costIntervalStart=2026-10-01T07:00:00Z`. The actual billing-message parser and
budget policy accepted this exact October boundary for
`America/Los_Angeles`, with the pinned billing account, budget, currency and
amount. This verifies that publication and October's boundary, **not permanent
daylight-saving correctness or every future billing period**. Each future
period must still match the configured local month boundary exactly, including
seasonal offsets. A mismatch stays paused and needs review; do not accept the
current UTC month or change the zone merely to make a test green. This dated
validation is not a job's durably committed budget control, real-time cost
evidence, an exact spending cap or proof of an overnight file backup.
The maximum observation age is 36 hours. Missing, malformed, stale, wrong-month
or unauthenticated evidence pauses optional copying, never deletes old copies
or disables the separate essential Drive backup. A same-day retry whose exact
inventory and previous immutable manifest are already verified does no new
copying and does not require another budget delivery. It returns the existing
success without publishing a budget warning or a fresh success timestamp.

Re-use `GOOGLE_DRIVE_BACKUP_FOLDER_ID` (or the existing company-folder fallback)
and any existing shared-drive setting. Preserve all existing secret references;
do not place their values in configuration examples, build arguments, source
control or logs. The native factory creates both the budget guard and verified
Drive health publisher; production must not depend on test-injected adapters.

### Bucket retention and deployment order

Before activation, remove the existing automatic lifecycle **Delete** rules
that could expire referenced noncurrent generations. This is a metadata-only
safeguard, not an instruction to delete objects. Preserve versioning, enforced
public-access prevention, uniform bucket-level access and the existing
seven-day soft-delete protection. Read back the result. Never restore an old
Delete lifecycle rule as part of a routine rollback: an older version may still
be needed by a retained checkpoint.

Build the allowlisted image using `cloudbuild.drive-backup.yaml` and
`Dockerfile.drive-backup`, retaining its immutable image digest. Check the full
container import closure, focused tests, legacy streaming regression and
production dependency audit before updating the existing job. Keep its default
Drive backup command and existing scheduler unchanged.

Create **separate overnight media invocations** with four explicit attempt
slots, using the existing job and a per-execution argument override for:

```sh
node scripts/backup-storage-media-to-gcs.mjs --execute-recurring-daily
```

Inspect the actual container entrypoint/command before constructing the Cloud
Run override body: do not prepend a second `node` argument to an existing
`node` command. Use the dedicated scheduler identity above for the tested
job-execution/override capability on this exact job, not project Editor. It
has no **direct** bucket, Drive or secret IAM grants. Nevertheless, overriding
arguments or environment on this existing secret-bearing job is **trusted
privileged execution** and can exercise the job's effective data-access
capabilities. It must not be described as unable to access data. The running
backup continues to use its separate, already-pinned data-access identity.
Create no user-managed keys and grant no new impersonation authority to other
principals beyond the reviewed scheduler-service path.
Record the actual scheduler name, target, service account, override body,
timezone, retry policy and image digest in private release evidence. Configure
`15 2-5 * * *` in `Asia/Hong_Kong`: 02:15, 03:15, 04:15 and 05:15. Set the
execution timeout override to **2,700 seconds (45 minutes) on every media
attempt**, so the planned 05:15 slot ends by 06:00 when started on time. The
source independently refuses outside-window access even if dispatch is late.
Preserve the existing Drive job's **3,300-second default** and its original
scheduler; only the separate media invocations receive the shorter override.
Verify the deployed schedule, all four timeout overrides and bounded dispatch
retries rather than assume this intended configuration was applied. An exact
same-day verified success skips later media attempts without new copies or
fresh success claims. No Mac, local cron or local export runner is involved.

Enable only after the project, IAM, bucket retention, budget-message identity,
calendar and job configuration checks pass. If an authentic first billing
message is not yet available, keep optional work paused and the activation
incomplete. Do not substitute a hand-written zero-cost control document.

### First-run and rollback evidence

The first natural overnight verification must retain:

1. The actual cloud execution and immutable image/revision identity, not merely
   a successful Scheduler dispatch.
2. An authentic budget publication and matching normalized, generation-pinned
   GCS observation. Re-read the stored generation before acknowledging it.
3. Complete before/after source inventory identity, exact copied/reused object
   generations and independent byte/hash readback, plus the verified manifest.
4. The independently re-read Drive health receipt and fenced latest-success
   control, including the real run time; equal object counts alone are not proof.
5. System Health's interpretation of that same receipt, including truthful
   budget-paused/failed states and preservation of the previous good backup.
6. A retention dry-run showing protected dependencies and blockers, with
   deletion still disabled. Four verified native-database weeks cannot be
   claimed while weekly PostgreSQL export remains separately blocked.

Keep evidence private and redact secrets and unnecessary source paths from
human-facing output. The job's console output is limited to status, counts and
project identity. Verify next-day unchanged-object reuse and a genuine changed
file/version before describing recurring version protection as fully proven.

For rollback, pause only the new media schedule and disable its recurring
gates, preserving the essential Drive schedule, existing copies, source
application credential and last good health evidence. Restore a previously
verified image if needed, then verify ordinary Drive protection remains intact.
Never disable TLS verification, bypass the source window, create an admin
database key or restore production data as a workaround. This rollout does
**not** enable the pending weekly full PostgreSQL backup connection.

## Activation evidence

Synthetic tests cover the daily window, token and snapshot boundaries, complete
copy/readback, exact-generation reuse, concurrent CAS conflicts, budget pause,
source changes, corrupt bytes and failed publication. Legacy regression tests
include the full 224 MB streaming fixture.

A deployed route and passing synthetic tests do **not** prove that a live daily
backup ran. The first natural overnight run still needs authenticated cloud
execution, exact-generation readback, Drive receipt and System Health checks.
Record that evidence separately; do not mark recurring protection complete
before it exists. Production activation and cloud scheduling are operational
release steps, not import-time actions of these modules.
