# Certified template refresh audit

The 28 October diagnosis placed the daily refresh timeout inside
`audit_table_changes()` during recipient certification. This does not prove
that audit writes caused the separate database restarts.

The previous triggers serialized both complete template rows, compared those
JSON objects, and stored both complete rows for every certificate refresh.
Unchanged HTML/text bodies were duplicated on each run. The fix is limited to
system `certified-projection-reconcile` updates where exact C-collation body
comparison and small JSON comparison prove every column except recipient
evidence, revision and update time stayed unchanged. Typed copies clear bodies
before JSON serialization; every other current/future column retains the old
JSON comparison semantics, including future types with no native equality
operator. The new run ID and fingerprint must match the recorded context.
A changed business field falls back to the original full-row path.

Each affected template still emits one audit record with complete before/after
recipient evidence, revision, identifiers, actor and request context. Only
unchanged `body_html` and `body_text` are omitted from those two snapshots. Their
UTF-8 SHA-256, byte lengths and explicit NULL status are retained under the
server-generated `auditRepresentation` marker. A caller-supplied marker cannot
classify an ordinary edit as compact. The marker is not a signature and does not
claim stronger tamper resistance than the existing audit permissions.

This representation is not an independently restorable full template snapshot.
The current template, full snapshots for actual body edits/deletion, and normal
backups retain the bodies. Generic undo is explicitly refused in both the
database and audit API for these derived-only records: restoring an obsolete
recipient certificate alone is not a valid business undo. Ordinary user edits,
insertions, deletions and their full-snapshot undo remain unchanged. Existing
audit history is not deleted, rewritten or compacted by this migration.

The migration preserves function OIDs, owner, security mode, configuration and
ACLs. It requires the exact reviewed installed function bodies and uses a
three-second lock timeout. No table rewrite, columns, grants, proof logic,
queue/schedule or production timeout changes are included. If preflight finds
source drift or cannot obtain the short lock, stop and review; do not bypass it.

## Verification

Run `NATIVE_PG_BIN=/absolute/owned/postgres17.6/bin node --test tests/outlook-certification-audit-native.test.mjs`. The mandatory release suite
runs all 15 cases in two socket-only, task-owned native clusters; no provider,
production credential or business record is used. Tests cover actual audit
HTTP presentation/undo, NULL/Unicode bodies, forged labels, future columns,
ordinary content undo, rollback, source drift and function identity/ACLs.

The first fixture uses 485 templates, 5,422,514 HTML bytes (maximum 783,673) and
5,062,489 text bytes. One local sample reduced actual refresh execution from
484.6 ms to 82.7 ms and the generated audit payload from 21.92 MB to 1.095 MB, retaining
all 485 records and the identical final template-state hash.

The full daily fixture uses 3,461 contacts, 359 groups, 1,155 members, 1,507 template
references, 75 snapshots (~193 MB) and 8,630 ledger rows. It runs both actual complete
byte/hash/ledger/group proofs, not substitutes. One local sample changed full
activation 1,670 ms→1,293 ms and audit payload 23.73 MB→2.90 MB. Both paths invoked the
SHA helper 34,685 times and both complete verifiers twice, produced identical
non-clock template state, and bound each clock timestamp to its own real
certification. Deliberate post-row historical corruption still rejects and
rolls back certification, audit and activation together.

These are synthetic hardware measurements, not a hosted timing or restart-cure
claim. Production must separately confirm a naturally/explicitly approved
full run. Existing raw history remains large; this fix prevents unnecessary
future duplication but does not reclaim historical disk space. The CI-only
suite watchdog expands 480→600 seconds for the added real native regression;
the production 20-second statement and 2-second lock limits are untouched.
