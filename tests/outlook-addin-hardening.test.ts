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

test("taskpane reserves before mutation, restores conservatively, and records a terminal outcome", async () => {
  const { taskpane } = await sources()

  assert.match(taskpane, /async function snapshotDraft\(item, office\)/)
  assert.match(taskpane, /item\.subject\.getAsync/)
  assert.match(taskpane, /getRecipients\(item\.to\)/)
  assert.match(taskpane, /getRecipients\(item\.cc\)/)
  assert.match(taskpane, /getRecipients\(item\.bcc\)/)
  assert.match(taskpane, /item\.body\.getAsync/)
  assert.match(
    taskpane,
    /getOptions\.bodyMode = office\.MailboxEnums\.BodyMode\.HostConfig/,
  )
  assert.match(
    taskpane,
    /setOptions\.bodyMode = office\.MailboxEnums\.BodyMode\.HostConfig/,
  )
  assert.doesNotMatch(taskpane, /window\.confirm\(/)
  assert.match(
    taskpane,
    /await confirmDraftReplacement\(\)[\s\S]*?await loadRecipientMap\(true\)[\s\S]*?state\.recipientMapExpiresAt <= Date\.now\(\)[\s\S]*?Reserving certified insertion/,
  )
  assert.match(taskpane, /role="alertdialog"/)
  assert.match(taskpane, /closeReplacementConfirmation\(true\)/)
  assert.match(taskpane, /state\.inserting = true/)
  assert.match(taskpane, /state\.inserting = false/)
  assert.match(taskpane, /mutationStarted = true/)
  assert.match(
    taskpane,
    /async function restoreDraft\(item, snapshot, assertCurrentItem\)/,
  )
  assert.match(taskpane, /item\.subject\.setAsync\(snapshot\.subject/)
  assert.match(taskpane, /setRecipients\(item\.to, snapshot\.to\)/)
  assert.match(taskpane, /setRecipients\(item\.cc, snapshot\.cc\)/)
  assert.match(taskpane, /setRecipients\(item\.bcc, snapshot\.bcc\)/)
  assert.match(taskpane, /item\.body\.setAsync\(snapshot\.body/)
  assert.match(
    taskpane,
    /async function restoreDraftIfUnchanged\([\s\S]*?var item = currentInsertionItem\(insertionContext\);[\s\S]*?var currentSnapshot = await snapshotDraft\(item, office\);[\s\S]*?if \(!draftSnapshotsEqual\(currentSnapshot, addinWrittenSnapshot\)\)[\s\S]*?await restoreDraft\(item, originalSnapshot[\s\S]*?var restoredSnapshot = await snapshotDraft\(item, office\);[\s\S]*?return draftSnapshotsEqual\(restoredSnapshot, originalSnapshot\)/,
  )
  assert.match(
    taskpane,
    /var restored = await restoreDraftIfUnchanged\([\s\S]*?newer edits were kept/,
  )

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
  const mutation = insertion.indexOf("mutationStarted = true;", reserve)
  const firstOfficeWrite = insertion.indexOf(
    "item.subject.setAsync",
    mutation,
  )
  const bodyWrite = insertion.indexOf("item.body.setAsync", firstOfficeWrite)
  const completed = insertion.indexOf("mutationCompleted = true;", bodyWrite)
  const insertedTerminal = insertion.indexOf(
    'recordInsertionAuditEvent(\n                auditContext,\n                "terminal",\n                "inserted"',
    completed,
  )
  assert.ok(
    reserve >= 0 &&
      reserve < mutation &&
      mutation < firstOfficeWrite &&
      firstOfficeWrite < bodyWrite &&
      bodyWrite < completed &&
      completed < insertedTerminal,
    "reservation must be acknowledged before the first Office write and inserted finalized only after every write",
  )
  assert.match(
    insertion,
    /if \(mutationCompleted\) \{[\s\S]*?return;[\s\S]*?var outcome = "failed-preserved"/,
  )
  assert.match(
    insertion,
    /if \(restored\) \{[\s\S]*?outcome = "failed-restored"/,
  )
  assert.match(
    insertion,
    /recordInsertionAuditEvent\([\s\S]*?"terminal",[\s\S]*?outcome/,
  )
  assert.match(
    insertion,
    /Template inserted, but FC Uno could not confirm the terminal audit record[\s\S]*?return;/,
  )
})

test("taskpane audit protocol dynamically fails closed and never rolls back a completed insertion", async () => {
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
    failRecipientField?: "to" | "cc" | "bcc"
    restoreResult?: boolean
    draftHasContent?: boolean
    replacementConfirmed?: boolean
  }
  type Harness = {
    run: () => Promise<void>
    auditEvents: Array<{ phase: string; outcome: string | null }>
    notices: Array<{ message: string; tone: string }>
    restores: string[]
    writes: string[]
    state: { inserting: boolean }
  }
  const makeHarness = Function(
    "config",
    `
      var auditEvents = [];
      var notices = [];
      var restores = [];
      var writes = [];
      var state = {
        selectedId: "template-1",
        composeReady: true,
        itemChangeGuardRequired: false,
        itemChangeGuardReady: true,
        inserting: false,
        recipientMapFromNetwork: true,
        recipientMapExpiresAt: Date.now() + 60000
      };
      var success = "succeeded";
      function successResult() { return { status: success, value: undefined }; }
      var item = {
        subject: {
          setAsync: function (_value, done) {
            writes.push("subject");
            done(successResult());
          }
        },
        to: { field: "to" },
        cc: { field: "cc" },
        bcc: { field: "bcc" },
        body: {
          setAsync: function (_value, _options, done) {
            writes.push("body");
            done(successResult());
          }
        }
      };
      var window = {
        Office: { AsyncResultStatus: { Succeeded: success } }
      };
      function markComposeReady() { state.composeReady = true; }
      function notice(message, tone) { notices.push({ message: message, tone: tone }); }
      function captureInsertionRequest() { return { generation: 0, itemIdentity: "" }; }
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
      function beginInsertionMutation() { return { item: item }; }
      function requireCurrentInsertionItem() { return item; }
      async function snapshotDraft() {
        return {
          subject: "",
          to: [],
          cc: [],
          bcc: [],
          body: "",
          bodyOptions: {},
          isHtml: true
        };
      }
      function draftHasContent() { return Boolean(config.draftHasContent); }
      async function confirmDraftReplacement() {
        return config.replacementConfirmed !== false;
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
      function copyDraftSnapshot(snapshot) {
        return {
          subject: snapshot.subject,
          to: snapshot.to.slice(),
          cc: snapshot.cc.slice(),
          bcc: snapshot.bcc.slice(),
          body: snapshot.body,
          bodyOptions: snapshot.bodyOptions,
          isHtml: snapshot.isHtml
        };
      }
      function officeAsync(call) {
        return new Promise(function (resolve, reject) {
          call(function (result) {
            if (result && result.status === success) resolve(result.value);
            else reject(new Error("Office write failed."));
          });
        });
      }
      async function setRecipients(recipientApi) {
        if (config.failRecipientField === recipientApi.field) {
          throw new Error("Recipient write failed.");
        }
        writes.push(recipientApi.field);
      }
      async function restoreDraftIfUnchanged() {
        restores.push("restore");
        return config.restoreResult !== false;
      }
      ${insertionSource}
      return {
        run: insertSelectedTemplate,
        auditEvents: auditEvents,
        notices: notices,
        restores: restores,
        writes: writes,
        state: state
      };
    `,
  ) as (config: HarnessConfig) => Harness

  const replacementCancelled = makeHarness({
    draftHasContent: true,
    replacementConfirmed: false,
  })
  await replacementCancelled.run()
  assert.deepEqual(replacementCancelled.writes, [])
  assert.deepEqual(replacementCancelled.auditEvents, [])
  assert.match(
    replacementCancelled.notices.at(-1)?.message || "",
    /Insertion cancelled\. Draft unchanged\./,
  )
  assert.equal(replacementCancelled.state.inserting, false)

  const reservationFailure = makeHarness({ failReservation: true })
  await reservationFailure.run()
  assert.deepEqual(reservationFailure.writes, [])
  assert.deepEqual(reservationFailure.restores, [])
  assert.deepEqual(reservationFailure.auditEvents, [
    { phase: "reserved", outcome: null },
  ])
  assert.equal(reservationFailure.state.inserting, false)

  const terminalFailure = makeHarness({ failInsertedTerminal: true })
  await terminalFailure.run()
  assert.deepEqual(terminalFailure.writes, [
    "subject",
    "to",
    "cc",
    "bcc",
    "body",
  ])
  assert.deepEqual(terminalFailure.restores, [])
  assert.deepEqual(terminalFailure.auditEvents, [
    { phase: "reserved", outcome: null },
    { phase: "terminal", outcome: "inserted" },
  ])
  assert.match(
    terminalFailure.notices.at(-1)?.message || "",
    /Template inserted, but FC Uno could not confirm the terminal audit record/,
  )

  const partialFailure = makeHarness({
    failRecipientField: "to",
    restoreResult: true,
  })
  await partialFailure.run()
  assert.deepEqual(partialFailure.writes, ["subject"])
  assert.deepEqual(partialFailure.restores, ["restore"])
  assert.deepEqual(partialFailure.auditEvents, [
    { phase: "reserved", outcome: null },
    { phase: "terminal", outcome: "failed-restored" },
  ])
})

test("taskpane confirms before replacing meaningful non-text HTML", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const draftHasContent = Function(
    `${inlineFunctionSource(script, "draftHasContent")}; return draftHasContent;`,
  )() as (snapshot: Record<string, unknown>) => boolean
  const snapshot = (body: string) => ({
    subject: "",
    to: [],
    cc: [],
    bcc: [],
    body,
    isHtml: true,
  })

  assert.equal(draftHasContent(snapshot('<p><img src="cid:logo"></p>')), true)
  assert.equal(draftHasContent(snapshot("<hr>")), true)
  assert.equal(draftHasContent(snapshot("<table><tr><td></td></tr></table>")), true)
  assert.equal(draftHasContent(snapshot("<p>&amp;</p>")), true)
  assert.equal(draftHasContent(snapshot("<p>&nbsp;</p>")), false)
  assert.equal(draftHasContent(snapshot("<p>\u00a0</p>")), false)
  assert.equal(draftHasContent(snapshot("<p><br></p>")), false)
})

test("taskpane rollback comparison detects every post-insertion draft edit", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)
  const draftSnapshotsEqual = Function(
    [
      inlineFunctionSource(script, "draftRecipientKey"),
      inlineFunctionSource(script, "draftRecipientListsEqual"),
      inlineFunctionSource(script, "draftSnapshotsEqual"),
      "return draftSnapshotsEqual;",
    ].join("\n"),
  )() as (left: Record<string, unknown>, right: Record<string, unknown>) => boolean

  const inserted = {
    subject: "Confirmed subject",
    to: [{ displayName: "To", emailAddress: "to@example.com" }],
    cc: [{ displayName: "Cc", emailAddress: "cc@example.com" }],
    bcc: [{ displayName: "Bcc", emailAddress: "bcc@example.com" }],
    body: "<p>Confirmed body</p>",
    isHtml: true,
  }
  assert.equal(draftSnapshotsEqual(inserted, structuredClone(inserted)), true)

  for (const changed of [
    { ...structuredClone(inserted), subject: "User subject" },
    {
      ...structuredClone(inserted),
      to: [{ displayName: "New To", emailAddress: "new-to@example.com" }],
    },
    {
      ...structuredClone(inserted),
      cc: [{ displayName: "New Cc", emailAddress: "new-cc@example.com" }],
    },
    {
      ...structuredClone(inserted),
      bcc: [{ displayName: "New Bcc", emailAddress: "new-bcc@example.com" }],
    },
    { ...structuredClone(inserted), body: "<p>User body</p>" },
  ]) {
    assert.equal(draftSnapshotsEqual(inserted, changed), false)
  }
})

test("pinned taskpane aborts on item changes and never reuses a pre-fetch item", async () => {
  const { taskpane } = await sources()
  const script = renderedInlineTaskpaneScript(taskpane)

  assert.match(taskpane, /requirements\.isSetSupported\("Mailbox", "1\.5"\)/)
  assert.match(
    taskpane,
    /mailbox\.addHandlerAsync\([\s\S]*?office\.EventType\.ItemChanged,[\s\S]*?handleMailboxItemChanged/,
  )
  assert.match(
    taskpane,
    /function handleMailboxItemChanged\(\) \{[\s\S]*?state\.itemGeneration \+= 1;[\s\S]*?markComposeReady\(\)/,
  )
  assert.match(
    taskpane,
    /var insertionRequest = captureInsertionRequest\(\);[\s\S]*?await loadTemplateDetail\([\s\S]*?insertionContext = beginInsertionMutation\(insertionRequest\);[\s\S]*?await loadRecipientMap\(true\);/,
  )
  assert.match(
    taskpane,
    /snapshot = await snapshotDraft\(item, office\);[\s\S]*?item = requireCurrentInsertionItem\(insertionContext\);/,
  )
  assert.match(
    taskpane,
    /restoreDraftIfUnchanged\([\s\S]*?insertionContext,[\s\S]*?office/,
  )
  const insertSelectedTemplateSource = inlineFunctionSource(
    script,
    "insertSelectedTemplate",
  )
  assert.doesNotMatch(
    insertSelectedTemplateSource,
    /var item = office && office\.context && office\.context\.mailbox && office\.context\.mailbox\.item;[\s\S]*?await loadTemplateDetail/,
  )

  const insertionItemMatches = Function(
    [
      inlineFunctionSource(script, "mailboxItemIdentity"),
      inlineFunctionSource(script, "insertionItemMatches"),
      "return insertionItemMatches;",
    ].join("\n"),
  )() as (
    currentItem: Record<string, unknown> | null,
    expectedItem: Record<string, unknown> | null,
    currentGeneration: number,
    expectedGeneration: number,
    expectedItemIdentity: string,
  ) => boolean
  const originalItem = { itemId: "draft-a" }
  assert.equal(
    insertionItemMatches(originalItem, originalItem, 4, 4, "draft-a"),
    true,
  )
  assert.equal(
    insertionItemMatches({ itemId: "draft-a" }, originalItem, 4, 4, "draft-a"),
    true,
  )
  assert.equal(
    insertionItemMatches(originalItem, originalItem, 5, 4, "draft-a"),
    false,
  )
  assert.equal(
    insertionItemMatches({ itemId: "draft-b" }, originalItem, 4, 4, "draft-a"),
    false,
  )
  assert.equal(insertionItemMatches(null, originalItem, 4, 4, "draft-a"), false)
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
