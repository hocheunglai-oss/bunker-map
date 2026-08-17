import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const route = readFileSync(
  new URL("../app/api/spc/enquiries/route.ts", import.meta.url),
  "utf8",
)
const enquiriesPage = readFileSync(
  new URL("../app/spc/enquiries/page.tsx", import.meta.url),
  "utf8",
)
const globalStyles = readFileSync(
  new URL("../app/globals.css", import.meta.url),
  "utf8",
)
const enquiriesStore = readFileSync(
  new URL("../lib/spcEnquiries.ts", import.meta.url),
  "utf8",
)
const lostRecordPage = readFileSync(
  new URL("../app/spc/lost-record/page.tsx", import.meta.url),
  "utf8",
)
const speedBoard = readFileSync(
  new URL("../tools/whatsapp-spc-speed-board/background.js", import.meta.url),
  "utf8",
)

test("SPC web enquiry history requests only the authenticated user's rows", () => {
  assert.match(enquiriesPage, /api\/spc\/enquiries\?limit=200&bootstrap=1/)
  assert.match(enquiriesPage, /data\.sessionKey\?\.toLowerCase\(\) !== username\.toLowerCase\(\)/)
  assert.match(enquiriesPage, /setEnquiries\(\[\]\)/)
  assert.match(route, /resolveSpcEnquiryScope\([\s\S]*?searchParams\.get\("scope"\)/)
  assert.match(route, /createdByUsername = sharedScope \|\| recordsScope \? undefined : session\.username/)
  assert.match(enquiriesStore, /query = query\.eq\("created_by_username", options\.createdByUsername\)/)
})

test("SPC Speed Board continues to use the shared enquiry feed", () => {
  assert.match(speedBoard, /api\/spc\/enquiries\?limit=250&scope=shared&createdAfter=/)
  assert.match(route, /hasSpcPagePermission\(session, "spc-chrome-extension", "view"\)/)
})

test("SPC forced-password sessions render the password form without a route transition", () => {
  const navigationShell = readFileSync(
    new URL("../components/SpcNavigationShell.tsx", import.meta.url),
    "utf8",
  )
  const passwordChange = readFileSync(
    new URL("../components/SpcForcedPasswordChange.tsx", import.meta.url),
    "utf8",
  )
  assert.match(navigationShell, /if \(mustChangePassword\) return <SpcForcedPasswordChange \/>/)
  assert.doesNotMatch(navigationShell, /Loading password change/)
  assert.match(passwordChange, /fetch\("\/api\/spc\/password"/)
  assert.match(passwordChange, /mustChangePassword: false/)
  assert.match(passwordChange, /router\.replace\("\/spc"\)/)
})

test("SPC enquiry send failures are visible to the user", () => {
  assert.match(enquiriesPage, /setSendError\(error instanceof Error \? error\.message/)
  assert.match(enquiriesPage, /role="alert"/)
})

test("SPC enquiry clear action sits inside the parser box", () => {
  assert.match(
    enquiriesPage,
    /className="spc-enquiry-raw-control"[\s\S]*?<textarea[\s\S]*?className="spc-enquiry-clear-button"/,
  )
  assert.match(
    globalStyles,
    /\.spc-enquiry-clear-button \{[\s\S]*?position: absolute;[\s\S]*?right: 10px;[\s\S]*?bottom: 10px;/,
  )
})

test("SPC Lost Record retains a separately authorized shared record scope", () => {
  assert.match(lostRecordPage, /scope=records/)
  assert.match(route, /hasSpcPagePermission\(session, "spc-lost-record", "view"\)/)
})

test("SPC web outcome, amendment, and reoffer mutations enforce enquiry ownership", () => {
  assert.match(enquiriesStore, /function requireEnquiryOwner\(row: SpcEnquiryRow, session: SpcSession\)/)
  assert.equal(
    (enquiriesStore.match(/requireEnquiryOwner\(existing, session\)/g) || []).length,
    3,
  )
})

test("SPC cancellation preserves the shared record for Speed Board status updates", () => {
  const outcomeStart = enquiriesStore.indexOf("export async function updateSpcEnquiryOutcome")
  const outcomeEnd = enquiriesStore.indexOf("export async function reofferSpcEnquiry", outcomeStart)
  const outcomeSource = enquiriesStore.slice(outcomeStart, outcomeEnd)

  assert.match(outcomeSource, /outcome === "cancel"[\s\S]*?\? "closed"/)
  assert.match(outcomeSource, /nextMeta\.cancelledAt = now/)
  assert.doesNotMatch(outcomeSource, /\.delete\(\)/)
})
