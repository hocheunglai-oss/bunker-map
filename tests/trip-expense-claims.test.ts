import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import test from "node:test"
import { gunzipSync } from "node:zlib"
import { getAdminPageByPath, normaliseAdminPagePermissions } from "../lib/adminPages"
import {
  calculateExpenseHkd,
  MAX_RECEIPT_BYTES,
  parseTripReceipt,
  TRIP_EXPENSE_PAGE,
  validateTripExpense,
  type TripExpenseInput,
} from "../lib/tripExpenseClaim"
import { writeTripExpenseBackup } from "../lib/tripExpenseBackup"
import { deliverTripExpenseClaim } from "../lib/tripExpenseDelivery"
import { readTripExchangeRate } from "../lib/tripExpenseRate"
import type { TripClaimRow } from "../lib/tripExpenseStore"

const today = "2026-06-07"

function expense(overrides: Partial<TripExpenseInput["items"][number]> = {}): TripExpenseInput["items"][number] {
  return { id: randomUUID(), currency: "HKD", amount: "15.99", notes: "Train", category: "home", paidBy: "own", receipts: [], ...overrides }
}

function input(overrides: Partial<TripExpenseInput> = {}): TripExpenseInput {
  return {
    id: randomUUID(), travellers: "Test Traveller", country: "Vietnam", cities: "Hanoi",
    departureDate: "2026-06-01", returnDate: "2026-06-05", currency: "VND",
    rate: { source: "manual", value: "3,358", date: null },
    fundReceived: "100", fundReturned: "10",
    items: [
      expense(),
      expense({ currency: "VND", amount: "80,000", notes: "Coffee", category: "staffMeals", paidBy: "fund" }),
      expense({ amount: "13.02", notes: "Festival transfer", category: "overseas", paidBy: "office" }),
    ],
    ...overrides,
  }
}

test("Trip Expense Claim is an Office Tool with a staff default and explicit permission overrides", () => {
  const page = getAdminPageByPath(TRIP_EXPENSE_PAGE)
  assert.equal(page?.group, "office")
  const id = page!.id
  assert.equal(normaliseAdminPagePermissions({}, "view")[id], "edit")
  assert.equal(normaliseAdminPagePermissions({}, "none")[id], "none")
  assert.equal(normaliseAdminPagePermissions({ [id]: "view" }, "view")[id], "view")
  assert.equal(normaliseAdminPagePermissions({ [id]: "none" }, "view")[id], "none")
})

test("converts mixed-currency items, rounds each HKD line exactly, and excludes direct payments from the claim", () => {
  const filed = validateTripExpense(input(), today)
  assert.deepEqual(filed.items.map(item => item.hkdCents), [1599, 2382, 1302])
  assert.deepEqual(filed.totals, {
    claimCents: 3981, totalCents: 5283, fundUsedCents: 9000,
    paidBy: { own: 1599, fund: 2382, office: 1302 },
    categories: { home: 1599, staffMeals: 2382, overseas: 1302 },
  })
  assert.equal(calculateExpenseHkd({ currency: "VND", amount: "3.01" }, "VND", { source: "manual", value: "2", date: null }), 151)
  assert.equal(calculateExpenseHkd({ currency: "VND", amount: "80,000" }, "USD", filed.rate), null)
  assert.equal(calculateExpenseHkd({ currency: "HKD", amount: "3,58" }, "VND", filed.rate), null)
})

test("validates dates, advance balancing, currency changes, attachment types, sizes and unique associations", () => {
  assert.throws(() => validateTripExpense(input({ returnDate: "2026-02-30" }), today), /return dates/)
  assert.throws(() => validateTripExpense(input({ departureDate: "2026-06-06" }), today), /departure and return/)
  assert.throws(() => validateTripExpense(input({ fundReceived: "1", fundReturned: "1.01" }), today), /funds/)
  assert.throws(() => validateTripExpense(input({ rate: null }), today), /exchange rate/)
  assert.throws(() => validateTripExpense(input({ currency: "USD" }), today), /currency on expense 2/)
  assert.throws(() => validateTripExpense(input({ rate: { value: "0", source: "manual", date: null } }), today), /exchange rate/)
  assert.throws(() => parseTripReceipt({ id: randomUUID(), name: "receipt.html", size: 8 }), /PDF/)
  assert.throws(() => parseTripReceipt({ id: randomUUID(), name: "receipt.pdf", size: MAX_RECEIPT_BYTES + 1 }), /10 MB/)
  const receipt = { id: randomUUID(), name: "receipt.PDF", size: 8 }
  assert.throws(() => validateTripExpense(input({ items: [expense({ receipts: [receipt] }), expense({ receipts: [receipt] })] }), today), /only be attached/)
  const expenses = Array.from({ length: 6 }, () => expense({
    receipts: [{ id: randomUUID(), name: "receipt.pdf", size: MAX_RECEIPT_BYTES }],
  }))
  assert.throws(() => validateTripExpense(input({ items: expenses }), today), /50 MB/)
})

test("requests a dated HKD quote and rejects a different currency or a later observation", async () => {
  const rate = await readTripExchangeRate("VND", "2026-06-01", async url => {
    assert.equal(String(url), "https://api.frankfurter.dev/v2/rate/HKD/VND?date=2026-06-01")
    return Response.json({ date: "2026-05-29", base: "HKD", quote: "VND", rate: 3341.65 })
  })
  assert.deepEqual(rate, { value: "3341.65", date: "2026-05-29", source: "frankfurter" })
  await assert.rejects(readTripExchangeRate("VND", "2026-06-01", async () =>
    Response.json({ date: "2026-06-02", base: "HKD", quote: "VND", rate: 3341.65 })),
  /Enter it manually/)
})

test("backs up the filed claim and exact receipt bytes under a reserved Drive ID", async () => {
  const original = Buffer.from("%PDF-test receipt bytes")
  const receipt = { id: randomUUID(), name: "train.pdf", size: original.length }
  const item = expense({ receipts: [receipt] })
  const details = validateTripExpense(input({ items: [item] }), today)
  const claim: TripClaimRow = {
    id: details.id, details, submitted_by: randomUUID(), submitter_name: "Test Staff",
    submitted_at: "2026-06-07T10:00:00.000Z", claim_cents: details.totals.claimCents,
    backed_up_at: null, backup_file_id: "reserved-id", email_attempted_at: null, emailed_at: null, delivery_lease_until: null,
  }
  let stored = Buffer.alloc(0)
  let corruptReceipt = false
  let createCount = 0
  const drive = {
    files: {
      async create(options: { requestBody: { id: string }; media: { body: AsyncIterable<Buffer> } }) {
        assert.equal(options.requestBody.id, "reserved-id")
        if (createCount++ > 0) throw { response: { status: 409 } }
        const chunks = []
        for await (const chunk of options.media.body) chunks.push(chunk)
        stored = Buffer.concat(chunks)
      },
      async get() {
        return { data: {
          id: "reserved-id", name: "trip-expense-claim-" + details.id + ".json.gz", parents: ["verified-root"],
          mimeType: "application/gzip", trashed: false, size: String(stored.length),
          sha256Checksum: corruptReceipt ? "wrong" : createHash("sha256").update(stored).digest("hex"),
        } }
      },
    },
  }
  const bucket = { async download(path: string) {
    assert.equal(path, [claim.submitted_by, claim.id, item.id, receipt.id].join("/"))
    return { data: new Blob([original]), error: null }
  } }
  const context = { drive, rootId: "verified-root" } as unknown as Parameters<typeof writeTripExpenseBackup>[0]
  const storage = bucket as unknown as Parameters<typeof writeTripExpenseBackup>[3]
  await writeTripExpenseBackup(context, claim, "reserved-id", storage)
  const archived = JSON.parse(gunzipSync(stored).toString())
  assert.deepEqual(archived.claim, details)
  assert.equal(archived.receipts[0].itemId, item.id)
  assert.deepEqual(Buffer.from(archived.receipts[0].base64, "base64"), original)
  await writeTripExpenseBackup(context, claim, "reserved-id", storage)
  corruptReceipt = true
  await assert.rejects(writeTripExpenseBackup(context, claim, "reserved-id", storage), /verification failed/)
})

test("notifies Louisa once after backup and retries a pre-acceptance failure without making a second copy", async () => {
  const details = validateTripExpense(input(), today)
  const row = {
    id: details.id, details, submitted_by: randomUUID(), submitter_name: "Test Staff",
    submitted_at: "2026-06-07T10:00:00.000Z", claim_cents: details.totals.claimCents,
    backed_up_at: null, backup_file_id: null, email_attempted_at: null, emailed_at: null,
    delivery_token: null, delivery_lease_until: null, delivery_retry_at: "2026-06-07T10:00:00.000Z",
  }
  const db = {
    storage: { from: () => ({}) },
    from() {
      let values = {}
      const checks: (() => boolean)[] = []
      const query = {
        select: () => query,
        update(next: object) { values = next; return query },
        eq(key: keyof typeof row, value: string) { checks.push(() => row[key] === value); return query },
        is(key: keyof typeof row) { checks.push(() => row[key] === null); return query },
        lte(key: keyof typeof row, value: string) { checks.push(() => String(row[key]) <= value); return query },
        or() { checks.push(() => !row.delivery_lease_until); return query },
        async maybeSingle() { return { data: checks.every(check => check()) ? Object.assign(row, values) : null } },
      }
      return query
    },
  } as unknown as NonNullable<Parameters<typeof deliverTripExpenseClaim>[1]>
  type Services = NonNullable<Parameters<typeof deliverTripExpenseClaim>[2]>
  let backupWrites = 0
  let sends = 0
  const services: Services = {
    openBackup: async () => ({} as Awaited<ReturnType<Services["openBackup"]>>),
    reserveBackup: async () => "backup-reserved",
    writeBackup: async () => { backupWrites++ },
    emailConfig: () => ({ missing: [], from: "FCUNO", host: "", port: 587, user: "" }),
    async sendEmail(message) {
      assert.ok(row.backed_up_at && row.email_attempted_at)
      assert.deepEqual(message.to, ["louisa@cosulich.com.hk"])
      assert.ok(message.html.includes("https://fcuno.com/admin/tripexpenseclaim?claim=" + details.id))
      if (++sends === 1) throw { command: "CONN" }
      return { id: "fixture-smtp", accepted: message.to, rejected: [] }
    },
  }
  await assert.rejects(deliverTripExpenseClaim(row.id, db, services))
  assert.equal(row.email_attempted_at, null)
  assert.ok(row.delivery_retry_at > new Date().toISOString())
  assert.equal(await deliverTripExpenseClaim(row.id, db, services), false)
  row.delivery_retry_at = "2026-06-07T10:00:00.000Z"
  assert.deepEqual(await Promise.all([
    deliverTripExpenseClaim(row.id, db, services),
    deliverTripExpenseClaim(row.id, db, services),
  ]), [true, false])
  assert.equal(backupWrites, 1)
  assert.equal(sends, 2)
  assert.ok(row.emailed_at)
})
