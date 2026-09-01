import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { getTaiwanSpecialNoticeLines } from "@/lib/taiwanSpecialNotice"

const reportSource = readFileSync(
  new URL("../app/reports/taiwan/TaiwanReportClient.tsx", import.meta.url),
  "utf8",
)

const editorSource = readFileSync(
  new URL("../app/admin/taiwanremarks/page.tsx", import.meta.url),
  "utf8",
)

function specialNoticeBlock() {
  const start = reportSource.indexOf("{specialNoticeLines.length > 0 && (")
  assert.notEqual(start, -1, "Taiwan report must keep an explicit non-empty notice gate")

  const end = reportSource.indexOf("\n\n        <div style={{ ...cardStyle", start)
  assert.notEqual(end, -1, "Taiwan report special-notice block must remain identifiable")

  return reportSource.slice(start, end)
}

test("Taiwan special notice renders only its non-empty entered lines", () => {
  const notice = specialNoticeBlock()

  assert.deepEqual(
    getTaiwanSpecialNoticeLines("  FIRST NOTICE  \n\n SECOND NOTICE\r\n"),
    ["FIRST NOTICE", "SECOND NOTICE"],
  )
  assert.match(
    reportSource,
    /const specialNoticeLines = getTaiwanSpecialNoticeLines\(specialNotice\)/,
  )
  assert.match(notice, /specialNoticeLines\.map\(\(line, index\) =>/)
  assert.match(notice, /\{line\}/)
  assert.doesNotMatch(notice, /whiteSpace:\s*"nowrap"/)
})

test("Taiwan special notice remains hidden when it is empty", () => {
  const notice = specialNoticeBlock()

  assert.deepEqual(getTaiwanSpecialNoticeLines(" \n\n \r\n"), [])
  assert.match(notice, /^\{specialNoticeLines\.length > 0 && \(/)
})

test("Taiwan remarks editor preserves internal newlines when saving the notice", () => {
  assert.match(editorSource, /\{ id: 2, content: specialNotice\.trim\(\) \}/)
  assert.match(editorSource, /value=\{specialNotice\}/)
})
