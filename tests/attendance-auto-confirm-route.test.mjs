import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import test from "node:test"
import { build } from "esbuild"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const modules = {
  "@/lib/attendanceData": `
    export const getAttendanceServiceClient = () => globalThis.__attendanceCronFixture.service
    export const loadAttendancePeopleForPeriod = async () => globalThis.__attendanceCronFixture.people
    export const autoConfirmOverdueAttendance = async (_service, _now, _hook, scope, expectedCyId) =>
      globalThis.__attendanceCronFixture.confirm(scope, expectedCyId)
  `,
  "@/lib/attendanceSync": `
    export const requeryAttendanceMonthForAutoConfirmation = async (options) =>
      globalThis.__attendanceCronFixture.requery(options)
  `,
  "@/lib/attendanceMonthEnd": `
    export const previousMonthPeriod = () => globalThis.__attendanceCronFixture.period || ({ year: 2026, month: 10 })
  `,
  "next/server": `
    export class NextResponse {
      static json(body, options = {}) {
        return new Response(JSON.stringify(body), {
          status: options.status || 200, headers: options.headers || {},
        })
      }
    }
  `,
}
const built = await build({
  entryPoints: [join(root, "app/api/cron/attendance-auto-confirm/route.ts")],
  bundle: true, write: false, platform: "node", format: "cjs", logLevel: "silent",
  plugins: [{ name: "attendance-cron-fixture", setup(builder) {
    builder.onResolve({ filter: /^(?:@\/lib\/attendanceData|@\/lib\/attendanceSync|@\/lib\/attendanceMonthEnd|next\/server)$/ },
      ({ path }) => ({ path, namespace: "fixture" }))
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: modules[path], loader: "js" }))
    builder.onResolve({ filter: /^@\/lib\/(?:attendanceAutoConfirmPolicy|attendanceManualEntryPolicy)$/ }, ({ path }) => ({
      path: join(root, `lib/${path.split("/").at(-1)}.ts`),
    }))
  } }],
})
const loaded = { exports: {} }
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
)
const { GET } = loaded.exports
const cy = { id: "e2cd1a9d-95c1-4292-940a-884537f35cf3", staffCode: "CY", dingTalkUserId: null }
const jz = { id: "50988b84-4d6c-4089-9112-d6bfad1ed72d", adminUserId: "3cf2bff0-4eda-4c36-8827-a8f7be0c764d", staffCode: "JZ", dingTalkUserId: null }
const other = { id: "other-person", staffCode: "ZZ", dingTalkUserId: "ding-other" }
const manualEntryPeople = [
  { id: "4c5d73e6-63a9-4b05-93a7-7354b3e668ad", adminUserId: "84bb808c-e188-43ce-9ddf-e7e2fe2e997d", staffCode: "NN",
    dingTalkUserId: null, team: "BT", employmentStartDate: "2026-11-02" },
  { id: "96142f45-373f-47e2-9104-e33804f2fb1e", adminUserId: "7c2f5a90-09ae-4d3b-9996-d189f0154d53", staffCode: "TL",
    dingTalkUserId: null, team: "BT", employmentStartDate: "2026-11-02" },
]

async function invoke(fixture) {
  const oldSecret = process.env.CRON_SECRET
  const oldFixture = globalThis.__attendanceCronFixture
  const oldError = console.error
  process.env.CRON_SECRET = "synthetic-cron-secret"
  globalThis.__attendanceCronFixture = { service: {}, ...fixture }
  console.error = () => undefined
  try {
    const response = await GET(new Request("https://fixture.invalid/api/cron/attendance-auto-confirm", {
      headers: { authorization: "Bearer synthetic-cron-secret" },
    }))
    return { response, body: await response.json() }
  } finally {
    console.error = oldError
    if (oldSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = oldSecret
    if (oldFixture === undefined) delete globalThis.__attendanceCronFixture
    else globalThis.__attendanceCronFixture = oldFixture
  }
}

test("CY confirms despite another person's DingTalk requery failure", async () => {
  const requeries = []
  const confirmations = []
  const { response } = await invoke({
    people: [cy, other],
    async requery({ people }) {
      requeries.push(people.map((person) => person.id))
      if (people.some((person) => person.id === other.id)) throw new Error("synthetic DingTalk outage")
    },
    async confirm(scope, expectedCyId) {
      confirmations.push([scope, expectedCyId])
      return { skipped: false, year: 2026, month: 10, systemConfirmed: 1 }
    },
  })
  assert.equal(response.status, 500)
  assert.deepEqual(requeries, [[other.id], []])
  assert.deepEqual(confirmations, [["cyDingTalkException", null]])
})

test("CY and other staff use separate confirmation paths and totals", async () => {
  const confirmations = []
  const { response, body } = await invoke({
    people: [cy, other],
    async requery() {},
    async confirm(scope, expectedCyId) {
      confirmations.push([scope, expectedCyId])
      return { skipped: false, year: 2026, month: 10, systemConfirmed: 1 }
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(confirmations, [["cyDingTalkException", null], ["ordinary", undefined]])
  assert.equal(body.systemConfirmed, 2)
  assert.equal(body.cySystemConfirmed, 1)
  assert.equal(body.cyDingTalkRequery, "not-linked")
})

test("a failed requery of linked CY withholds his confirmation but processes ordinary staff", async () => {
  const requeries = []
  const confirmations = []
  const { response } = await invoke({
    people: [{ ...cy, dingTalkUserId: "ding-cy" }, other],
    async requery({ people }) {
      requeries.push(people.map((person) => person.id))
      if (people.some((person) => person.id === cy.id)) throw new Error("synthetic CY DingTalk failure")
    },
    async confirm(scope, expectedCyId) {
      confirmations.push([scope, expectedCyId])
      return { skipped: false, year: 2026, month: 10, systemConfirmed: 1 }
    },
  })
  assert.equal(response.status, 500)
  assert.deepEqual(requeries, [[other.id], [cy.id]])
  assert.deepEqual(confirmations, [["ordinary", undefined]])
})

test("a successful requery of linked CY can confirm him independently", async () => {
  const confirmations = []
  const { response, body } = await invoke({
    people: [{ ...cy, dingTalkUserId: "ding-cy" }, other],
    async requery() {},
    async confirm(scope, expectedCyId) {
      confirmations.push([scope, expectedCyId])
      return { skipped: false, year: 2026, month: 10, systemConfirmed: 1 }
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(confirmations, [["cyDingTalkException", "ding-cy"], ["ordinary", undefined]])
  assert.equal(body.cyDingTalkRequery, "fulfilled")
  assert.equal(body.systemConfirmed, 2)
})

test("a CY confirmation guard failure does not stop ordinary staff", async () => {
  const confirmations = []
  const { response } = await invoke({
    people: [cy, other],
    async requery() {},
    async confirm(scope) {
      confirmations.push(scope)
      if (scope === "cyDingTalkException") throw new Error("synthetic CY anomaly")
      return { skipped: false, year: 2026, month: 10, systemConfirmed: 1 }
    },
  })
  assert.equal(response.status, 500)
  assert.deepEqual(confirmations, ["cyDingTalkException", "ordinary"])
})

test("actual cron sends unlinked JZ through his independent exception path, preserving CY and ordinary totals", async () => {
  const requeries = [], confirmations = []
  const { response, body } = await invoke({
    people: [cy, jz, other],
    async requery({ people }) { requeries.push(people.map(person => person.id)) },
    async confirm(scope, expectedId) {
      confirmations.push([scope, expectedId]); return { skipped: false, year: 2026, month: 10, systemConfirmed: 1 }
    },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(requeries, [[other.id], []])
  assert.deepEqual(confirmations, [["cyDingTalkException", null], ["jzDingTalkException", null], ["ordinary", undefined]])
  assert.equal(body.systemConfirmed, 3); assert.equal(body.cySystemConfirmed, 1); assert.equal(body.jzSystemConfirmed, 1)
  assert.equal(body.jzDingTalkRequery, "not-linked")
})

test("actual cron still attempts JZ when ordinary and linked-CY requeries fail", async () => {
  const confirmations = []
  const { response } = await invoke({
    people: [{ ...cy, dingTalkUserId: "ding-cy" }, jz, other],
    async requery({ people }) { if (people.length) throw new Error("synthetic other-person outage") },
    async confirm(scope, expectedId) { confirmations.push([scope, expectedId]); return { systemConfirmed: 1 } },
  })
  assert.equal(response.status, 500)
  assert.deepEqual(confirmations, [["jzDingTalkException", null]])
})

test("actual cron withholds linked JZ after his failed requery without blocking CY or ordinary staff", async () => {
  const requeries = [], confirmations = []
  const { response } = await invoke({
    people: [cy, { ...jz, dingTalkUserId: "ding-jz" }, other],
    async requery({ people }) {
      requeries.push(people.map(person => person.id))
      if (people.some(person => person.id === jz.id)) throw new Error("synthetic JZ partial requery")
    },
    async confirm(scope) { confirmations.push(scope); return { systemConfirmed: 1 } },
  })
  assert.equal(response.status, 500)
  assert.deepEqual(requeries, [[other.id], [], [jz.id]])
  assert.deepEqual(confirmations, ["cyDingTalkException", "ordinary"])
})

test("actual cron passes JZ's freshly requeried identity to his checked confirmation scope", async () => {
  const confirmations = []
  const { response, body } = await invoke({
    people: [cy, { ...jz, dingTalkUserId: " ding-jz " }, other], async requery() {},
    async confirm(scope, expectedId) { confirmations.push([scope, expectedId]); return { systemConfirmed: 1 } },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(confirmations, [["cyDingTalkException", null], ["jzDingTalkException", "ding-jz"], ["ordinary", undefined]])
  assert.equal(body.jzDingTalkRequery, "fulfilled"); assert.equal(body.systemConfirmed, 3)
})

test("actual cron isolates JZ and CY confirmation guard failures from each other and ordinary staff", async () => {
  for (const failedScope of ["jzDingTalkException", "cyDingTalkException"]) {
    const confirmations = []
    const { response } = await invoke({
      people: [cy, jz, other], async requery() {},
      async confirm(scope) {
        confirmations.push(scope)
        if (scope === failedScope) throw new Error("synthetic guarded exception failure")
        return { systemConfirmed: 1 }
      },
    })
    assert.equal(response.status, 500)
    assert.deepEqual(confirmations, ["cyDingTalkException", "jzDingTalkException", "ordinary"])
  }
})

test("actual cron does not apply JZ's policy to a mismatched account tuple", async () => {
  const requeries = [], confirmations = []
  const { response, body } = await invoke({
    people: [cy, { ...jz, adminUserId: "another-admin", dingTalkUserId: "ding-other-jz" }],
    async requery({ people }) { requeries.push(people.map(person => person.id)) },
    async confirm(scope) { confirmations.push(scope); return { systemConfirmed: scope === "ordinary" ? 1 : 0 } },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(requeries, [[jz.id], []])
  assert.deepEqual(confirmations, ["cyDingTalkException", "ordinary"])
  assert.equal(body.jzSystemConfirmed, 0)
})

test("actual cron keeps manual-entry people out of automatic-confirmation requeries before and after linkage", async () => {
  for (const linked of [false, true]) {
    const requeries = [], confirmations = []
    const manual = manualEntryPeople.map(person => ({ ...person,
      dingTalkUserId: linked ? `later-${person.staffCode}` : null }))
    const { response, body } = await invoke({
      period: { year: 2026, month: 11 }, people: [...manual, other],
      async requery({ people }) {
        requeries.push(people.map(person => person.id))
        if (people.some(person => manual.some(entry => entry.id === person.id))) {
          throw new Error("manual-period DingTalk requery must not block ordinary staff")
        }
      },
      async confirm(scope) {
        confirmations.push(scope)
        return { systemConfirmed: scope === "ordinary" ? 1 : 0 }
      },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(requeries, [[other.id], []])
    assert.deepEqual(confirmations, ["cyDingTalkException", "ordinary"])
    assert.equal(body.systemConfirmed, 1)
  }
})

test("actual cron does not skip a requery for drifted manual identity, group, join date or earlier period", async () => {
  const manual = { ...manualEntryPeople[0], dingTalkUserId: "later-NN" }
  for (const { changed, period } of [
    { changed: { adminUserId: "another-account" }, period: { year: 2026, month: 11 } },
    { changed: { team: "AC" }, period: { year: 2026, month: 11 } },
    { changed: { employmentStartDate: "2026-11-03" }, period: { year: 2026, month: 11 } },
    { changed: {}, period: { year: 2026, month: 10 } },
  ]) {
    const requeries = []
    const { response } = await invoke({
      period, people: [{ ...manual, ...changed }, other],
      async requery({ people }) { requeries.push(people.map(person => person.id)) },
      async confirm() { return { systemConfirmed: 0 } },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(requeries, [[manual.id, other.id], []])
  }
})
