import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  formatSpcMobileEnquiryText,
  getSpcBackupModeExpiry,
  isSpcBackupModeActive,
  SPC_BACKUP_MODE_DURATION_MS,
  verifyMetaWebhookSignature,
} from "../lib/spcMobileEnquiries"

test("backup enquiry strips private metadata and uses one-line SPC format", () => {
  assert.equal(
    formatSpcMobileEnquiryText({
      title: "fallback",
      notes: "STAR OIL / 9748241\nSG 28 SEP / VLSFO 500MTS\n\n---SPC_META---\n{\"imo\":\"9748241\"}",
    }),
    "STAR OIL / 9748241 / SG 28 SEP / VLSFO 500MTS",
  )
})

test("Backup Mode expires exactly 24 hours after per-user activation", () => {
  const activatedAt = new Date("2026-08-25T01:15:00.000Z")
  const expiresAt = getSpcBackupModeExpiry(activatedAt)

  assert.equal(SPC_BACKUP_MODE_DURATION_MS, 24 * 60 * 60 * 1000)
  assert.equal(expiresAt, "2026-08-26T01:15:00.000Z")
  assert.equal(isSpcBackupModeActive(true, expiresAt, activatedAt.getTime()), true)
  assert.equal(isSpcBackupModeActive(true, expiresAt, Date.parse(expiresAt)), false)
  assert.equal(isSpcBackupModeActive(false, expiresAt, activatedAt.getTime()), false)
  assert.equal(isSpcBackupModeActive(true, null, activatedAt.getTime()), false)
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

test("backup delivery claims are atomic and uncertain sends stop for review", async () => {
  const source = await readFile(new URL("../lib/spcMobileEnquiries.ts", import.meta.url), "utf8")
  const migration = await readFile(
    new URL("../supabase/migrations/20260819102350_claim_spc_mobile_delivery_atomically.sql", import.meta.url),
    "utf8",
  )

  assert.match(source, /\.eq\("id", delivery\.id\)\.eq\("status", delivery\.status\)\.select\(DELIVERY_COLUMNS\)\.maybeSingle\(\)/)
  assert.match(source, /status: "processing"/)
  assert.match(source, /failureStatus\(error\)/)
  assert.match(source, /return error instanceof DeliveryUncertainError \? "manual_review" : "failed"/)
  assert.match(source, /\.eq\("enabled", true\)\.gt\("expires_at", now\.toISOString\(\)\)/)
  assert.match(source, /status: "expired"/)
  assert.match(source, /onConflict: "enquiry_id,spc_user_id", ignoreDuplicates: true/)
  assert.match(source, /trader_message_id: traderId, trader_delivery_status: "accepted"/)
  assert.match(source, /\.eq\("id", delivery\.id\)\.eq\("status", "processing"\)\.select\("id"\)\.maybeSingle\(\)/)
  assert.doesNotMatch(source, /await releaseDelivery\(delivery\)\s*\n\s*return true/)

  assert.match(migration, /'processing'/)
  assert.match(migration, /'manual_review'/)
  assert.match(migration, /processing_started_at/)
  assert.match(migration, /where status = 'processing'/)
})

test("Backup Mode is user-facing, admin-deactivatable, and independent from group dispatch", async () => {
  const control = await readFile(new URL("../components/SpcMobileModeControl.tsx", import.meta.url), "utf8")
  const route = await readFile(new URL("../app/api/spc/mobile-mode/route.ts", import.meta.url), "utf8")
  const userManagement = await readFile(new URL("../app/spc/usermanagement/page.tsx", import.meta.url), "utf8")
  const techStack = await readFile(new URL("../app/spc/techstack/page.tsx", import.meta.url), "utf8")
  const expiryMigration = await readFile(
    new URL("../supabase/migrations/20260825090506_spc_backup_mode_24_hour_expiry.sql", import.meta.url),
    "utf8",
  )

  assert.match(control, /<strong>BACKUP MODE<\/strong>/)
  assert.doesNotMatch(control, />MOBILE MODE</)
  assert.match(control, /disabled=\{saving \|\| mode\.enabled\}/)
  assert.match(route, /body\.userId/)
  assert.match(userManagement, /Deactivate Backup Mode/)
  assert.match(userManagement, /enabled: false, userId: userDraft\.id/)
  const source = await readFile(new URL("../lib/spcMobileEnquiries.ts", import.meta.url), "utf8")
  assert.match(source, /Backup Mode stays active for 24 hours\. Ask an administrator to deactivate it early\./)
  assert.match(techStack, /NORMAL GROUP DELIVERY CONTINUES/)
  assert.match(expiryMigration, /interval '24 hours'/)
  assert.match(expiryMigration, /Normal WhatsApp group delivery is independent and continues/)
})
