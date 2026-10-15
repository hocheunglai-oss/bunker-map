# Large-backup offline validation

## Confirmed failure and repair

The 14 October 2026 backup run logged a 2,535,715,355-byte artifact. The previous
offline validator read the complete JSON into a JavaScript string, exceeding
Node's 536,870,888-character string limit before validation could start. Large
section `JSON.stringify` calls were another full-string allocation. The old
recovery refusal helper also parsed the archive merely to refuse restoring it.

The validator now reads strict UTF-8 JSON incrementally, canonicalizes each row,
and stores row bytes, high-cardinality indexes, derived lists and sort keys in
private temporary files/SQLite. Audit rows and truth snapshots are not retained
as complete arrays. File SHA-256 covers the original file bytes; artifact and
section SHA-256 preserve the exporter's `JSON.stringify/v1` representation.

This is not a hash-only validator. Existing manifest, inventory, schema, section,
primary-key, reference, credential-redaction, attendance, receipt, truth-ledger,
snapshot, certification, projection and template-recipient checks remain in the
semantic path. The preceding repair's `port` parent checks for country/company
file and folder references remain present. Small-fixture comparisons execute
both the preceding validator and this validator against valid/corrupt archives.
The preceding validator is an exact committed test fixture from PR61 commit
`b3b6fe34d16107a269b981074bfe1ee0b2614119`, SHA-256
`3c9762e9f7661d2d8719f6491a8436e9c2c33d740ec9010679867acb113a2148`.
Its immutable provenance/bytes/hash are asserted independently of Git HEAD.
CI needs neither prior Git history nor a network fetch; only its pricing-schema
import is rewritten in the disposable executed copy. Port-parent valid/missing
cases are compared with that baseline too.
Duplicate JSON keys, invalid UTF-8, non-finite numbers and structurally ambiguous
input are explicitly refused rather than silently normalized.

Independent review found two further faults before release, now repaired:

- A retained lazy row from a closed archive could previously hash or decode as
  the same row position in a later archive. Rows, array views and serialized
  index references now retain their exact owner. Closed/foreign reads, hashes,
  indexes and sorts fail explicitly, including nested references.
- Local attendance/price-receipt error arrays could grow without limit before
  reaching the final report's cap. All diagnostic buffers now share a bounded
  sink. Exceeding 1,000 distinct messages or a 4,096-character message produces
  an explicit truncation failure and INVALID, never partial VALID.

The recovery helper continues to refuse both legacy and v2 archives before
creating a database client. It no longer reads any artifact bytes. No restore
write path was enabled by this repair.

## Verification on 15 October 2026

`FCUNO_BACKUP_SCALE_TEST=1 node --test tests/backup-validation-stream.test.mjs`
passed all 11 tests, with no skipped scale case (77.83 seconds in the final run):

- Exact 2,535,715,355-byte PII-free synthetic archive, 65,000 audit rows and 69
  truth snapshots: the actual complete CLI reported VALID, zero errors/warnings,
  and the expected file/artifact hashes under `--max-old-space-size=256`.
- The same archive with 5,000 nested audit payloads indexed separately succeeded
  under a 64MB heap; the index does not retain those objects in memory.
- 600,000 malformed attendance anomaly rows exited INVALID under a 64MB heap,
  without V8 heap exhaustion or retained temporary files. Excess warnings and
  local pricing-receipt errors also fail with explicit diagnostic truncation.
- Stale row/view/map/set references, nested references, and mismatched serialized
  owner identities reject access instead of returning another artifact's data.
- Strict parsing, malformed/truncated/duplicate input, size/depth/complexity
  guards, single-reader exclusion, hash equivalence, preceding-validator parity,
  file/folder port references, ordinary failures and SIGINT/SIGTERM cleanup pass.
- The actual recovery helper refuses the full-size archive under a 32MB heap.

The 14 existing attendance, pricing/schema-consumer and federation backup-contract
tests pass. The focused actual-SQL receipt-to-validator test also passes using
the existing isolated PGlite runtime via `PGLITE_MODULE_PATH`; the checkout does
not have that optional test package installed. Syntax and scoped lint pass; the
existing SQL recovery test file has two unused-destructure lint warnings. No
dependency was installed or added for this repair.

## Resource and confidentiality limits

The implementation uses Node 24's built-in `node:sqlite`; any runtime warning is
not suppressed. The parser bounds each JSON value to 32MiB, depth to 512, section
count to 256, root metadata to 32MiB, and pre-parse structure to 500,000 tokens,
250,000 object properties and 250,000 array elements. The retained row cache uses
an 8MiB weighted byte/node estimate, not only source byte length. Embedded truth
JSON is checked before its own parse as well.

The largest hosted rows measured on 14 October were approximately 3.28MB per
truth snapshot and 3.18MB per audit row. The largest snapshot had 74,093 JSON
values at depth four. Limits leave room above those observed rows. The 256MB
claim is for the tested current-size/current-shape synthetic archive, not a proof
that every possible adversarial 32MiB object shape fits that heap. Oversized or
over-complex rows are deliberately refused; future larger legitimate rows need
an explicit limit/resource review. SQLite and spool disk usage grows with archive
size, so the validation host needs sufficient private temporary disk space.

Temporary directories are mode 0700; row/SQLite files are mode 0600 and contain
sensitive plaintext. Normal completion, parser/semantic failure, uncaught process
failure, SIGINT and SIGTERM remove owned files. SIGKILL, OS crash or power loss
cannot guarantee cleanup; operators must inspect and remove only abandoned owned
`fcuno-backup-validation-*` directories securely after confirming no validator
is using them. No hosted backup contents were downloaded for these tests.

## Hosted recovery gaps remain separate

The 14 October read-only audit found eight completed Supabase physical restore
points (7–14 October), newest at 2026-10-14T02:04:53.687Z, with PITR disabled. A
completed point is not a demonstrated restore rehearsal. The logged logical
backup completed on 14 October after an earlier bounded evidence-query timeout;
later retries skipped normally. These are dated observations, not assertions
that a historical outage remains active on 15 October.

Direct Drive artifact verification was not completed: the connected Drive
profile was not the required `wider.custom@gmail.com` owner, existing local OAuth
returned `invalid_client`, and Vercel's Secret values were not exportable. Those
controls were not bypassed. Latest Drive manifest contents, current Drive/GCS
file coverage and a fresh schema-current artifact after release therefore remain
unproved by this audit. No unit or scale test substitutes for that evidence.

The same audit found 15 Supabase Storage objects totaling 224,309,367 bytes in
`spc-presentation-media`. Database JSON stores metadata and the existing Drive
content runner does not back up those Storage bytes. Six referenced assets
existed; the nine unreferenced objects were preserved. Complete byte coverage and
an isolated database + Storage + Drive-content restore rehearsal remain required
before claiming complete disaster-recovery verification.

Finally, the current alert policy suppresses every backup warning, including a
72-hour-old backup or no verified backup. Integrity errors are not suppressed.
This is a separately identified notification blind spot, not changed by the
offline-validator repair; it requires a targeted alert-policy decision.
