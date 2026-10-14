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
    export const previousMonthPeriod = () => ({ year: 2026, month: 10 })
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
    builder.onResolve({ filter: /^@\/lib\/attendanceAutoConfirmPolicy$/ }, () => ({
      path: join(root, "lib/attendanceAutoConfirmPolicy.ts"),
    }))
  } }],
})
const loaded = { exports: {} }
new Function("require", "module", "exports", built.outputFiles[0].text)(
  createRequire(import.meta.url), loaded, loaded.exports,
)
const { GET } = loaded.exports
const cy = { id: "e2cd1a9d-95c1-4292-940a-884537f35cf3", staffCode: "CY", dingTalkUserId: null }
const other = { id: "other-person", staffCode: "ZZ", dingTalkUserId: "ding-other" }

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
