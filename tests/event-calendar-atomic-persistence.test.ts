import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  applyEventCalendarMutation,
  EventCalendarConflictError,
  EventCalendarValidationError,
  getEventCalendarEventVersions,
  getEventCalendarSettingVersions,
  mutateEventCalendarStore,
} from "../lib/eventCalendarStore"

function source(path: string) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
}

function event(id: string, title: string, people: string[] = []) {
  return {
    id,
    startDate: "2026-08-11",
    endDate: "2026-08-11",
    title,
    people,
    uncertainPeople: [],
    tags: [],
    eventType: "Unclassified",
  }
}

function fakeCalendarSupabase(initialPayload: Record<string, unknown>) {
  let row = {
    payload: structuredClone(initialPayload),
    updated_at: "2026-08-11T00:00:00.000Z",
  }

  const client = {
    from() {
      let mode: "read" | "update" | "insert" = "read"
      let values: Record<string, unknown> = {}
      let expectedUpdatedAt = ""
      const query = {
        select() {
          return query
        },
        update(nextValues: Record<string, unknown>) {
          mode = "update"
          values = nextValues
          return query
        },
        insert(nextValues: Record<string, unknown>) {
          mode = "insert"
          values = nextValues
          return query
        },
        eq(field: string, value: unknown) {
          if (field === "updated_at") expectedUpdatedAt = String(value)
          return query
        },
        async maybeSingle() {
          await new Promise<void>((resolve) => setImmediate(resolve))
          if (mode === "read") return { data: structuredClone(row), error: null }
          if (mode === "insert") return { data: null, error: { code: "23505" } }
          if (expectedUpdatedAt !== row.updated_at) return { data: null, error: null }
          row = {
            payload: structuredClone(values.payload as Record<string, unknown>),
            updated_at: String(values.updated_at),
          }
          return { data: { payload: structuredClone(row.payload) }, error: null }
        },
      }
      return query
    },
  }

  return {
    client,
    payload: () => structuredClone(row.payload),
  }
}

test("legacy whole-calendar PUTs fail closed instead of reporting a discarded save", () => {
  const route = source("../app/api/office-calendar-store/[key]/route.ts")
  const putStart = route.indexOf("export async function PUT")
  const patchStart = route.indexOf("export async function PATCH", putStart)
  const put = route.slice(putStart, patchStart)

  assert.match(put, /if \(storeKey === "event-calendar"\)/)
  assert.match(put, /EVENT_CALENDAR_CLIENT_OUTDATED/)
  assert.match(put, /Nothing was saved/)
  assert.match(put, /status: 409/)
  assert.doesNotMatch(put, /operation: "settings"/)
})

test("the current client uses versioned create, update, and delete mutations", () => {
  const page = source("../app/admin/eventcalendar/page.tsx")

  assert.match(page, /protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION/)
  assert.match(page, /wasEdit \? "update" : "create"/)
  assert.match(page, /wasEdit \? \{ \[nextEvent\.id\]: draftEventVersion \} : \{\}/)
  assert.match(page, /await mutateCalendar\("delete", \[\], \[draftEvent\.id\],[\s\S]*draftEventVersion/)
  assert.match(page, /await mutateCalendar\("create", nextEvents\)/)
  assert.match(page, /id: `\$\{draftRecurrentEvent\.id\}-\$\{dateKey\}`/)
})

test("event title inputs preserve the caret while keeping saved titles uppercase", () => {
  const page = source("../app/admin/eventcalendar/page.tsx")

  assert.match(page, /title: event\.target\.value \}\)\)/)
  assert.doesNotMatch(page, /title: event\.target\.value\.toUpperCase\(\)/)
  assert.match(page, /title: draftEvent\.title\.trim\(\)\.toUpperCase\(\) \|\| "NEW EVENT"/)
  assert.match(page, /title: draftRecurrentEvent\.title\.trim\(\)\.toUpperCase\(\) \|\| "NEW EVENT"/)
  assert.match(page, /style=\{\{ \.\.\.inputStyle, textTransform: "uppercase" \}\}/)
})

test("two stale tabs editing different events preserve both changes and unrelated state", () => {
  const original = {
    events: [event("a", "OLD A"), event("b", "OLD B")],
    deletedEventIds: ["old-delete"],
    people: ["VL", "SC"],
    emailRecipientsText: "office@example.com",
  }
  const originalVersions = getEventCalendarEventVersions(original)

  const afterA = applyEventCalendarMutation(original, {
    operation: "update",
    events: [event("a", "NEW A")],
    expectedEventVersions: { a: originalVersions.a },
  })
  const afterB = applyEventCalendarMutation(afterA, {
    operation: "update",
    events: [event("b", "NEW B")],
    expectedEventVersions: { b: originalVersions.b },
  })
  const afterBRecord = afterB as typeof original

  assert.deepEqual(afterB.events, [event("a", "NEW A"), event("b", "NEW B")])
  assert.deepEqual(afterB.deletedEventIds, ["old-delete"])
  assert.deepEqual(afterBRecord.people, original.people)
  assert.equal(afterBRecord.emailRecipientsText, original.emailRecipientsText)
})

test("a second stale edit to the same event conflicts without replacing the winner", () => {
  const original = { events: [event("a", "ORIGINAL")], deletedEventIds: [] }
  const originalVersion = getEventCalendarEventVersions(original).a
  const winner = applyEventCalendarMutation(original, {
    operation: "update",
    events: [event("a", "FIRST SAVE")],
    expectedEventVersions: { a: originalVersion },
  })

  assert.throws(() => applyEventCalendarMutation(winner, {
    operation: "update",
    events: [event("a", "STALE SECOND SAVE")],
    expectedEventVersions: { a: originalVersion },
  }), EventCalendarConflictError)
  assert.deepEqual(winner.events, [event("a", "FIRST SAVE")])
})

test("edit/delete races never delete a newer edit or resurrect a deletion", () => {
  const original = { events: [event("a", "ORIGINAL")], deletedEventIds: [] }
  const originalVersion = getEventCalendarEventVersions(original).a
  const edited = applyEventCalendarMutation(original, {
    operation: "update",
    events: [event("a", "NEWER EDIT")],
    expectedEventVersions: { a: originalVersion },
  })

  assert.throws(() => applyEventCalendarMutation(edited, {
    operation: "delete",
    eventIds: ["a"],
    expectedEventVersions: { a: originalVersion },
  }), EventCalendarConflictError)
  assert.deepEqual(edited.events, [event("a", "NEWER EDIT")])

  const deleted = applyEventCalendarMutation(original, {
    operation: "delete",
    eventIds: ["a"],
    expectedEventVersions: { a: originalVersion },
  })
  assert.throws(() => applyEventCalendarMutation(deleted, {
    operation: "update",
    events: [event("a", "STALE RESURRECTION")],
    expectedEventVersions: { a: originalVersion },
  }), EventCalendarConflictError)
  assert.deepEqual(deleted.events, [])
  assert.deepEqual(deleted.deletedEventIds, ["a"])
})

test("distinct creates survive and create retries cannot overwrite an existing ID", () => {
  const original = { events: [event("seed", "KEEP")], deletedEventIds: [] }
  const afterA = applyEventCalendarMutation(original, {
    operation: "create",
    events: [event("a", "CREATE A")],
  })
  const afterB = applyEventCalendarMutation(afterA, {
    operation: "create",
    events: [event("b", "CREATE B")],
  })
  assert.deepEqual(afterB.events, [event("seed", "KEEP"), event("a", "CREATE A"), event("b", "CREATE B")])

  const idempotentRetry = applyEventCalendarMutation(afterB, {
    operation: "create",
    events: [event("a", "CREATE A")],
  })
  assert.deepEqual(idempotentRetry, afterB)
  assert.throws(() => applyEventCalendarMutation(afterB, {
    operation: "create",
    events: [event("a", "COLLISION")],
  }), EventCalendarConflictError)
})

test("twenty concurrent creators all survive the real CAS retry loop exactly once", async () => {
  const fake = fakeCalendarSupabase({ events: [event("seed", "KEEP")], deletedEventIds: [] })
  await Promise.all(Array.from({ length: 20 }, (_, index) => mutateEventCalendarStore(
    fake.client as never,
    { operation: "create", events: [event(`concurrent-${index}`, `EVENT ${index}`)] },
  )))

  const finalPayload = fake.payload()
  const finalEvents = finalPayload.events as Array<{ id: string }>
  assert.equal(finalEvents.length, 21)
  assert.equal(new Set(finalEvents.map((item) => item.id)).size, 21)
  assert.equal(finalEvents.filter((item) => item.id === "seed").length, 1)
})

test("twenty stale tabs editing twenty different events all preserve one another", async () => {
  const originalEvents = Array.from({ length: 20 }, (_, index) => event(`edit-${index}`, `OLD ${index}`))
  const originalPayload = { events: originalEvents, deletedEventIds: ["keep-tombstone"] }
  const originalVersions = getEventCalendarEventVersions(originalPayload)
  const fake = fakeCalendarSupabase(originalPayload)

  await Promise.all(originalEvents.map((originalEvent, index) => mutateEventCalendarStore(
    fake.client as never,
    {
      operation: "update",
      events: [event(originalEvent.id, `NEW ${index}`)],
      expectedEventVersions: { [originalEvent.id]: originalVersions[originalEvent.id] },
    },
  )))

  const finalPayload = fake.payload()
  const finalEvents = finalPayload.events as Array<{ id: string; title: string }>
  assert.equal(finalEvents.length, 20)
  assert.deepEqual(finalPayload.deletedEventIds, ["keep-tombstone"])
  for (let index = 0; index < 20; index += 1) {
    assert.equal(finalEvents.find((item) => item.id === `edit-${index}`)?.title, `NEW ${index}`)
  }
})

test("legacy upsert can add a new ID but cannot overwrite or resurrect an existing ID", () => {
  const original = { events: [event("a", "KEEP")], deletedEventIds: ["deleted"] }
  const added = applyEventCalendarMutation(original, {
    operation: "upsert",
    events: [event("b", "SAFE LEGACY ADD")],
  })
  assert.deepEqual(added.events, [event("a", "KEEP"), event("b", "SAFE LEGACY ADD")])
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "upsert",
    events: [event("a", "STALE OVERWRITE")],
  }), EventCalendarConflictError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "upsert",
    events: [event("deleted", "STALE RESURRECTION")],
  }), EventCalendarConflictError)
})

test("settings and People changes cannot rewrite event records or tombstones", () => {
  const original = {
    events: [event("a", "KEEP", ["VL", "SC"])],
    deletedEventIds: ["deleted"],
    people: ["VL", "SC"],
  }

  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "settings",
    settings: { events: [] },
  }), EventCalendarValidationError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "settings",
    settings: { deletedEventIds: [] },
  }), EventCalendarValidationError)

  const peopleChanged = applyEventCalendarMutation(original, {
    operation: "people",
    settings: { people: ["VL"] },
    expectedSettingVersions: { people: getEventCalendarSettingVersions(original).people },
  })
  const peopleChangedRecord = peopleChanged as typeof original
  assert.deepEqual(peopleChanged.events, original.events)
  assert.deepEqual(peopleChanged.deletedEventIds, original.deletedEventIds)
  assert.deepEqual(peopleChangedRecord.people, ["VL"])
})

test("AI-style additive imports can update People columns without rewriting existing events", () => {
  const original = {
    events: [event("a", "KEEP", ["SC"])],
    deletedEventIds: ["deleted"],
    people: ["SC"],
  }
  const imported = applyEventCalendarMutation(original, {
    operation: "insert",
    events: [event("b", "IMPORTED", ["VL"])],
    settings: { people: ["SC", "VL"] },
  }) as typeof original

  assert.deepEqual(imported.events, [original.events[0], event("b", "IMPORTED", ["VL"])])
  assert.deepEqual(imported.deletedEventIds, original.deletedEventIds)
  assert.deepEqual(imported.people, ["SC", "VL"])

  const duplicateOnly = applyEventCalendarMutation(imported, {
    operation: "insert",
    events: [],
    settings: { people: ["DT"] },
  }) as typeof original
  assert.deepEqual(duplicateOnly.events, imported.events)
  assert.deepEqual(duplicateOnly.people, ["SC", "VL", "DT"])
})

test("malformed events and duplicate IDs are rejected before any replacement", () => {
  const original = { events: [event("a", "KEEP")], deletedEventIds: [] }
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "update",
    events: [{ id: "a" }],
  }), EventCalendarValidationError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [event("b", "ONE"), event("b", "TWO")],
  }), EventCalendarValidationError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [{ ...event("b", "NUMERIC ID"), id: 123 }],
  }), EventCalendarValidationError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [{ ...event("b", "OBJECT ID"), id: { value: "b" } }],
  }), EventCalendarValidationError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [{ ...event("b", "BACKWARDS"), startDate: "2026-08-12", endDate: "2026-08-11" }],
  }), EventCalendarValidationError)
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [{ ...event("b", "UNKNOWN TYPE"), eventType: "Unknown" }],
  }), EventCalendarValidationError)
  assert.doesNotThrow(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [{ ...event("legacy-meeting", "LEGACY MEETING"), eventType: "Meeting" }],
  }))
  assert.deepEqual(original.events, [event("a", "KEEP")])
})

test("stale same-field settings conflict while independent settings preserve each other", () => {
  const original = {
    events: [event("a", "KEEP")],
    deletedEventIds: [],
    people: ["VL"],
    emailRecipientsText: "first@example.com",
  }
  const baseVersions = getEventCalendarSettingVersions(original)
  const peopleWinner = applyEventCalendarMutation(original, {
    operation: "people",
    settings: { people: ["VL", "SC"] },
    expectedSettingVersions: { people: baseVersions.people },
  })
  assert.throws(() => applyEventCalendarMutation(peopleWinner, {
    operation: "people",
    settings: { people: ["VL", "DT"] },
    expectedSettingVersions: { people: baseVersions.people },
  }), EventCalendarConflictError)

  const emailAfterPeople = applyEventCalendarMutation(peopleWinner, {
    operation: "settings",
    settings: { emailRecipientsText: "second@example.com" },
    expectedSettingVersions: { emailRecipientsText: baseVersions.emailRecipientsText },
  }) as typeof original
  assert.deepEqual(emailAfterPeople.people, ["VL", "SC"])
  assert.equal(emailAfterPeople.emailRecipientsText, "second@example.com")
})

test("tombstones cannot be recreated and repeated deletes are idempotent", () => {
  const original = { events: [event("a", "KEEP")], deletedEventIds: ["deleted"] }
  assert.throws(() => applyEventCalendarMutation(original, {
    operation: "create",
    events: [event("deleted", "DO NOT RESTORE")],
  }), EventCalendarConflictError)
  const imported = applyEventCalendarMutation(original, {
    operation: "insert",
    events: [event("deleted", "DO NOT RESTORE"), event("b", "ADD")],
  })
  assert.deepEqual(imported.events, [event("a", "KEEP"), event("b", "ADD")])

  const version = getEventCalendarEventVersions(original).a
  const once = applyEventCalendarMutation(original, {
    operation: "delete",
    eventIds: ["a"],
    expectedEventVersions: { a: version },
  })
  const twice = applyEventCalendarMutation(once, {
    operation: "delete",
    eventIds: ["a"],
  })
  assert.deepEqual(twice, once)
})

test("concurrent same-ID creates store exactly one winner and never merge records", async () => {
  const fake = fakeCalendarSupabase({ events: [], deletedEventIds: [] })
  const results = await Promise.allSettled([
    mutateEventCalendarStore(fake.client as never, { operation: "create", events: [event("same", "FIRST")] }),
    mutateEventCalendarStore(fake.client as never, { operation: "create", events: [event("same", "SECOND")] }),
  ])
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal(results.filter((result) => result.status === "rejected").length, 1)
  assert.equal((fake.payload().events as Array<{ id: string }>).filter((item) => item.id === "same").length, 1)
})

test("Google reconciliation and event email use committed server-side calendar state", () => {
  const eventCalendarPage = source("../app/admin/eventcalendar/page.tsx")
  const googleSync = source("../app/api/event-calendar/google-sync/route.ts")
  const emailNotify = source("../app/api/event-calendar/email-notify/route.ts")

  assert.match(googleSync, /loadCanonicalGoogleState\(eventId\)/)
  assert.match(googleSync, /claim_event_calendar_google_sync_jobs/)
  assert.match(googleSync, /queued for automatic retry/)
  assert.doesNotMatch(googleSync, /body\.events/)
  assert.doesNotMatch(googleSync, /body\.activeEventIds/)
  assert.doesNotMatch(googleSync, /body\.calendarId/)
  assert.match(emailNotify, /loadCanonicalEvent\(body\.event\.id\)/)
  assert.match(emailNotify, /latest\.payload\.emailRecipientsText/)
  assert.match(eventCalendarPage, /normalizeEmailList\(emailRecipientsText\)\.length/)
})

test("calendar commits enqueue Google sync atomically and snapshot audit undo is blocked", () => {
  const outbox = source("../supabase/migrations/20260811125141_event_calendar_google_sync_outbox.sql")
  const serializedOutbox = source("../supabase/migrations/20260811130444_serialize_event_calendar_google_sync_jobs.sql")
  const undoGuard = source("../supabase/migrations/20260811125142_block_event_calendar_snapshot_undo.sql")
  const googleSync = source("../app/api/event-calendar/google-sync/route.ts")
  const auditLog = source("../lib/auditLog.ts")

  assert.match(outbox, /after insert or update of payload on public\.office_calendar_store/)
  assert.match(outbox, /full join new_events using \(event_id\)/)
  assert.match(outbox, /for update skip locked/)
  assert.match(outbox, /on conflict \(event_id\) do update/)
  assert.match(serializedOutbox, /select distinct coalesce/)
  assert.match(serializedOutbox, /existing\.locked_until > clock_timestamp\(\)/)
  assert.match(serializedOutbox, /then existing\.locked_by/)
  assert.match(googleSync, /\.eq\("requested_at", job\.requested_at\)/)
  assert.match(googleSync, /\.eq\("locked_by", workerId\)/)
  assert.match(undoGuard, /app\.audit_undo_of_log_id/)
  assert.match(undoGuard, /target_key = 'event-calendar'/)
  assert.match(auditLog, /\["event-calendar", "spc-permission-groups"\]/)
})

test("the durable Google sync outbox is included in every daily-backup contract consumer", () => {
  for (const path of [
    "../app/api/backups/bunker-map-drive/route.ts",
    "../lib/systemHealth.ts",
    "../scripts/validate-backup.mjs",
  ]) {
    const contract = source(path)
    assert.match(
      contract,
      /key: "eventCalendarGoogleSyncJobs"[\s\S]*table: "event_calendar_google_sync_jobs"/,
    )
  }
  const fenceMigration = source("../supabase/migrations/20260813070422_fence_new_backup_tables.sql")
  assert.match(
    fenceMigration,
    /create trigger bunker_map_backup_epoch_fence[\s\S]*on public\.event_calendar_google_sync_jobs/,
  )
})

test("recovery and AI imports retain additive-only atomic mutations", () => {
  const recovery = source("../app/api/event-calendar/recover-missing/route.ts")
  const aiWorkbench = source("../app/api/admin/ai-workbench/route.ts")

  assert.match(recovery, /mutateEventCalendarStore\(supabase/)
  assert.match(aiWorkbench, /mutateEventCalendarStore\(supabase/)
  assert.doesNotMatch(recovery, /from\("office_calendar_store"\)\.upsert/)
})
