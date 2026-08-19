import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  buildSpcEnquirySnapshot,
  buildSpcGroupAmendmentMessage,
  diffSpcEnquirySnapshots,
} from "@/lib/spcGroupDispatcher"

test("SPC amendment messages identify and bold only the current changed values", () => {
  const before = buildSpcEnquirySnapshot({
    title: "long pu 16 / 10 - 12 aug",
    vesselName: "long pu 16",
    deliveryDate: "2026-08-10",
    quantity: "lsmgo 200mts",
  })
  const after = buildSpcEnquirySnapshot({
    title: "long pu 16 / 10 - 18 aug",
    vesselName: "long pu 16",
    deliveryDate: "2026-08-18",
    quantity: "lsmgo 230mts",
  })
  const changes = diffSpcEnquirySnapshots(before, after)
  assert.deepEqual(changes.map((change) => change.field), ["title", "deliveryDate", "quantity"])

  const message = buildSpcGroupAmendmentMessage(
    "long pu 16 / 8357588 / 10 - 18 aug / lsmgo 230mts",
    2,
    changes,
  )
  assert.match(message, /^\*AMENDED - REV 2\*/)
  assert.match(message, /\*ETA:\* \*2026-08-18\* \(was 2026-08-10\)/)
  assert.match(message, /\*Quantity:\* \*lsmgo 230mts\* \(was lsmgo 200mts\)/)
})

test("SPC group delivery migration is idempotent, leased, and service-role only", async () => {
  const migration = await readFile(
    new URL("../supabase/migrations/20260817034459_spc_group_dispatcher.sql", import.meta.url),
    "utf8",
  )
  assert.match(migration, /unique \(enquiry_id, revision_number, event_type\)/)
  assert.match(migration, /for update skip locked/)
  assert.match(migration, /status in \('queued', 'claimed', 'sent', 'failed', 'manual_review', 'cancelled'\)/)
  assert.match(migration, /revoke all privileges on table public\.spc_group_delivery_jobs from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.claim_spc_group_delivery_job[\s\S]+to service_role/)

  const hardeningMigration = await readFile(
    new URL("../supabase/migrations/20260817034829_spc_group_dispatcher_claimed_by_index.sql", import.meta.url),
    "utf8",
  )
  assert.match(hardeningMigration, /spc_group_delivery_jobs_claimed_by_idx/)
  assert.match(hardeningMigration, /spc_group_delivery_jobs_no_public_access[\s\S]+using \(false\)[\s\S]+with check \(false\)/)

  const routingMigration = await readFile(
    new URL("../supabase/migrations/20260819025850_add_spc_delivery_routes.sql", import.meta.url),
    "utf8",
  )
  assert.match(routingMigration, /create table if not exists public\.spc_delivery_routes/)
  assert.match(routingMigration, /destination_group_name/)
  assert.match(routingMigration, /No active enquiry delivery route is assigned to this user/)
  assert.match(routingMigration, /nullif\(btrim\(jobs\.destination_group_name\), ''\) is not null/)
  assert.match(routingMigration, /save_spc_user_with_delivery_route/)
  assert.match(routingMigration, /revoke all privileges on table public\.spc_delivery_routes from public, anon, authenticated/)

  const bootstrapSchema = await readFile(
    new URL("../supabase/spc_schema.sql", import.meta.url),
    "utf8",
  )
  for (const functionName of [
    "enqueue_spc_enquiry_group_delivery",
    "amend_spc_enquiry_with_group_delivery",
    "claim_spc_group_delivery_job",
    "complete_spc_group_delivery_job",
  ]) {
    assert.match(bootstrapSchema, new RegExp(`create or replace function public\\.${functionName}`))
  }
})

test("the dedicated dispatcher exact-matches groups and stops uncertain sends", async () => {
  const content = await readFile(
    new URL("../tools/whatsapp-spc-group-dispatcher/content.js", import.meta.url),
    "utf8",
  )
  assert.match(content, /rowPrimaryName\(row\)\.toLowerCase\(\) === groupName\.toLowerCase\(\)/)
  assert.match(content, /More than one exact WhatsApp group match was found/)
  assert.match(content, /SEND_UNCERTAIN: WhatsApp did not confirm a new outgoing message/)
  assert.match(content, /result: requiresReview \? "manual_review" : "failed"/)
  assert.doesNotMatch(content, /document\.visibilityState === "hidden"/)
  assert.match(content, /claim\.job\.attemptCount > 1 && outgoingMessageCount/)
  assert.match(content, /state\.groupName = claim\.job\.groupName/)
  assert.match(content, /phoneMembers\.length >= 2 \|\| members\.length >= 3/)
  assert.doesNotMatch(content, /input\[name='groupName'\]/)

  const background = await readFile(
    new URL("../tools/whatsapp-spc-group-dispatcher/background.js", import.meta.url),
    "utf8",
  )
  assert.match(background, /chrome\.runtime\.onInstalled\.addListener\(reloadOpenWhatsAppTabs\)/)
  assert.match(background, /chrome\.tabs\.query\(\{ url: "https:\/\/web\.whatsapp\.com\/\*" \}/)
  assert.match(background, /chrome\.tabs\.reload\(tab\.id/)
})

test("the dispatcher download files are included in the production server trace", async () => {
  const nextConfig = await readFile(new URL("../next.config.js", import.meta.url), "utf8")
  assert.match(
    nextConfig,
    /"\/api\/spc\/group-dispatcher\/download": \["\.\/tools\/whatsapp-spc-group-dispatcher\/\*\*\/\*"\]/,
  )

  for (const file of [
    "manifest.json",
    "background.js",
    "content.js",
    "styles.css",
    "spc-sidebar-logo.png",
    "README.md",
  ]) {
    const content = await readFile(
      new URL(`../tools/whatsapp-spc-group-dispatcher/${file}`, import.meta.url),
    )
    assert.ok(content.length > 0, `${file} must be available to the download route`)
  }
})
