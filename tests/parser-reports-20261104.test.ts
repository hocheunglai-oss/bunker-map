import assert from "node:assert/strict"
import test from "node:test"
import { buildShortenedEnquiry, findEnquiryDates } from "../lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "../lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "../lib/spcEnquiryText"

function worksheet(raw: string, manual: Array<"180cst max"> = [], suppliedImo = "") {
  const guess = parseEnquiryWorksheetGuess(raw)
  return buildShortenedEnquiry(raw, guess.vesselName, suppliedImo || guess.imo, manual, {
    autoDetectVlsfoRemarks: false, includePort: true, port: guess.port,
  })
}

test("Macau Star report: recover the split ordinal within an explicit date range", () => {
  const raw = "[3:28 PM, 9/1/2026] CHENGYUAN LI: Client: Jinwei Engineering\n[3:28 PM, 9/1/2026] CHENGYUAN LI: Macau Star / IMO: 9947897 / ETA  8th sep\uff0d1 3th sep SGP/ LSMGO 210 -  260MT"
  assert.equal(worksheet(raw), "macau star / 9947897 / singapore 8 - 13 sep / lsmgo 210-260mts")
  assert.equal(parseSpcEnquiryText(raw).standardText, "MACAU STAR (9947897) / SG / 8 - 13 SEP / 210-260 MT LSMGO (0.1%)")
  for (const value of ["8th sep-1 3th sep", "8 SEP - 1 3TH SEPTEMBER", "8 sep-1 3th sep 2026"]) {
    assert.equal(findEnquiryDates(value)[0], "8 - 13 sep", value)
  }
})

test("Chemical Marketer report: remove vessel type annotations before the IMO", () => {
  const raw = "M/T CHEMICAL MARKETER (Chemical tanker, IMO: 9304291) / HONGKONG / 19-22 SEP / VLSFO 220-260MT LSMGO 50-70MT"
  assert.equal(worksheet(raw), "chemical marketer / 9304291 / hk 19 - 22 sep / vlsfo 220-260mts / lsmgo 50-70mts")
  assert.equal(parseSpcEnquiryText(raw).vesselName, "CHEMICAL MARKETER")
  for (const type of ["Chemical tanker", "Bulk carrier", "Product tanker"]) {
    assert.equal(parseEnquiryWorksheetGuess(raw.replace("Chemical tanker", type)).vesselName, "CHEMICAL MARKETER")
  }
  assert.equal(parseEnquiryWorksheetGuess(raw.replace("Chemical tanker", "EX SUNRISE")).vesselName, "CHEMICAL MARKETER (EX SUNRISE")
})

test("Southern Narwhal report: preserve quantities after parenthesized sulphur specs", () => {
  const raw = "Vessel   : MT Southern Narwhal\nPort     : Pusan, Korea\nETA     : 09th Oct 2026 (Bunkering call)\nGrade   : VLSFO(0.5% Max) 300mt // LSMGO(0.1% Max) 110mt\n\nPhysical: SK or S-oil only (pls indicate the name with your offer)\n\ncould you also provide us with the COQ in advance? thank you"
  assert.equal(worksheet(raw), "southern narwhal / busan 9 oct / vlsfo 300mts / lsmgo 110mts")
  // The approved IMO came from lookup; the deterministic parser must not invent it.
  assert.equal(parseEnquiryWorksheetGuess(raw).imo, "")
  assert.equal(worksheet(raw, [], "9715995"), "southern narwhal / 9715995 / busan 9 oct / vlsfo 300mts / lsmgo 110mts")
  const spc = parseSpcEnquiryText(raw)
  assert.equal(spc.vlsfo, "300mts")
  assert.equal(spc.lsmgo, "110mts")
})

test("Heng Yuan Fa Zhan report: explicit month-first range beats the current month", () => {
  const raw = "Heng Yuan Fa Zhan (IMO 9998690) / Singapore ETA Oct-7-14th / VLSFO180cst 150-250mt"
  assert.equal(worksheet(raw), "heng yuan fa zhan / 9998690 / singapore 7 - 14 oct / vlsfo 150-250mts")
  assert.equal(worksheet(raw, ["180cst max"]), "heng yuan fa zhan / 9998690 / singapore 7 - 14 oct / vlsfo 180CST MAX 150-250mts")
  assert.equal(parseSpcEnquiryText(raw, ["180cst max"]).eta, "7 - 14 oct")
  for (const value of ["Oct-7-14th", "OCT.7-14", "October/7-14th", "Oct 7-14th"]) {
    assert.equal(findEnquiryDates(value)[0], "7 - 14 oct", value)
  }
  assert.deepEqual(findEnquiryDates("Feb-28-29th 2026"), [])
})

test("Melody Selmer report: recognize a port after At: without a dynamic index", () => {
  const raw = "Melody Selmer - IMO 9609720\nAt: Pasir Gudang\nEta: 16th - 26th October 2026\n400 - 500 mts VLSFO RMG 380 max Sulphur 0,5%"
  assert.equal(worksheet(raw), "melody selmer / 9609720 / pasir gudang 16 - 26 oct / vlsfo 400-500mts")
  assert.equal(parseSpcEnquiryText(raw).port, "PASIR GUDANG")
  assert.equal(parseEnquiryWorksheetGuess(raw.replace("At: Pasir Gudang", "At: 16th October")).port, "")
})

test("Jonathan Star SPC report: a sulphur-only repeat cannot take the next product's quantity", () => {
  const raw = "VESSEL: JONATHAN STAR\nIMO: 8223311\nACCT: ALBA SHIPPING (PANAMA) INC\nE.T.A.: 22 September 2026\nPORT: SINGAPORE Bunkers Only\nAGENTS: S5\nQTY: 392 MTNS\nPROD: 380 CST - RMG 380 VLSFO\nSPEC: ISO 8217:2010 RMG 380\nVLSFO MAX 0.5% SULF\nQTY: 8 MTNS (or advise minimum)\nPROD: MARINE GAS OIL\nSPEC: ISO 8217:2010 DMA\nMAX .10% SULF"
  assert.equal(parseSpcEnquiryText(raw).standardText, "JONATHAN STAR (8223311) / SG / 22 SEP / 392 MT VLSFO (0.5%) / 8 MT LSMGO (0.1%)")
  assert.equal(worksheet(raw), "jonathan star / 8223311 / singapore 22 sep / vlsfo 392mts / lsmgo 8mts")
})
