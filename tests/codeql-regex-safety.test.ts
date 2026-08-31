import assert from "node:assert/strict"
import test from "node:test"
import { isValidEmailAddress, normalizeEmailList } from "@/lib/emailAddress"
import { slugifyEmailTemplate } from "@/lib/emailTemplateSlug"
import { safeFileName } from "@/lib/spcPresentation"

test("presentation filenames and template slugs preserve normal output without ambiguous edge trimming", () => {
  assert.equal(safeFileName("Quarterly Update FINAL!!.MP4"), "quarterly-update-final.mp4")
  assert.equal(safeFileName("Demo.Final.V1.WEBM"), "demo-final-v1.webm")
  assert.equal(safeFileName(".WAV"), "media.wav")
  assert.equal(slugifyEmailTemplate("  Marine / Operations — Daily  "), "marine-operations-daily")

  const longPunctuation = "-".repeat(120_000)
  assert.equal(safeFileName(`${longPunctuation}Quarterly${longPunctuation}.MP4`), "quarterly.mp4")
  assert.equal(slugifyEmailTemplate(`${longPunctuation}${"A".repeat(120)}${longPunctuation}`), "a".repeat(80))

  assert.doesNotMatch(safeFileName.toString(), /\^-\+\|-\+\$/)
  assert.doesNotMatch(slugifyEmailTemplate.toString(), /\^-\+\|-\+\$/)
})

test("email normalization preserves display-name extraction, lowercasing, ordering, and deduplication", () => {
  assert.deepEqual(
    normalizeEmailList([
      "Alice Example <ALICE.Example@Example.COM>",
      "alice.example@example.com",
      "Operations <ops+alerts@sub.example.co.uk>",
      "not-an-email",
    ]),
    ["alice.example@example.com", "ops+alerts@sub.example.co.uk"],
  )

  assert.deepEqual(
    normalizeEmailList("first@example.com; SECOND@EXAMPLE.COM\nThird Person <third@example.net>"),
    ["first@example.com", "second@example.com", "third@example.net"],
  )
})

test("email normalization rejects long adversarial non-addresses without backtracking regexes", () => {
  const longDots = ".".repeat(120_000)
  const longAtRun = "@".repeat(120_000)

  assert.deepEqual(
    normalizeEmailList([
      `Display <a@${longDots} >`,
      `a@${longDots} invalid`,
      `local${longAtRun}example.com`,
    ]),
    [],
  )

  assert.doesNotMatch(normalizeEmailList.toString(), /\.match\(\/<\(/)
  assert.doesNotMatch(normalizeEmailList.toString(), /\^\[\^\\s@\]\+@/)
})

test("single email validation is bounded and rejects list or display-name input", () => {
  assert.equal(isValidEmailAddress("identity@example.com"), true)
  assert.equal(isValidEmailAddress("Identity <identity@example.com>"), false)
  assert.equal(isValidEmailAddress("one@example.com;two@example.com"), false)
  assert.equal(isValidEmailAddress(`a@${".".repeat(120_000)}`), false)
})
