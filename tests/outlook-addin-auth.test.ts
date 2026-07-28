import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const files = {
  adminAuth: new URL("../lib/adminAuth.ts", import.meta.url),
  adminUsers: new URL("../lib/adminUsers.ts", import.meta.url),
  authDialog: new URL(
    "../app/api/outlook-addin/auth-dialog/route.ts",
    import.meta.url,
  ),
  templates: new URL("../app/api/email-templates/route.ts", import.meta.url),
  recipients: new URL(
    "../app/api/outlook-addin/recipient-map/route.ts",
    import.meta.url,
  ),
  taskpane: new URL(
    "../app/api/outlook-addin/taskpane/route.ts",
    import.meta.url,
  ),
  auditLog: new URL("../lib/auditLog.ts", import.meta.url),
  idempotencyMigration: new URL(
    "../supabase/migrations/20260723124418_outlook_template_insertion_attempt_idempotency.sql",
    import.meta.url,
  ),
}

async function sources() {
  const entries = await Promise.all(
    Object.entries(files).map(async ([name, url]) => [
      name,
      await readFile(url, "utf8"),
    ]),
  )
  return Object.fromEntries(entries) as Record<keyof typeof files, string>
}

test("request-aware admin auth prefers strict bearer validation and preserves cookie fallback", async () => {
  const { adminAuth, adminUsers } = await sources()
  const requestResolver = adminAuth.match(
    /async function resolveAdminRequestSession\([\s\S]*?\n}\n/,
  )
  assert.ok(requestResolver, "request-aware resolver should be present")
  assert.match(
    requestResolver[0],
    /authorization === null\) return resolveAdminSession\(\)/,
  )
  assert.match(adminAuth, /\^Bearer \(\[A-Za-z0-9_-\]\{40,256\}\)\$\/i/)
  assert.match(adminAuth, /requireAdminPagePermissionForRequest/)
  assert.match(adminAuth, /requireAdminPasswordResetSessionForRequest/)
  assert.match(adminAuth, /getDatabaseAdminUserByIdStrict/)
  assert.match(adminUsers, /if \(error\) throw error[\s\S]*if \(!data\) return null/)
  assert.doesNotMatch(adminAuth, /sameSite:\s*"none"/i)
})

test("all confidential Outlook APIs accept bearer-or-cookie request auth", async () => {
  const { templates, recipients, taskpane } = await sources()

  for (const [name, source] of Object.entries({
    templates,
    recipients,
    insertionAudit: taskpane,
  })) {
    assert.match(
      source,
      /requireAdminPagePermissionForRequest\([\s\S]*?request,[\s\S]*?"email-templates",[\s\S]*?"view"/,
      `${name} must enforce current Outlook Templates permission`,
    )
    assert.match(source, /private, no-store, max-age=0/)
  }

  assert.match(templates, /export async function GET\(request: Request\)/)
  assert.match(recipients, /export async function GET\(request: Request\)/)
  assert.match(taskpane, /export async function POST\(request: Request\)/)
})

test("public taskpane stays inert until a protected bearer validation succeeds", async () => {
  const { taskpane } = await sources()
  const getStart = taskpane.indexOf("export async function GET(request: Request)")
  const htmlStart = taskpane.indexOf("const html = `", getStart)
  assert.ok(getStart >= 0 && htmlStart > getStart)
  assert.doesNotMatch(
    taskpane.slice(getStart, htmlStart),
    /requireAdminPagePermission/,
  )

  const validation = taskpane.match(
    /async function validateAuthenticationAndLoad\(\) \{([\s\S]*?)\n        }\n\n        function acceptDialogMessage/,
  )
  assert.ok(validation, "taskpane should validate before loading confidential data")
  assert.ok(
    validation[1].indexOf(
      'authenticatedFetch(AUTH_DIALOG_URL + "?mode=session")',
    ) < validation[1].indexOf("state.authenticated = true"),
  )
  assert.ok(
    validation[1].indexOf("state.authenticated = true") <
      validation[1].indexOf("loadTemplates()"),
  )

  const loadTemplates = taskpane.match(
    /async function loadTemplates\(\) \{([\s\S]*?)\n        }\n\n        els\.search/,
  )
  assert.ok(loadTemplates)
  assert.ok(
    loadTemplates[1].indexOf("if (!state.authenticated)") <
      loadTemplates[1].indexOf("loadCachedIndex()"),
  )
  assert.match(taskpane, /function removeStoredAuthSessions\(\)[\s\S]*?localStorage\.removeItem\(AUTH_SESSION_KEY\)/)
  assert.match(taskpane, /clearAuthentication\([\s\S]*?removeStoredAuthSessions\(\)/)
  assert.match(taskpane, /localStorage\.removeItem\(INDEX_CACHE_KEY\)/)
  assert.match(taskpane, /localStorage\.removeItem\(RECIPIENT_MAP_CACHE_KEY\)/)
})

test("taskpane uses Office Dialog API and one stale-safe bearer fetch path", async () => {
  const { authDialog, taskpane } = await sources()

  assert.match(taskpane, /displayDialogAsync\(/)
  assert.match(taskpane, /displayInIframe: false/)
  assert.match(taskpane, /DialogMessageReceived/)
  assert.match(taskpane, /DialogEventReceived/)
  assert.doesNotMatch(taskpane, /window\.open\(/)
  assert.match(taskpane, /window\.localStorage\.setItem\([\s\S]*?AUTH_SESSION_KEY/)
  assert.match(taskpane, /window\.sessionStorage\.setItem\([\s\S]*?AUTH_SESSION_KEY/)
  assert.match(taskpane, /AUTH_SESSION_MAX_TTL_MS = 400 \* 24 \* 60 \* 60 \* 1000/)
  assert.match(taskpane, /refreshAuthSessionExpiry\(validation\.expiresAt\)/)
  assert.match(authDialog, /expiresAt: session\.expiresAt/)
  assert.match(taskpane, /function scheduleAuthExpiry\([\s\S]*?checkExpiry[\s\S]*?Math\.min\(remaining, 2147483647\)/)
  assert.match(taskpane, /JSON\.stringify\(\{ action: "logout" \}\)/)
  assert.match(authDialog, /if \(action === "logout"\)[\s\S]*?revokeDatabaseAdminSession\(token\)/)
  assert.match(taskpane, /headers\.Authorization = "Bearer " \+ session\.token/)
  assert.match(taskpane, /credentials: "omit"/)

  for (const protectedCall of [
    "RECIPIENT_MAP_URL",
    "TEMPLATE_DETAIL_URL",
    "TEMPLATE_INDEX_URL",
    "INSERTION_AUDIT_URL",
  ]) {
    assert.match(
      taskpane,
      new RegExp(`authenticatedFetch\\(\\s*${protectedCall}`),
      `${protectedCall} must use the shared bearer wrapper`,
    )
  }

  assert.match(
    taskpane,
    /response\.status === 401\)[\s\S]*clearAuthentication\(/,
  )
  assert.match(taskpane, /authGeneration/)
  assert.match(taskpane, /assertAuthRequestCurrent\(result\.context\)/)
  assert.match(
    taskpane,
    /state\.recipientMapPromise === recipientRequest/,
  )
  assert.match(taskpane, /auditGeneration !== state\.authGeneration/)
})

test("dialog keeps reset token in memory and sends the same session only after reset", async () => {
  const { authDialog } = await sources()

  assert.match(authDialog, /createOutlookAddinAdminSession\(user\)/)
  assert.equal(
    (authDialog.match(/createOutlookAddinAdminSession\(user\)/g) || []).length,
    1,
  )
  assert.match(authDialog, /requireAdminPasswordResetSessionForRequest\(request\)/)
  assert.match(authDialog, /completeDatabaseAdminPasswordReset\(/)
  assert.match(authDialog, /var pendingSession = null/)
  assert.match(authDialog, /await sendAuthenticatedSession\(pendingSession\)/)
  assert.match(authDialog, /messageParent\(JSON\.stringify\(/)
  assert.match(authDialog, /schema: AUTH_MESSAGE_SCHEMA/)
  assert.doesNotMatch(authDialog, /sessionStorage|localStorage/)
  assert.doesNotMatch(authDialog, /token=.*URL|searchParams\.set\([^)]*token/i)
})

test("insertion attempt operation IDs are unique only within their audit scope", async () => {
  const { idempotencyMigration } = await sources()

  assert.match(idempotencyMigration, /create unique index if not exists/)
  assert.match(idempotencyMigration, /\(\(record_pk ->> 'operationId'\)\)/)
  assert.match(
    idempotencyMigration,
    /where table_schema = 'app'[\s\S]*table_name = 'outlook_template_insertion_attempts'[\s\S]*operation = 'INSERT'/,
  )
  assert.match(idempotencyMigration, /record_pk \? 'operationId'/)
})

test("Outlook insertion attempts are visible and non-undoable in Audit Log", async () => {
  const { auditLog } = await sources()

  assert.match(
    auditLog,
    /table_schema\.eq\.public,and\(table_schema\.eq\.app,table_name\.eq\.outlook_template_insertion_attempts\)/,
  )
  assert.match(
    auditLog,
    /NON_UNDOABLE_TABLES[\s\S]*"outlook_template_insertion_attempts"/,
  )
  assert.match(
    auditLog,
    /outlook_template_insertion_attempts:\s*"email-templates"/,
  )
})

test("generated auth-dialog inline JavaScript is syntactically valid", async () => {
  const { authDialog } = await sources()
  const htmlTemplate = authDialog.match(
    /const html = `([\s\S]*?)`\n\n  return new NextResponse\(html,/,
  )
  assert.ok(htmlTemplate, "auth-dialog HTML template should be extractable")

  const templateBody = htmlTemplate[1].replace(
    /\$\{JSON\.stringify\([^)]+\)\}/g,
    '"https://fcuno.test/api"',
  )
  const html = Function(`return \`${templateBody}\`;`)() as string
  const inlineScript = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/)
  assert.ok(inlineScript, "inline auth-dialog script should be extractable")
  assert.doesNotThrow(() => Function(inlineScript[1]))
})
