import assert from "node:assert/strict"
import test from "node:test"
import { isOutlookGroupVersion, isSavedOutlookGroup, normalizeOutlookGroupFields, readStableOutlookGroupSnapshot, validateOutlookGroupFields } from "../lib/outlookGroupValidation"

const group = { id: "synthetic-group", source_uid: "stable-source", name: "GROUP", source_book: "FC-GENERAL", nickname: null, description: null, member_count: 1, updated_at: "2026-10-14T10:00:00.123456+00:00" }
const member = { group_id: group.id, contact_id: "synthetic-contact", source_book: "FC-GENERAL" }

test("normalization emits editable fields only, preserves description line breaks and requires complete names", () => {
  assert.deepEqual(normalizeOutlookGroupFields({ ...group, name: " NEW   GROUP ", nickname: " ", description: " First line\nSecond line " }), { name: "NEW GROUP", source_book: "FC-GENERAL", nickname: null, description: "First line\nSecond line" })
  assert.equal(validateOutlookGroupFields({ ...group, name: " " }), "Group name is required.")
  assert.equal(validateOutlookGroupFields({ ...group, source_book: "" }), "Source book is required.")
  assert.equal(validateOutlookGroupFields({ nickname: null }, "update"), null)
  assert.equal(validateOutlookGroupFields({ nickname: 2 } as never, "update"), "Group details must be text.")
})

test("version validation preserves PostgreSQL microseconds and rejects impossible dates", () => {
  for (const version of [group.updated_at, "2026-10-14T10:00:00Z", "2024-02-29T23:59:59.999999+08:00"]) assert.equal(isOutlookGroupVersion(version), true)
  for (const version of ["2026-02-30T10:00:00Z", "2026-13-14T10:00:00Z", "2026-10-14T25:00:00Z", "2026-10-14T10:00:00.1234567Z", "2026-10-14", null, 5]) assert.equal(isOutlookGroupVersion(version), false)
  assert.equal(isSavedOutlookGroup(group, group.id), true)
  assert.equal(isSavedOutlookGroup(group, group.id, group.updated_at), false)
  assert.equal(isSavedOutlookGroup({ ...group, updated_at: "2026-10-14T10:00:00.123457+00:00" }, group.id, group.updated_at), true)
  for (const changed of [{ id: "other" }, { member_count: "1" }, { member_count: -1 }, { source_uid: null }, { updated_at: "bad" }]) assert.equal(isSavedOutlookGroup({ ...group, ...changed }, group.id), false)
})

test("consistent group/member snapshots are returned together after a version fence", async () => {
  let groupReads = 0
  const snapshot = await readStableOutlookGroupSnapshot(group.id, async () => { groupReads += 1; return group }, async () => [member])
  assert.equal(groupReads, 2)
  assert.deepEqual(snapshot, { group, members: [member] })
})

test("a concurrent membership change causes a bounded complete reread, not mixed versions", async () => {
  const newer = { ...group, member_count: 2, updated_at: "2026-10-14T10:00:00.123457+00:00" }
  const newMember = { ...member, contact_id: "second-contact" }
  let reads = 0, memberReads = 0
  const snapshot = await readStableOutlookGroupSnapshot(group.id, async () => ++reads === 1 ? group : newer, async () => ++memberReads === 1 ? [member] : [member, newMember])
  assert.equal(reads, 4)
  assert.equal(memberReads, 3)
  assert.deepEqual(snapshot, { group: newer, members: [member, newMember] })
})

test("legacy same-count member replacements are detected even without a parent-version change", async () => {
  const replacement = { ...member, contact_id: "replacement-contact" }
  let reads = 0
  const snapshot = await readStableOutlookGroupSnapshot(group.id, async () => group, async () => ++reads === 1 ? [member] : [replacement])
  assert.equal(reads, 4)
  assert.deepEqual(snapshot.members, [replacement])
})

test("repeated changes, malformed members and count mismatches cannot enable stale editing", async () => {
  let sequence = 0
  await assert.rejects(readStableOutlookGroupSnapshot(group.id, async () => ({ ...group, updated_at: `2026-10-14T10:00:00.${String(++sequence).padStart(6, "0")}Z` }), async () => [member]), /changed while reloading/)
  assert.equal(sequence, 4)
  for (const rows of [[{ ...member, group_id: "wrong" }], [member, member], [{ ...member, contact_id: null }], {}]) await assert.rejects(readStableOutlookGroupSnapshot(group.id, async () => group, async () => rows), /members could not be verified/)
  await assert.rejects(readStableOutlookGroupSnapshot(group.id, async () => ({ ...group, member_count: 2 }), async () => [member]), /changed while reloading/)
  await assert.rejects(readStableOutlookGroupSnapshot(group.id, async () => null, async () => [member]), /could not be reloaded/)
})
