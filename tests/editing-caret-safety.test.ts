import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const taskCalendarPage = new URL("../app/admin/taskcalendar/page.tsx", import.meta.url)
const fixturesPage = new URL("../app/spc/fixtures/page.tsx", import.meta.url)

test("task calendar keeps the day list as raw text while the user is typing", async () => {
  const page = await readFile(taskCalendarPage, "utf8")

  assert.match(page, /const \[daysOfMonthText, setDaysOfMonthText\] = useState\("1"\)/)
  assert.match(page, /value=\{daysOfMonthText\}[\s\S]*?onChange=\{\(event\) => setDaysOfMonthText\(event\.target\.value\)\}/)
  assert.match(page, /const parsedDaysOfMonth = parseNumberList\(daysOfMonthText, 1, 31\)/)
  assert.doesNotMatch(page, /onChange=\{\(event\) => setDraftTask\([\s\S]{0,160}parseNumberList\(event\.target\.value/)
})

test("fixture numeric editors keep raw input until submit normalization", async () => {
  const page = await readFile(fixturesPage, "utf8")

  assert.match(page, /function updateDraft[\s\S]*?\[key\]: value/)
  assert.match(page, /function gradeNumberCell[\s\S]*?value=\{value\}[\s\S]*?updateGradeDraft/)
  assert.match(page, /function prepareDraftForSubmit[\s\S]*?hsfo: formatQuantityString\(draft\.hsfo\)[\s\S]*?normalized\.price = normalizedGradeField\(draft\.price, activeKeys, true\)/)
  assert.doesNotMatch(page, /onChange=\{\(event\) => updateGradeDraft\([^\n]+formatIntegerString\(event\.target\.value\)/)
})
