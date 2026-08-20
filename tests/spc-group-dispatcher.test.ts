import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import {
  buildSpcEnquirySnapshot,
  buildSpcGroupAmendmentMessage,
  diffSpcEnquirySnapshots,
} from "@/lib/spcGroupDispatcher"
import {
  SPC_GROUP_DISPATCHER_FILES,
  updateSpcDispatcherDirectory,
  type SpcDispatcherDirectoryHandle,
} from "@/lib/spcGroupDispatcherPackage"

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

  const reofferMigration = await readFile(
    new URL("../supabase/migrations/20260820042838_reoffer_spc_enquiry_with_group_delivery.sql", import.meta.url),
    "utf8",
  )
  assert.match(reofferMigration, /create or replace function public\.reoffer_spc_enquiry_with_group_delivery/)
  assert.match(reofferMigration, /for update/)
  assert.match(reofferMigration, /if source_row\.status <> 'sent'/)
  assert.match(reofferMigration, /insert into public\.spc_group_delivery_jobs/)
  assert.match(reofferMigration, /revoke all on function public\.reoffer_spc_enquiry_with_group_delivery[\s\S]+to service_role/)

  const bootstrapSchema = await readFile(
    new URL("../supabase/spc_schema.sql", import.meta.url),
    "utf8",
  )
  for (const functionName of [
    "enqueue_spc_enquiry_group_delivery",
    "amend_spc_enquiry_with_group_delivery",
    "reoffer_spc_enquiry_with_group_delivery",
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
  assert.match(content, /currentChatNames\(\)\.some\(\(candidate\) => candidate\.toLowerCase\(\) === expected\)/)
  assert.match(content, /More than one exact WhatsApp group match was found/)
  assert.match(content, /SEND_UNCERTAIN: WhatsApp did not confirm a new outgoing message/)
  assert.match(content, /SEND_UNCERTAIN: WhatsApp did not stage the exact enquiry text/)
  assert.match(content, /\.message-out, \[data-testid='msg-container'\]/)
  assert.match(content, /function outgoingMessageSnapshot\(message\)/)
  assert.match(content, /function hasNewOutgoingMessage\(message, before\)/)
  assert.match(content, /replaceComposerText\(composer, message\)/)
  assert.match(content, /await runtimeMessage\(\{ type: "native-enter" \}\)/)
  assert.match(content, /await nativeClick\(sendButton\)/)
  assert.doesNotMatch(content, /type: "native-send-text"/)
  assert.match(content, /REDELIVERY/)
  assert.match(content, /data-role="activity-message"/)
  assert.match(content, /dispatcher-latest/)
  assert.doesNotMatch(content, /Checking for enquiries/)
  assert.match(content, /result: requiresReview \? "manual_review" : "failed"/)
  assert.doesNotMatch(content, /document\.visibilityState === "hidden"/)
  assert.match(content, /claim\.job\.attemptCount > 1 && outgoingMessageCount/)
  assert.doesNotMatch(content, /return textCandidates\(header\)\[0\]/)
  assert.match(content, /dispatcher-pair/)
  assert.doesNotMatch(content, /currentChatIsGroup/)
  assert.doesNotMatch(content, /data-action=["'](?:pair|pause)["']/)
  assert.doesNotMatch(content, /input\[name='groupName'\]/)

  const background = await readFile(
    new URL("../tools/whatsapp-spc-group-dispatcher/background.js", import.meta.url),
    "utf8",
  )
  assert.match(background, /chrome\.runtime\.onInstalled\.addListener\(reloadOpenWhatsAppTabs\)/)
  assert.match(background, /chrome\.tabs\.query\(\{ url: "https:\/\/web\.whatsapp\.com\/\*" \}/)
  assert.match(background, /chrome\.tabs\.reload\(tab\.id/)
  assert.ok(
    background.indexOf('message.type === "dispatcher-state"')
      < background.indexOf('if (!state.token) throw new Error("This dispatcher is not paired.")'),
    "unpaired state must be readable before automatic pairing",
  )
  assert.match(background, /message\?\.type === "extension-apply-update"/)
  assert.match(background, /chrome\.runtime\.reload\(\)/)
  assert.match(background, /fcunoSpcGroupDispatcherUpdatePendingV1/)
  assert.match(background, /async function nativeSendText/)
  assert.match(background, /return withDebugger\(tabId, async \(target\) =>/)
  assert.match(background, /async function findVisibleSendButton/)
  assert.match(background, /\[data-icon='send'\]/)
  assert.match(background, /\[data-icon='wds-ic-send-filled'\]/)
  assert.match(background, /async function focusVisibleComposer/)
  assert.match(background, /rect\.bottom > window\.innerHeight \* 0\.55/)
  assert.match(background, /await clickWithTarget\(target, sendButton\.x, sendButton\.y\)/)
  assert.match(background, /await enterWithTarget\(target\)/)
  assert.match(background, /message\?\.type === "native-send-text"/)
  assert.match(background, /message\.type === "dispatcher-latest"/)

  const updaterBridge = await readFile(
    new URL("../tools/whatsapp-spc-group-dispatcher/updater-bridge.js", import.meta.url),
    "utf8",
  )
  assert.match(updaterBridge, /fcuno-spc-dispatcher-updater/)
  assert.match(updaterBridge, /extension-apply-update/)
})

test("the folder updater validates the installed extension and writes the manifest last", async () => {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const stored = new Map<string, Uint8Array>([
    [
      "manifest.json",
      encoder.encode(JSON.stringify({ name: "FCUNO SPC Group Dispatcher", version: "1.1.6" })),
    ],
  ])
  const writes: string[] = []
  const directory: SpcDispatcherDirectoryHandle = {
    name: "fcuno-spc-group-dispatcher",
    async getFileHandle(name, options) {
      if (!stored.has(name) && !options?.create) throw new Error(`Missing ${name}`)
      return {
        async getFile() {
          return { text: async () => decoder.decode(stored.get(name) || new Uint8Array()) }
        },
        async createWritable() {
          return {
            async write(data) {
              stored.set(name, new Uint8Array(data))
              writes.push(name)
            },
            async close() {},
          }
        },
      }
    },
  }
  const manifest = JSON.stringify({ name: "FCUNO SPC Group Dispatcher", version: "1.2.5" })
  const bundle = {
    version: "1.2.5",
    files: SPC_GROUP_DISPATCHER_FILES.map((name) => ({
      name,
      contentBase64: Buffer.from(name === "manifest.json" ? manifest : `updated:${name}`).toString("base64"),
    })),
  }

  const result = await updateSpcDispatcherDirectory(directory, bundle)
  assert.deepEqual(result, {
    directoryName: "fcuno-spc-group-dispatcher",
    previousVersion: "1.1.6",
    version: "1.2.5",
  })
  assert.equal(writes.at(-1), "manifest.json")
  assert.equal(JSON.parse(decoder.decode(stored.get("manifest.json"))).version, "1.2.5")
})

test("the dispatcher download files are included in the production server trace", async () => {
  const nextConfig = await readFile(new URL("../next.config.js", import.meta.url), "utf8")
  const downloadRoute = await readFile(
    new URL("../app/api/spc/group-dispatcher/download/route.ts", import.meta.url),
    "utf8",
  )
  const filesRoute = await readFile(
    new URL("../app/api/spc/group-dispatcher/files/route.ts", import.meta.url),
    "utf8",
  )
  assert.match(
    nextConfig,
    /"\/api\/spc\/group-dispatcher\/download": \["\.\/tools\/whatsapp-spc-group-dispatcher\/\*\*\/\*"\]/,
  )
  assert.match(
    nextConfig,
    /"\/api\/spc\/group-dispatcher\/files": \["\.\/tools\/whatsapp-spc-group-dispatcher\/\*\*\/\*"\]/,
  )
  assert.match(downloadRoute, /const ARCHIVE_ROOT = "fcuno-spc-group-dispatcher"/)
  assert.match(downloadRoute, /\$\{ARCHIVE_ROOT\}-v\$\{SPC_GROUP_DISPATCHER_VERSION\}\.zip/)
  assert.match(downloadRoute, /"X-SPC-Dispatcher-Version": SPC_GROUP_DISPATCHER_VERSION/)
  assert.match(filesRoute, /contentBase64:/)
  assert.match(filesRoute, /SPC_GROUP_DISPATCHER_FILES\.map/)

  for (const file of [
    "manifest.json",
    "background.js",
    "content.js",
    "updater-bridge.js",
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
