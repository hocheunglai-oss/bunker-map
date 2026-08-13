import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
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
