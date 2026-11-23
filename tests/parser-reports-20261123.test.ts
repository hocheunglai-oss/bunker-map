import assert from "node:assert/strict"
import test from "node:test"
import { buildShortenedEnquiry } from "../lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "../lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "../lib/spcEnquiryText"

import cases from "./fixtures/parser-reports-20261123.cjs"

for (const item of cases) {
  test(`November 23 report: ${item.vessel}, raw and worksheet-cleaned input`, () => {
    for (const input of [item.raw, item.cleaned]) {
      const guess = parseEnquiryWorksheetGuess(input)
      assert.equal(guess.vesselName, item.vessel)
      assert.equal(guess.port, item.port)
      assert.equal(guess.imo, item.lookup ? "" : item.imo)
      assert.equal(buildShortenedEnquiry(input, guess.vesselName, item.imo, [], {
        autoDetectVlsfoRemarks: false, includePort: true, port: guess.port,
      }), item.expected)
      const spc = parseSpcEnquiryText(input)
      assert.equal(spc.vesselName, item.vessel)
      assert.equal(spc.port, item.port.toUpperCase())
    }
  })
}

test("email signoffs cannot become vessel names when no vessel was supplied", () => {
  const input = "IMO: 9594573\nBunkering Port: Gibraltar\nHSFO 100MT\nETA: 28 Nov\nBrgds / Example Contact"
  assert.equal(parseEnquiryWorksheetGuess(input).vesselName, "")
})

test("a parenthesized note is removed only from an otherwise exact standalone port", () => {
  assert.equal(parseEnquiryWorksheetGuess("TS HONG KONG (SLA)\nPort: Busan\nETA: 22 Nov\nVLSFO 100MT").port, "busan")
  assert.equal(parseEnquiryWorksheetGuess("Hong Kong (SLA)\nETA: 22 Nov\nVLSFO 100MT").port, "hong kong")
  assert.equal(parseEnquiryWorksheetGuess("Shanghai (Wai Gao Qiao)\nETA: 22 Nov\nVLSFO 100MT").port, "shanghai (wai gao qiao)")
})
