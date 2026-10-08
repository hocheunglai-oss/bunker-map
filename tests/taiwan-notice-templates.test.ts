import assert from "node:assert/strict"
import test from "node:test"
import { appendTaiwanNotice, TAIWAN_NOTICE_TEMPLATES, validateTaiwanNoticeDraft } from "../lib/taiwanNoticeTemplates"
import { getTaiwanSpecialNoticeLines } from "../lib/taiwanSpecialNotice"

test("all 18 reference scenarios and the new CPC scenario have unique identities", () => {
  assert.equal(TAIWAN_NOTICE_TEMPLATES.length, 19)
  assert.equal(new Set(TAIWAN_NOTICE_TEMPLATES.map((item) => item.id)).size, 19)
  assert.deepEqual(new Set(TAIWAN_NOTICE_TEMPLATES.map((item) => item.group.split(" · ")[0])),
    new Set(["CPC notice", "Holiday notice", "Oil fence charge", "Hualien", "Kaohsiung", "Keelung", "Suao", "Taichung"]))
})

test("historical dates, charges, and the legacy row-22 instruction are not publishable defaults", () => {
  for (const item of TAIWAN_NOTICE_TEMPLATES.slice(1)) {
    assert.doesNotMatch(item.text, /ROW 22|06\/03\/19|\$178|\$214|\$627|MID OF NOV|EARLY JUL|END OF MAY|27-30 JUN/)
    if (item.text.includes("[")) assert.ok(validateTaiwanNoticeDraft(item.text))
  }
})

test("CPC barge wording reflects limited Kaohsiung capacity, not all deliveries stopped", () => {
  const item = TAIWAN_NOTICE_TEMPLATES[0]
  assert.match(item.text, /KAOHSIUNG/)
  assert.match(item.text, /BAO SHAN NO\. 2/)
  assert.match(item.text, /12 TO 17 OCTOBER 2026/)
  assert.match(item.text, /CAPACITY WILL BE LIMITED/)
  assert.match(item.text, /ARRANGE ORDERS EARLY/)
  assert.doesNotMatch(item.text, /DELIVERY.*SUSPENDED|IFO|MGO|IF180|IF380/)
  assert.equal(validateTaiwanNoticeDraft(item.text), null)
  assert.equal(getTaiwanSpecialNoticeLines(item.text).length, 2)
})

test("placeholder validation rejects blank or incomplete drafts but accepts ordinary brackets", () => {
  assert.ok(validateTaiwanNoticeDraft(" \n"))
  assert.ok(validateTaiwanNoticeDraft("ON DD/MM/YY"))
  assert.ok(validateTaiwanNoticeDraft("FROM [from date] TO [TO DATE]"))
  assert.equal(validateTaiwanNoticeDraft("CPC CLOSED ON 10/10/2026."), null)
  assert.equal(validateTaiwanNoticeDraft("DELIVERY [SUBJECT TO CONFIRMATION]"), null)
})

test("append preserves existing notices, paragraph breaks and separate report lines", () => {
  const current = "EXISTING FIRST NOTICE\n\nEXISTING SECOND NOTICE"
  const draft = "NEW NOTICE\nNEW SECOND LINE"
  const result = appendTaiwanNotice(current, draft)
  assert.equal(result.text, `${current}\n${draft}`)
  assert.equal(result.added, 2)
  assert.deepEqual(getTaiwanSpecialNoticeLines(result.text), ["EXISTING FIRST NOTICE", "EXISTING SECOND NOTICE", "NEW NOTICE", "NEW SECOND LINE"])
})

test("repeated insertion is idempotent, including partial overlaps and duplicates within the draft", () => {
  const first = appendTaiwanNotice("OLD NOTICE", "NEW NOTICE\nNEW NOTICE")
  assert.equal(first.added, 1)
  assert.deepEqual(appendTaiwanNotice(first.text, " old notice \r\nnew notice"), { text: first.text, added: 0 })
  assert.deepEqual(appendTaiwanNotice("ONE\nTWO", "TWO\nTHREE"), { text: "ONE\nTWO\nTHREE", added: 1 })
})
