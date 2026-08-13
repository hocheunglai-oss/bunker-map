import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const routeFiles = {
  templates: new URL("../app/api/email-templates/route.ts", import.meta.url),
  recipients: new URL(
    "../app/api/outlook-addin/recipient-map/route.ts",
    import.meta.url,
  ),
  recipientResolver: new URL(
    "../lib/outlookTemplateRecipientResolver.ts",
    import.meta.url,
  ),
  taskpane: new URL(
    "../app/api/outlook-addin/taskpane/route.ts",
    import.meta.url,
  ),
}

const adminTemplatePageFile = new URL(
  "../app/admin/emailtemplates/page.tsx",
  import.meta.url,
)

async function sources() {
  const [templates, recipients, recipientResolver, taskpane] = await Promise.all(
    Object.values(routeFiles).map((url) => readFile(url, "utf8")),
  )
  return { templates, recipients, recipientResolver, taskpane }
}

function renderedInlineTaskpaneScript(taskpane: string) {
  const htmlTemplate = taskpane.match(
    /const html = `([\s\S]*?)`\n\n  return new NextResponse\(html,/,
  )
  assert.ok(htmlTemplate, "taskpane HTML template should be extractable")

  const templateBody = htmlTemplate[1].replace(
    /\$\{JSON\.stringify\([^)]+\)\}/g,
    '"https://fcuno.test/api"',
  )
  const html = Function(`return \`${templateBody}\`;`)() as string
  const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  assert.ok(inlineScript, "inline taskpane script should be extractable")
  return inlineScript[1]
}

function inlineFunctionSource(script: string, name: string) {
  const match = script.match(
    new RegExp(`function ${name}\\([\\s\\S]*?\\) \\{[\\s\\S]*?\\n        \\}`),
  )
  assert.ok(match, `${name} should be extractable from the taskpane`)
  return match[0]
}

function inlineFunctionBlock(
  script: string,
  startMarker: string,
  endMarker: string,
) {
  const start = script.indexOf(startMarker)
  const end = script.indexOf(endMarker, start)
  assert.ok(start >= 0 && end > start, `${startMarker} should be extractable`)
  return script.slice(start, end)
}

test("all Outlook reads are confidential and permission-gated", async () => {
  const source = await sources()

  for (const [name, value] of Object.entries(source).filter(
    ([name]) => name !== "recipientResolver",
  )) {
    assert.match(
      value,
      /requireOutlookAddinPagePermissionForRequest\([\s\S]*?request,[\s\S]*?"email-templates",[\s\S]*?"view"/,
      `${name} must require Outlook Templates view permission`,
    )
    assert.doesNotMatch(
      value,
      /Access-Control-Allow-Origin/,
      `${name} must not expose template or address-book data with wildcard CORS`,
    )
    assert.match(value, /private, no-store, max-age=0/)
  }

  assert.ok(
    source.templates.indexOf(
      "await requireOutlookAddinPagePermissionForRequest(",
    ) < source.templates.indexOf("loadEmailTemplate(id)"),
    "permission must be checked before any template detail read",
  )
  assert.ok(
    source.templates.indexOf(
      "await requireOutlookAddinPagePermissionForRequest(",
    ) < source.templates.indexOf("loadTemplateIndex()"),
    "permission must be checked before any template index read",
  )
  assert.match(source.templates, /code: "TEMPLATE_READ_FAILED"/)
  assert.match(source.recipients, /code: "RECIPIENT_MAP_FAILED"/)
  assert.doesNotMatch(source.templates, /message:\s*(?:String\()?error/)
  assert.doesNotMatch(source.recipients, /message:\s*(?:String\()?error/)
})

test("recipient map is built only from the latest settled certified projection", async () => {
  const { recipients, recipientResolver } = await sources()

  for (const flag of [
    "valid",
    "integrityValid",
    "ledgerValid",
    "snapshotsValid",
    "referencesValid",
    "operationallyConsistent",
    "latestCertificationHasProjectionEvidence",
  ]) {
    assert.match(recipients, new RegExp(`value\\.${flag} === true`))
  }
  for (const state of ["pending", "processing", "failed", "terminalFailed"]) {
    assert.match(
      recipients,
      new RegExp(`Number\\(queue\\.${state} \\|\\| 0\\) === 0`),
    )
  }

  assert.match(
    recipients,
    /certificationAgeMs <= maxAgeSeconds \* 1000/,
  )
  assert.match(
    recipientResolver,
    /certificationAgeMs <= maxAgeSeconds \* 1000/,
  )
  assert.match(
    recipientResolver,
    /certificationAgeMs >= -CLOCK_SKEW_MS/,
  )
  assert.match(
    recipientResolver,
    /OUTLOOK_ADDIN_CERTIFICATION_MAX_AGE_SECONDS/,
  )
  assert.match(
    recipients,
    /\.eq\("snapshot_kind", "fcuno_exchange_projection"\)/,
  )
  assert.match(
    recipients,
    /\.eq\("snapshot_sha256", sourceFingerprint\)/,
  )
  assert.match(
    recipients,
    /latestProjectionSnapshotSha256\)\.toLowerCase\(\) ===[\s\S]*latestSourceFingerprint\)\.toLowerCase\(\)/,
  )
  assert.match(recipients, /const sourceKey = `contact:\$\{sourceId\}`/)
  assert.match(recipients, /const sourceKey = `group:\$\{sourceId\}`/)
  assert.match(recipients, /const rawEmailAddress = cleanText\(group\.smtpAddress\)/)
  assert.match(recipients, /const emailAddress = cleanEmail\(rawEmailAddress\)/)
  assert.match(recipients, /emailAddress\.slice\(0, emailAddress\.lastIndexOf\("@"\)\) !== alias/)
  assert.match(recipientResolver, /const address = cleanProjectedEmail\(group\.smtpAddress\)/)
  assert.match(
    recipientResolver,
    /address\.slice\(0, address\.lastIndexOf\("@"\)\) !== alias/,
  )
  for (const source of [recipients, recipientResolver]) {
    assert.doesNotMatch(source, /OUTLOOK_ADDIN_GROUP_DOMAIN/)
    assert.doesNotMatch(source, /EXCHANGE_ADDRESSBOOK_DOMAIN/)
    assert.doesNotMatch(source, /DEFAULT_GROUP_SMTP_DOMAIN/)
    assert.doesNotMatch(source, /cosulich1\.onmicrosoft\.com/)
  }
  assert.doesNotMatch(recipientResolver, /loadSharedAddressBookRecipients/)
  assert.doesNotMatch(
    recipients,
    /uniqueAlias|normaliseAlias|slugify|memberIds|memberships/,
  )
  assert.match(
    recipients,
    /schema: "fcuno\.outlook-certified-recipient-map\/v2"/,
  )
  assert.match(recipients, /generatedAt: now\.toISOString\(\)/)
  assert.match(recipients, /expiresAt: expiresAt\.toISOString\(\)/)
  assert.match(recipients, /sourceFingerprint/)
})

test("taskpane caches are versioned, bounded, and never authorize insertion offline", async () => {
  const { taskpane } = await sources()

  assert.match(taskpane, /updatedAt: String\(input && input\.updatedAt/)
  assert.match(taskpane, /revision: Number\(input && input\.revision/)
  assert.match(taskpane, /recipientResolution:/)
  assert.match(taskpane, /INDEX_CACHE_SCHEMA/)
  assert.match(taskpane, /RECIPIENT_CACHE_SCHEMA/)
  assert.match(taskpane, /cachedAt:/)
  assert.match(taskpane, /expiresAt:/)
  assert.match(taskpane, /validCacheTime/)
  assert.match(taskpane, /function networkPayloadTtlMs\(data, maxTtlMs\)/)
  assert.match(taskpane, /serverDurationMs !== advertisedTtlMs/)
  assert.match(taskpane, /var receivedAt = Date\.now\(\)/)
  assert.match(taskpane, /var localExpiresAt = receivedAt \+ ttlMs/)
  assert.match(
    taskpane,
    /applyRecipientMap\(envelope\.data, Number\(envelope\.expiresAt\)\)/,
  )
  assert.match(
    taskpane,
    /saveCachedRecipientMap\(data, receivedAt, localExpiresAt\)/,
  )
  assert.match(taskpane, /state\.recipientMapFromNetwork = false/)
  assert.match(
    taskpane,
    /!state\.recipientMapFromNetwork[\s\S]*state\.recipientMapExpiresAt <= Date\.now\(\)/,
  )
  assert.match(taskpane, /loadRecipientMap\(true\)/)
  assert.match(taskpane, /loadTemplateDetail\(state\.selectedId, false\)/)
  assert.match(taskpane, /cache: "no-store"/)
  assert.match(taskpane, /credentials: state\.authMode === "cookie" \? "include" : "omit"/)
  assert.match(taskpane, /headers\.Authorization = "Bearer " \+ session\.token/)
  assert.match(
    taskpane,
    /resolution\.sourceFingerprint[\s\S]*state\.recipientCertification[\s\S]*sourceFingerprint/,
  )
  assert.match(taskpane, /var sourceKey = ref\.kind \+ ":" \+ String\(ref\.sourceId\)/)
  assert.match(taskpane, /Number\(counts\.ambiguous\) !== 0/)
  assert.match(taskpane, /Number\(counts\.missing\) !== 0/)
  assert.match(
    taskpane,
    /hasOwnProperty\.call\([\s\S]*?resolution,[\s\S]*?"reconciliationRequired"[\s\S]*?resolution\.reconciliationRequired !== false/,
  )
  assert.doesNotMatch(taskpane, /setRecipients\(item\.to, template\.to\)/)
})

test("taskpane uses supported read-mode new-message forms and guarded blank-compose insertion", async () => {
  const { taskpane } = await sources()

  assert.doesNotMatch(taskpane, /createNestablePublicClientApplication/)
  assert.doesNotMatch(taskpane, /Mail\.ReadWrite/)
  assert.doesNotMatch(taskpane, /graph\.microsoft\.com/)
  assert.doesNotMatch(taskpane, /OUTLOOK_DRAFT_COMPOSE_READY_DELAY_MS/)
  assert.doesNotMatch(taskpane, /mail\/deeplink\/compose/)
  assert.doesNotMatch(taskpane, /window\.open\(/)
  assert.match(taskpane, /function currentComposeItem\(\)/)
  assert.match(taskpane, /function captureComposeContext\(\)/)
  assert.match(taskpane, /function requireComposeContext\(context\)/)
  assert.match(taskpane, /function draftContainsUserContent\(snapshot\)/)
  assert.match(taskpane, /function buildNewMessageForm\(/)
  assert.match(taskpane, /htmlBody: String\(template && template\.bodyHtml/)
  assert.match(taskpane, /displayNewMessageFormAsync\(messageForm, done\)/)
  assert.match(taskpane, /displayNewMessageForm\(messageForm\)/)
  assert.doesNotMatch(taskpane, /displayMessageFormAsync/)
  assert.doesNotMatch(taskpane, /displayMessageForm\(ewsId\)/)
  assert.doesNotMatch(taskpane, /role="alertdialog"/)
  assert.doesNotMatch(taskpane, />Keep draft</)
  assert.doesNotMatch(taskpane, />Replace draft</)
  assert.doesNotMatch(taskpane, /confirmDraftReplacement/)
  assert.match(
    taskpane,
    /Promise\.all\([\s\S]*?loadRecipientMap\(true\)[\s\S]*?state\.recipientMapExpiresAt <= Date\.now\(\)[\s\S]*?Reserving certified insertion/,
  )
  assert.match(taskpane, /state\.inserting = true/)
  assert.match(taskpane, /state\.inserting = false/)
  assert.match(taskpane, /detailPromises/)
  assert.match(taskpane, /registerMailboxItemChangedHandler\(\)/)
  assert.match(taskpane, /restoreDraftIfUnchanged/)

  assert.match(taskpane, /\.rpc\([\s\S]*?"reserve_outlook_template_insertion"/)
  assert.match(taskpane, /p_template_revision: attemptIdentity\.templateRevision/)
  assert.match(taskpane, /p_source_fingerprint: attemptIdentity\.sourceFingerprint/)
  assert.match(taskpane, /\.rpc\([\s\S]*?"complete_outlook_template_insertion"/)
  assert.doesNotMatch(taskpane, /\.from\("audit_logs"\)\.insert/)
  assert.match(
    taskpane,
    /async function recordInsertionAuditEvent\(auditContext, phase, outcome\)/,
  )
  assert.match(taskpane, /function createInsertionAuditContext\(template, operationId\)/)
  assert.match(taskpane, /function createOperationId\(\)/)
  assert.match(taskpane, /phase: phase/)
  assert.match(taskpane, /auditPayload\.outcome = outcome/)
  assert.match(
    taskpane,
    /X-Outlook-Insertion-Audit-Phase"[\s\S]*!== phase/,
  )
  assert.match(taskpane, /var retryDelays = \[250, 700\]/)
  assert.match(taskpane, /errorData\.code === "INSERT_RESERVATION_BUSY"/)
  assert.match(taskpane, /reservationError\.code === "23505"/)
  assert.match(taskpane, /terminalError\.code === "23505"/)
  assert.doesNotMatch(taskpane, /\.eq\("record_pk->>operationId"/)

  const insertionStart = taskpane.indexOf(
    "async function insertSelectedTemplate()",
  )
  const insertionEnd = taskpane.indexOf(
    "async function loadTemplates()",
    insertionStart,
  )
  assert.ok(insertionStart >= 0 && insertionEnd > insertionStart)
  const insertion = taskpane.slice(insertionStart, insertionEnd)
  const reserve = insertion.indexOf(
    'recordInsertionAuditEvent(\n              auditContext,\n              "reserved"',
  )
  const subjectWrite = insertion.indexOf(
    "item.subject.setAsync(template.subject || \"\", done);",
    reserve,
  )
  const bccWrite = insertion.indexOf(
    "await setRecipients(item.bcc, bccRecipients);",
    subjectWrite,
  )
  const bodyWrite = insertion.indexOf(
    "item.body.setAsync(",
    bccWrite,
  )
  const completed = insertion.indexOf("mutationCompleted = true;", bodyWrite)
  const insertedTerminal = insertion.indexOf(
    'recordInsertionAuditEvent(\n                auditContext,\n                "terminal",\n                "inserted"',
    completed,
  )
  assert.ok(
    reserve >= 0 &&
      reserve < subjectWrite &&
      subjectWrite < bccWrite &&
      bccWrite < bodyWrite &&
      bodyWrite < completed &&
      completed < insertedTerminal,
    "reservation must be acknowledged before any compose mutation and inserted finalized only after all fields are written",
  )
  assert.match(insertion, /\.subject\.setAsync/)
  assert.match(insertion, /\.body\.setAsync/)
  assert.match(insertion, /setRecipients\(/)
  assert.match(
    insertion,
    /if \(mutationCompleted\) \{[\s\S]*?return;[\s\S]*?var outcome = "failed-preserved"/,
  )
  assert.doesNotMatch(insertion, /deleteGraphDraft/)
  assert.match(insertion, /restoreDraftIfUnchanged\(/)
  assert.match(
    insertion,
    /recordInsertionAuditEvent\([\s\S]*?"terminal",[\s\S]*?outcome/,
  )
  assert.match(
    insertion,
    /The template was inserted, but FC Uno could not confirm the terminal audit record[\s\S]*?return;/,
  )
})

test("supported new-message form preserves certified recipients, subject, and HTML body", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const buildForm = Function(
    [
      inlineFunctionSource(script, "certifiedRecipientAddress"),
      inlineFunctionSource(script, "buildNewMessageForm"),
      "return buildNewMessageForm;",
    ].join("\n"),
  )() as (
    template: Record<string, unknown>,
    to: Record<string, unknown>[],
    cc: Record<string, unknown>[],
    bcc: Record<string, unknown>[],
  ) => Record<string, unknown>

  assert.deepEqual(
    buildForm(
      { subject: "Certified subject", bodyHtml: "<p>Certified body</p>" },
      [{ displayName: "To Name", emailAddress: "TO@example.com" }],
      [{ displayName: "Cc Name", emailAddress: "cc@example.com" }],
      [{ displayName: "Bcc Name", emailAddress: "bcc@example.com" }],
    ),
    {
      toRecipients: ["to@example.com"],
      ccRecipients: ["cc@example.com"],
      bccRecipients: ["bcc@example.com"],
      subject: "Certified subject",
      htmlBody: "<p>Certified body</p>",
    },
  )
})

test("taskpane audit protocol dynamically fails closed around supported new-message opening", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const insertionSource = inlineFunctionBlock(
    script,
    "async function insertSelectedTemplate()",
    "async function loadTemplates()",
  )

  type HarnessConfig = {
    failReservation?: boolean
    failInsertedTerminal?: boolean
    failComposeOpen?: boolean
  }
  type Harness = {
    run: () => Promise<void>
    auditEvents: Array<{ phase: string; outcome: string | null }>
    notices: Array<{ message: string; tone: string }>
    outlookActions: string[]
    state: { inserting: boolean }
  }
  const makeHarness = Function(
    "config",
    `
      var auditEvents = [];
      var notices = [];
      var outlookActions = [];
      var window = { Office: {} };
      var state = {
        selectedId: "template-1",
        inserting: false,
        recipientMapFromNetwork: true,
        recipientMapExpiresAt: Date.now() + 60000
      };
      function notice(message, tone) { notices.push({ message: message, tone: tone }); }
      async function loadTemplateDetail() {
        return {
          id: "template-1",
          revision: 7,
          subject: "Subject",
          bodyHtml: "<p>Body</p>",
          bodyText: "Body"
        };
      }
      async function loadRecipientMap() { return {}; }
      function resolveStoredRecipientRefs(_template, field) {
        return [{ displayName: field, emailAddress: field + "@example.com" }];
      }
      function createOperationId() {
        return "11111111-1111-4111-8111-111111111111";
      }
      function createInsertionAuditContext(template, operationId) {
        return { templateId: template.id, operationId: operationId };
      }
      async function recordInsertionAuditEvent(_context, phase, outcome) {
        auditEvents.push({ phase: phase, outcome: outcome });
        if (phase === "reserved" && config.failReservation) {
          throw new Error("Reservation rejected.");
        }
        if (phase === "terminal" && outcome === "inserted" &&
            config.failInsertedTerminal) {
          throw new Error("Terminal acknowledgement lost.");
        }
      }
      function captureComposeContext() { return null; }
      function buildNewMessageForm() { return {}; }
      async function openSupportedNewMessageForm() {
        outlookActions.push("display");
        if (config.failComposeOpen) throw new Error("Compose open failed.");
      }
      ${insertionSource}
      return {
        run: insertSelectedTemplate,
        auditEvents: auditEvents,
        notices: notices,
        outlookActions: outlookActions,
        state: state
      };
    `,
  ) as (config: HarnessConfig) => Harness

  const reservationFailure = makeHarness({ failReservation: true })
  await reservationFailure.run()
  assert.deepEqual(reservationFailure.outlookActions, [])
  assert.deepEqual(reservationFailure.auditEvents, [
    { phase: "reserved", outcome: null },
  ])
  assert.equal(reservationFailure.state.inserting, false)

  const terminalFailure = makeHarness({ failInsertedTerminal: true })
  await terminalFailure.run()
  assert.deepEqual(terminalFailure.outlookActions, ["display"])
  assert.deepEqual(terminalFailure.auditEvents, [
    { phase: "reserved", outcome: null },
    { phase: "terminal", outcome: "inserted" },
  ])
  assert.match(
    terminalFailure.notices.at(-1)?.message || "",
    /template was inserted, but FC Uno could not confirm the terminal audit record/i,
  )

  const displayFailure = makeHarness({ failComposeOpen: true })
  await displayFailure.run()
  assert.deepEqual(displayFailure.outlookActions, ["display"])
  assert.deepEqual(displayFailure.auditEvents, [
    { phase: "reserved", outcome: null },
    { phase: "terminal", outcome: "failed-preserved" },
  ])
  assert.match(
    displayFailure.notices.at(-1)?.message || "",
    /No Outlook fields were changed by FC Uno/,
  )
})

test("blank-compose guard accepts only empty or standard-signature drafts and rejects invalid recipients", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const insertSelectedTemplateSource = inlineFunctionSource(
    script,
    "insertSelectedTemplate",
  )
  assert.match(insertSelectedTemplateSource, /captureComposeContext\(\)/)
  assert.match(insertSelectedTemplateSource, /\.setAsync\(/)
  assert.match(insertSelectedTemplateSource, /draftContainsUserContent\(/)

  const draftContainsUserContent = Function(
    `${inlineFunctionSource(script, "draftContainsUserContent")}; return draftContainsUserContent;`,
  )() as (snapshot: Record<string, unknown>) => boolean
  assert.equal(
    draftContainsUserContent({ subject: "", to: [], cc: [], bcc: [], body: "" }),
    false,
  )
  assert.equal(
    draftContainsUserContent({
      subject: "",
      to: [],
      cc: [],
      bcc: [],
      body:
        "<p>Best Regards, Otto Lai</p><p>Fratelli Cosulich Bunkers (HK) Ltd " +
        "Email bunker@cosulich.com.hk</p>",
    }),
    false,
  )
  assert.equal(
    draftContainsUserContent({
      subject: "",
      to: [],
      cc: [],
      bcc: [],
      body: "<p>My unsent negotiation note</p>",
    }),
    true,
  )
  assert.equal(
    draftContainsUserContent({
      subject: "Existing subject",
      to: [],
      cc: [],
      bcc: [],
      body: "",
    }),
    true,
  )

  const buildNewMessageForm = Function(
    [
      inlineFunctionSource(script, "certifiedRecipientAddress"),
      inlineFunctionSource(script, "buildNewMessageForm"),
      "return buildNewMessageForm;",
    ].join("\n"),
  )() as (
    template: Record<string, unknown>,
    to: Record<string, unknown>[],
    cc: Record<string, unknown>[],
    bcc: Record<string, unknown>[],
  ) => Record<string, unknown>

  assert.throws(
    () =>
      buildNewMessageForm(
        { subject: "Subject", bodyHtml: "<p>Body</p>" },
        [{ emailAddress: "not-an-email" }],
        [],
        [],
      ),
    /invalid email address/,
  )
})

test("network response lifetime is clock-independent while stored envelopes expire locally", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const networkPayloadTtlMs = Function(
    `${inlineFunctionSource(script, "networkPayloadTtlMs")}; return networkPayloadTtlMs;`,
  )() as (data: Record<string, unknown>, maxTtlMs: number) => number
  const generatedAt = Date.parse("2026-07-23T12:00:00.000Z")
  const payload = {
    generatedAt: new Date(generatedAt).toISOString(),
    expiresAt: new Date(generatedAt + 120_000).toISOString(),
    ttlSeconds: 120,
  }

  assert.equal(networkPayloadTtlMs(payload, 120_000), 120_000)
  assert.equal(
    networkPayloadTtlMs({ ...payload, expiresAt: new Date(generatedAt + 121_000).toISOString() }, 120_000),
    0,
  )

  const localNow = 1_000_000
  const validCacheTime = Function(
    "Date",
    `${inlineFunctionSource(script, "validCacheTime")}; return validCacheTime;`,
  )({ now: () => localNow }) as (
    cachedAt: number,
    expiresAt: number,
    maxTtlMs: number,
  ) => boolean
  assert.equal(validCacheTime(localNow, localNow + 120_000, 120_000), true)
  assert.equal(validCacheTime(localNow - 120_001, localNow - 1, 120_000), false)
})

test("admin template index keeps recipient truth internal without list diagnostics", async () => {
  const page = await readFile(adminTemplatePageFile, "utf8")

  assert.match(
    page,
    /template\.bodyLoaded[\s\S]*?\? getRecipientTruthStatus\(template\.recipientResolution\)[\s\S]*?: unloadedRecipientTruth/,
  )
  assert.match(page, /kind: "unloaded"/)
  assert.match(
    page,
    /hasOwnProperty\.call\(value, "reconciliationRequired"\)[\s\S]*?value\.reconciliationRequired !== false/,
  )
  assert.doesNotMatch(page, /"Truth not loaded"/)
  assert.doesNotMatch(page, /visibleRecipientTruthSummary/)
  assert.doesNotMatch(page, /recipientTruthBadgeStyle/)
  assert.doesNotMatch(page, /OUTLOOK RECIPIENT TRUTH: SENDABLE \/ CURRENT/)
  assert.doesNotMatch(page, /OUTLOOK RECIPIENT TRUTH: CHECK PENDING/)
  assert.match(page, /OUTLOOK RECIPIENT TRUTH: BLOCKED/)
})

test("admin template body sync does not replace matching editable HTML", async () => {
  const page = await readFile(adminTemplatePageFile, "utf8")

  assert.match(
    page,
    /const nextEditorHtml = selectedTemplateBodyLoaded[\s\S]*?if \(editorRef\.current\.innerHTML === nextEditorHtml\) return[\s\S]*?editorRef\.current\.innerHTML = nextEditorHtml/,
  )
})

test("generated inline taskpane JavaScript remains syntactically valid", async () => {
  const { taskpane } = await sources()
  assert.doesNotThrow(() => Function(renderedInlineTaskpaneScript(taskpane)))
})
