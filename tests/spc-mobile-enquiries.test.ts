import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { formatSpcMobileEnquiryText, verifyMetaWebhookSignature } from "../lib/spcMobileEnquiries"

test("mobile enquiry strips private metadata and uses one-line SPC format", () => {
  assert.equal(
    formatSpcMobileEnquiryText({
      title: "fallback",
      notes: "STAR OIL / 9748241\nSG 28 SEP / VLSFO 500MTS\n\n---SPC_META---\n{\"imo\":\"9748241\"}",
    }),
    "STAR OIL / 9748241 / SG 28 SEP / VLSFO 500MTS",
  )
})

test("Meta webhook signature is fail-closed", () => {
  const previous = process.env.WHATSAPP_APP_SECRET
  process.env.WHATSAPP_APP_SECRET = "test-webhook-secret"
  const body = JSON.stringify({ object: "whatsapp_business_account" })
  const signature = `sha256=${createHmac("sha256", "test-webhook-secret").update(body).digest("hex")}`
  assert.equal(verifyMetaWebhookSignature(body, signature), true)
  assert.equal(verifyMetaWebhookSignature(`${body}x`, signature), false)
  assert.equal(verifyMetaWebhookSignature(body, null), false)
  if (previous === undefined) delete process.env.WHATSAPP_APP_SECRET
  else process.env.WHATSAPP_APP_SECRET = previous
})

test("mobile delivery claims are atomic and uncertain sends stop for review", async () => {
  const source = await readFile(new URL("../lib/spcMobileEnquiries.ts", import.meta.url), "utf8")
  const migration = await readFile(
    new URL("../supabase/migrations/20260819102350_claim_spc_mobile_delivery_atomically.sql", import.meta.url),
    "utf8",
  )

  assert.match(source, /\.eq\("id", delivery\.id\)\.eq\("status", delivery\.status\)\.select\(DELIVERY_COLUMNS\)\.maybeSingle\(\)/)
  assert.match(source, /status: "processing"/)
  assert.match(source, /failureStatus\(error\)/)
  assert.match(source, /return error instanceof DeliveryUncertainError \? "manual_review" : "failed"/)
  assert.match(source, /trader_message_id: traderId, trader_delivery_status: "accepted"/)
  assert.match(source, /\.eq\("id", delivery\.id\)\.eq\("status", "processing"\)\.select\("id"\)\.maybeSingle\(\)/)
  assert.doesNotMatch(source, /await releaseDelivery\(delivery\)\s*\n\s*return true/)

  assert.match(migration, /'processing'/)
  assert.match(migration, /'manual_review'/)
  assert.match(migration, /processing_started_at/)
  assert.match(migration, /where status = 'processing'/)
})
