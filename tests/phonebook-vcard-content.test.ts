import assert from "node:assert/strict"
import test from "node:test"
import * as library from "../lib/phonebookCarddav"
const contact = { id: "00000000-0000-4000-8000-000000000001", full_name: "SYNTHETIC CONTACT", company: "SYNTHETIC COMPANY", company_phone: "+000-000-0001", company_other_name: null, title: null, position: "SYNTHETIC POSITION", department: null, direct_line: null, mobile_1: "+000-000-0000", mobile_2: null, personal_email: "synthetic@example.invalid", general_email: null, private_email: null, notes: "One; two, three\\four\nfive" }
const card = library.buildVCard(contact)
const status = (actual: string, expected = card) => library.compareManagedVCard(expected, actual).status

for (const [name, before, after] of [
  ["FN", "FN:SYNTHETIC CONTACT", "FN:DIFFERENT"], ["N", "N:SYNTHETIC CONTACT;;;;", "N:DIFFERENT;;;;"],
  ["ORG", "ORG:SYNTHETIC COMPANY", "ORG:DIFFERENT"], ["TITLE", "TITLE:SYNTHETIC POSITION", "TITLE:DIFFERENT"],
  ["TEL", "+000-000-0000", "+000-000-9999"], ["EMAIL", "synthetic@example.invalid", "different@example.invalid"],
  ["UID", "UID:bunker-map-", "UID:other-"], ["ID", "X-BUNKER-MAP-CONTACT-ID:00000000", "X-BUNKER-MAP-CONTACT-ID:ffffffff"],
  ["HASH", "X-BUNKER-MAP-SYNC-HASH:", "X-BUNKER-MAP-SYNC-HASH:changed"], ["NOTE", "NOTE:One", "NOTE:Changed"], ["CATEGORIES", "CATEGORIES:BUNKER MAP", "CATEGORIES:OTHER"],
]) test(`changed controlled ${name} never verifies`, () => assert.equal(status(card.replace(before, after)), "different"))

test("the exact generated card verifies", () => assert.equal(status(card), "match"))
test("line reordering, CRLF/LF, REV and PRODID are harmless", () => {
  const lines = card.trimEnd().split("\r\n")
  const changed = [lines[0], ...lines.slice(1, -1).reverse(), "X-ANY-PROVIDER:ignored", lines.at(-1), ""].join("\n").replace(/REV:[^\n]+/, "REV:20300101T000000Z").replace(/PRODID:[^\n]+/, "PRODID:PROVIDER")
  assert.equal(status(changed), "match")
})
test("folding all identity and contact values is harmless", () => assert.equal(status(card.replace(/(:(?:[^\r\n]{10}))/g, "$1\r\n ")), "match"))
test("case, quote, duplicate and repeated TYPE declarations normalize", () => assert.equal(status(card.replace(/TEL;TYPE=WORK:/, 'item1.tel;TYPE="work";type=WORK:')), "match"))
test("TYPE comma order and repeated lists normalize without dropping semantic types", () => {
  const expected = card.replace("TEL;TYPE=WORK:", "TEL;TYPE=WORK,VOICE:")
  assert.equal(status(card.replace("TEL;TYPE=WORK:", 'TEL;TYPE="voice";TYPE="work":'), expected), "match")
  assert.equal(status(card.replace("TEL;TYPE=WORK:", "TEL;TYPE=WORK,VOICE:")), "different")
})
test("work versus home phone labels remain different", () => assert.equal(status(card.replace("TEL;TYPE=WORK:", "TEL;TYPE=HOME:")), "different"))
test("same digits with different spacing are not silently treated as proof", () => assert.equal(status(card.replace("+000-000-0000", "+000 000 0000")), "different"))
test("N absent trailing empty components and ORG trailing empties normalize", () => assert.equal(status(card.replace("N:SYNTHETIC CONTACT;;;;", "N:SYNTHETIC CONTACT").replace("ORG:SYNTHETIC COMPANY", "ORG:SYNTHETIC COMPANY;;")), "match"))
test("escaped punctuation preserves structured name boundaries", () => {
  const expected = library.buildVCard({ ...contact, full_name: "ONE;TWO" })
  assert.equal(status(expected.replace("N:ONE\\;TWO;;;;", "N:ONE;TWO;;;"), expected), "different")
})
test("Unicode canonically equivalent NFC/NFD is harmless", () => {
  const expected = library.buildVCard({ ...contact, full_name: "CAFÉ" })
  assert.equal(status(expected.replaceAll("CAFÉ", "CAFE\u0301"), expected), "match")
})
test("escaped newline case is harmless, literal backslash N is not a newline", () => {
  assert.equal(status(card.replace("\\nfive", "\\Nfive")), "match")
  const expected = library.buildVCard({ ...contact, notes: "literal\\Name" })
  assert.equal(status(expected.replace("literal\\\\Name", "literal\\\\name"), expected), "different")
})
test("explicit default VALUE/UTF8 declaration is harmless", () => assert.equal(status(card.replace("FN:", 'FN;VALUE="text";CHARSET=utf-8:')), "match"))
test("extra or removed actual email endpoint is a mismatch", () => {
  assert.equal(status(card.replace("END:VCARD", "EMAIL;TYPE=HOME:extra@example.invalid\r\nEND:VCARD")), "different")
  assert.equal(status(card.replace("EMAIL;TYPE=WORK:synthetic@example.invalid\r\n", "")), "different")
})
test("exact duplicate phone endpoint deduplication is harmless", () => assert.equal(status(card.replace("END:VCARD", "TEL;TYPE=CELL:+000-000-0000\r\nEND:VCARD")), "match"))
test("duplicate required fields or identity markers are unsupported, not certified", () => {
  for (const extra of ["FN:WRONG", "UID:wrong", "X-BUNKER-MAP-CONTACT-ID:wrong", "X-BUNKER-MAP-SYNC-HASH:wrong"]) assert.equal(status(card.replace("END:VCARD", extra + "\r\nEND:VCARD")), "unsupported")
})
test("unknown encoding, charset, language and version are explicit unsupported cases", () => {
  for (const head of ["FN;ENCODING=QUOTED-PRINTABLE:", "FN;CHARSET=ISO-8859-1:", "FN;LANGUAGE=en:"]) assert.equal(status(card.replace("FN:", head)), "unsupported")
  assert.equal(status(card.replace("VERSION:3.0", "VERSION:4.0")), "unsupported")
})
test("malformed, nested, oversized, control and missing-version shapes are unsupported", () => {
  for (const malformed of [card + card, card.replace("END:VCARD", "BEGIN:VCARD\r\nEND:VCARD"), card.replace("VERSION:3.0\r\n", ""), "a".repeat(1_000_001), card.replace("FN:", "FN:\0"), card.replace("NOTE:", "NOTE:\\q")]) assert.equal(status(malformed), "unsupported")
})
test("comparison output never includes private field values", () => assert.ok(!JSON.stringify(library.compareManagedVCard(card, card.replace("FN:SYNTHETIC CONTACT", "FN:PRIVATE SECRET"))).includes("PRIVATE SECRET")))
