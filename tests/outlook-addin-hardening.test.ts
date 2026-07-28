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
      /requireAdminPagePermissionForRequest\([\s\S]*?request,[\s\S]*?"email-templates",[\s\S]*?"view"/,
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
      "await requireAdminPagePermissionForRequest(",
    ) < source.templates.indexOf("loadEmailTemplate(id)"),
    "permission must be checked before any template detail read",
  )
  assert.ok(
    source.templates.indexOf(
      "await requireAdminPagePermissionForRequest(",
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
  assert.match(taskpane, /await loadRecipientMap\(true\)/)
  assert.match(taskpane, /loadTemplateDetail\(state\.selectedId, true\)/)
  assert.match(taskpane, /cache: "no-store"/)
  assert.match(taskpane, /credentials: "omit"/)
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

test("taskpane reserves before creating a separate Graph draft and records a terminal outcome", async () => {
  const { taskpane } = await sources()

  assert.match(taskpane, /createNestablePublicClientApplication/)
  assert.match(taskpane, /async function loadMsalBrowser\(\)/)
  assert.match(taskpane, /script\.src = MSAL_SCRIPT_URL/)
  assert.match(taskpane, /await loadMsalBrowser\(\)/)
  assert.doesNotMatch(
    taskpane,
    /<script src="\/outlook-msal-browser-4\.24\.1\.min\.js"><\/script>/,
  )
  assert.match(
    taskpane,
    /requirements\.isSetSupported\("NestedAppAuth", "1\.1"\)/,
  )
  assert.match(taskpane, /scopes: GRAPH_SCOPES\.slice\(\)/)
  assert.match(taskpane, /acquireTokenSilent\(request\)/)
  assert.match(taskpane, /acquireTokenPopup\(request\)/)
  assert.match(taskpane, /graphAccountMatchesMailbox\(result\.account\)/)
  assert.match(taskpane, /https:\/\/graph\.microsoft\.com\/v1\.0\/me\/messages/)
  assert.match(taskpane, /mailbox\.convertToEwsId\(draftId, restVersion\.v2_0\)/)
  assert.match(taskpane, /mailbox\.displayMessageFormAsync\(ewsId, done\)/)
  assert.match(taskpane, /mailbox\.displayMessageForm\(ewsId\)/)
  assert.match(taskpane, /async function deleteGraphDraft\(accessToken, draftId\)/)
  assert.doesNotMatch(taskpane, /role="alertdialog"/)
  assert.doesNotMatch(taskpane, />Keep draft</)
  assert.doesNotMatch(taskpane, />Replace draft</)
  assert.doesNotMatch(taskpane, /confirmDraftReplacement/)
  assert.match(
    taskpane,
    /await loadRecipientMap\(true\)[\s\S]*?state\.recipientMapExpiresAt <= Date\.now\(\)[\s\S]*?Reserving certified insertion/,
  )
  assert.match(taskpane, /state\.inserting = true/)
  assert.match(taskpane, /state\.inserting = false/)
  assert.match(taskpane, /mutationStarted = true/)

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
  const graphCreate = insertion.indexOf("await createGraphDraft(", reserve)
  const mutation = insertion.indexOf("mutationStarted = true;", graphCreate)
  const display = insertion.indexOf("await displayGraphDraft(graphDraft.id);", mutation)
  const completed = insertion.indexOf("mutationCompleted = true;", display)
  const insertedTerminal = insertion.indexOf(
    'recordInsertionAuditEvent(\n                auditContext,\n                "terminal",\n                "inserted"',
    completed,
  )
  assert.ok(
    reserve >= 0 &&
      reserve < graphCreate &&
      graphCreate < mutation &&
      mutation < display &&
      display < completed &&
      completed < insertedTerminal,
    "reservation must be acknowledged before Graph creates the draft and inserted finalized only after Outlook opens it",
  )
  assert.doesNotMatch(insertion, /\.subject\.setAsync/)
  assert.doesNotMatch(insertion, /\.body\.setAsync/)
  assert.doesNotMatch(insertion, /setRecipients\(/)
  assert.match(
    insertion,
    /if \(mutationCompleted\) \{[\s\S]*?return;[\s\S]*?var outcome = "failed-preserved"/,
  )
  assert.match(
    insertion,
    /await deleteGraphDraft\([\s\S]*?The unopened new draft was removed/,
  )
  assert.match(
    insertion,
    /recordInsertionAuditEvent\([\s\S]*?"terminal",[\s\S]*?outcome/,
  )
  assert.match(
    insertion,
    /The new Outlook message opened, but FC Uno could not confirm the terminal audit record[\s\S]*?return;/,
  )
})

test("taskpane audit protocol dynamically fails closed and cleans up an unopened new draft", async () => {
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
    failDraftCreation?: boolean
    failDraftDisplay?: boolean
    cleanupSucceeds?: boolean
  }
  type Harness = {
    run: () => Promise<void>
    auditEvents: Array<{ phase: string; outcome: string | null }>
    notices: Array<{ message: string; tone: string }>
    graphActions: string[]
    state: { inserting: boolean }
  }
  const makeHarness = Function(
    "config",
    `
      var auditEvents = [];
      var notices = [];
      var graphActions = [];
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
      async function acquireGraphAccessToken() {
        graphActions.push("token");
        return "token";
      }
      function buildGraphDraftPayload() { return { subject: "Subject" }; }
      async function createGraphDraft() {
        graphActions.push("create");
        if (config.failDraftCreation) throw new Error("Draft create failed.");
        return { id: "draft-1", isDraft: true };
      }
      async function displayGraphDraft() {
        graphActions.push("display");
        if (config.failDraftDisplay) throw new Error("Draft display failed.");
      }
      async function deleteGraphDraft() {
        graphActions.push("delete");
        return config.cleanupSucceeds !== false;
      }
      ${insertionSource}
      return {
        run: insertSelectedTemplate,
        auditEvents: auditEvents,
        notices: notices,
        graphActions: graphActions,
        state: state
      };
    `,
  ) as (config: HarnessConfig) => Harness

  const reservationFailure = makeHarness({ failReservation: true })
  await reservationFailure.run()
  assert.deepEqual(reservationFailure.graphActions, [])
  assert.deepEqual(reservationFailure.auditEvents, [
    { phase: "reserved", outcome: null },
  ])
  assert.equal(reservationFailure.state.inserting, false)

  const terminalFailure = makeHarness({ failInsertedTerminal: true })
  await terminalFailure.run()
  assert.deepEqual(terminalFailure.graphActions, ["token", "create", "display"])
  assert.deepEqual(terminalFailure.auditEvents, [
    { phase: "reserved", outcome: null },
    { phase: "terminal", outcome: "inserted" },
  ])
  assert.match(
    terminalFailure.notices.at(-1)?.message || "",
    /new Outlook message opened, but FC Uno could not confirm the terminal audit record/i,
  )

  const displayFailure = makeHarness({
    failDraftDisplay: true,
    cleanupSucceeds: true,
  })
  await displayFailure.run()
  assert.deepEqual(displayFailure.graphActions, [
    "token",
    "create",
    "display",
    "delete",
  ])
  assert.deepEqual(displayFailure.auditEvents, [
    { phase: "reserved", outcome: null },
    { phase: "terminal", outcome: "failed-preserved" },
  ])
  assert.match(
    displayFailure.notices.at(-1)?.message || "",
    /original Outlook draft was not changed/,
  )
})

test("Graph draft payload preserves certified recipients and the current Outlook item is never mutated", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const insertSelectedTemplateSource = inlineFunctionSource(
    script,
    "insertSelectedTemplate",
  )
  assert.doesNotMatch(insertSelectedTemplateSource, /currentComposeItem\(/)
  assert.doesNotMatch(insertSelectedTemplateSource, /\.setAsync\(/)
  assert.doesNotMatch(insertSelectedTemplateSource, /captureInsertionRequest\(/)

  const buildGraphDraftPayload = Function(
    [
      inlineFunctionSource(script, "graphRecipient"),
      inlineFunctionSource(script, "buildGraphDraftPayload"),
      "return buildGraphDraftPayload;",
    ].join("\n"),
  )() as (
    template: Record<string, unknown>,
    to: Record<string, unknown>[],
    cc: Record<string, unknown>[],
    bcc: Record<string, unknown>[],
  ) => Record<string, unknown>
  assert.deepEqual(
    buildGraphDraftPayload(
      { subject: "Certified subject", bodyHtml: "<p>Certified body</p>" },
      [{ displayName: "To Name", emailAddress: "TO@example.com" }],
      [{ displayName: "Cc Name", emailAddress: "cc@example.com" }],
      [{ displayName: "Bcc Name", emailAddress: "bcc@example.com" }],
    ),
    {
      subject: "Certified subject",
      body: { contentType: "HTML", content: "<p>Certified body</p>" },
      toRecipients: [
        { emailAddress: { address: "to@example.com", name: "To Name" } },
      ],
      ccRecipients: [
        { emailAddress: { address: "cc@example.com", name: "Cc Name" } },
      ],
      bccRecipients: [
        { emailAddress: { address: "bcc@example.com", name: "Bcc Name" } },
      ],
    },
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

test("admin template index labels unloaded truth without claiming it is pending", async () => {
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
  assert.match(page, /"Truth not loaded"/)
  assert.match(page, /visibleRecipientTruthSummary\.unloaded/)
  assert.match(page, /not loaded/)
})

test("generated inline taskpane JavaScript remains syntactically valid", async () => {
  const { taskpane } = await sources()
  assert.doesNotThrow(() => Function(renderedInlineTaskpaneScript(taskpane)))
})
