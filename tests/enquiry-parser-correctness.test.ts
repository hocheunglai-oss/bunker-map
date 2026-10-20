import assert from "node:assert/strict"
import test from "node:test"
import { buildShortenedEnquiry, findEnquiryDates } from "../lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "../lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "../lib/spcEnquiryText"

const tradingLines = "PORT: SINGAPORE\nETA: 12 JUL\nVLSFO 100MT"

function worksheetOutput(raw: string) {
  const guess = parseEnquiryWorksheetGuess(raw)
  return buildShortenedEnquiry(raw, guess.vesselName, guess.imo, [], {
    autoDetectVlsfoRemarks: false, includePort: true, port: guess.port,
  })
}

test("explicit vessel names retain letters that happen to contain fuel/unit abbreviations", () => {
  for (const vessel of ["CALIFORNIA", "CALIFORNIA380", "SAMTONG", "ADMA", "ALPHA", "ALPHA ONE"]) {
    const raw = `VESSEL: ${vessel}\nIMO: 9450674\n${tradingLines}`
    assert.equal(parseEnquiryWorksheetGuess(raw).vesselName, vessel)
    assert.equal(worksheetOutput(raw), `${vessel.toLowerCase()} / 9450674 / singapore 12 jul / vlsfo 100mts`)
  }
})

test("actual compact and standalone fuel/quantity tokens are not vessel names", () => {
  for (const notVessel of ["VLSFO 100MT", "IFO380", "LSMGO50MTS", "100 MTS", "MGO", "L S M G O", "V L S F O 100"]) {
    assert.equal(parseEnquiryWorksheetGuess(`VESSEL: ${notVessel}\nIMO: 9450674\n${tradingLines}`).vesselName, "", notVessel)
  }
})

test("spaced fuel tokens with attached quantity suffixes cannot become vessel names", () => {
  for (const grade of ["V L S F O380", "I F O380", "L S M G O50", "V L S F O 380", "V L S F O", "VLS FO380", "VL SFO380", "I FO380", "VLS FO"]) {
    for (const label of ["", "VESSEL: "]) {
      const raw = `IMO: 9450674\n${label}${grade}\nPORT: SINGAPORE\nETA: 12 JUL`
      assert.equal(parseEnquiryWorksheetGuess(raw).vesselName, "", raw)
    }
  }
})

test("contact and reference numbers cannot replace an explicit invalid IMO or labelled vessel", () => {
  for (const label of ["TEL:", "Tel.:", " telephone :", "FAX:", "Fax /", "Phone:", "Mobile:", "Reference:", "REF.:", "Our Ref.:", "Your reference:", "Reference No.:", "Contact:"]) {
    const raw = `VESSEL: ALPHA\nIMO: 9450670\n${label} 9450674\n${tradingLines}`
    const guess = parseEnquiryWorksheetGuess(raw)
    assert.equal(guess.vesselName, "ALPHA", label)
    assert.equal(guess.imo, "", label)
    assert.equal(guess.confidence, "medium", label)
    assert.ok(guess.warnings.some(warning => warning.includes("9450670") && warning.includes("failed")), label)
    assert.equal(worksheetOutput(raw), "alpha / singapore 12 jul / vlsfo 100mts", label)
  }
})

test("contact/reference-only numbers remain absent when no IMO is supplied", () => {
  for (const label of ["TEL:", "Tel.:", "Fax:", "Phone:", "Reference:", "Reference number:"]) {
    const guess = parseEnquiryWorksheetGuess(`VESSEL: ALPHA\n${label} 9450674\n${tradingLines}`)
    assert.equal(guess.vesselName, "ALPHA", label)
    assert.equal(guess.imo, "", label)
  }
})

test("explicit IMO context wins without losing valid later labels or supported adjacent numbers", () => {
  const cases = [
    { raw: `VESSEL: ALPHA\nIMO: 9450670\nIMO No.: 9450674\n${tradingLines}`, imo: "9450674" },
    { raw: `VESSEL: ALPHA\nIMO: 9450674\nIMO: 9450670\n${tradingLines}`, imo: "9450674" },
    { raw: `VESSEL: ALPHA\nIMO: 9450670\nInternal number: 9450674\n${tradingLines}`, imo: "" },
    { raw: `VESSEL: ALPHA\nIMO:\n9450674\nTel.: 1094644\n${tradingLines}`, imo: "9450674" },
    { raw: `VESSEL: ALPHA\nimo no. : 9450674\nReference: 1094644\n${tradingLines}`, imo: "9450674" },
    { raw: `VESSEL: ALPHA\nTEL: 9450674 | IMO: 1094644\n${tradingLines}`, imo: "1094644" },
    { raw: `VESSEL: ALPHA\nIMO: 9450670; TEL: 9450674\n${tradingLines}`, imo: "" },
    { raw: `TEL: 9450674\nALPHA (9450674) / SINGAPORE / 12 JUL / VLSFO 100MT`, imo: "9450674" },
    { raw: `ALPHA (9450674) / SINGAPORE / 12 JUL / VLSFO 100MT`, imo: "9450674" },
  ]
  for (const { raw, imo } of cases) {
    const guess = parseEnquiryWorksheetGuess(raw)
    assert.equal(guess.vesselName, "ALPHA", raw)
    assert.equal(guess.imo, imo, raw)
  }
})

test("fully supplied non-leap dates cannot reappear through yearless fallback patterns", () => {
  for (const date of [
    "29 FEB 2026", "29 February, 2026", "FEB 29, 2026", "February.29 2026", "29 FEB '2026", "29th of February 2026",
    "29/02/2026", "02/29/2026", "29.02.2026", "2026-02-29", "2026/02/29", "2026年2月29日", "2026년2월29일",
    "29 FEB 1900", "29 FEB 2100", "31 APR 2026", "2026-04-31",
  ]) {
    assert.deepEqual(findEnquiryDates(date), [], date)
    const raw = `VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: ${date}\nVLSFO 100MT`
    assert.equal(worksheetOutput(raw), "alpha / 9450674 / singapore / vlsfo 100mts", date)
  }
})

test("valid supplied leap years and existing yearless/two-digit-year dates are preserved", () => {
  for (const date of ["29 FEB 2028", "29th of February 2028", "FEB 29, 2028", "29/02/2028", "02/29/2028", "2028-02-29", "2028年2月29日", "29 FEB 2000", "29 FEB", "29 FEB 26"]) {
    assert.ok(findEnquiryDates(date).includes("29 feb"), date)
  }
})

test("a four-digit fuel quantity following a yearless date is not a supplied year", () => {
  for (const suffix of ["1000 MT VLSFO", "1000MT VLSFO", "1001MT VLSFO", "1000 mts vlsfo", "1000 MTS VLSFO", "1000 tons VLSFO", "1000 CBM VLSFO", "1000 KL VLSFO"]) {
    assert.ok(findEnquiryDates(`29 FEB ${suffix}`).includes("29 feb"), suffix)
    assert.ok(findEnquiryDates(`FEB 29 ${suffix}`).includes("29 feb"), suffix)
    assert.ok(findEnquiryDates(`28-29 FEB ${suffix}`).includes("28 - 29 feb"), suffix)
    assert.ok(findEnquiryDates(`12 JUL ${suffix}`).includes("12 jul"), suffix)
    assert.ok(parseSpcEnquiryText(`VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB ${suffix}`).standardText.toLowerCase().includes("29 feb"), suffix)
  }
  assert.deepEqual(findEnquiryDates("29 FEB 1000"), [])
  assert.deepEqual(findEnquiryDates("29 FEB 2026"), [])
  assert.deepEqual(findEnquiryDates("1000-02-29 MT VLSFO"), [])
  assert.deepEqual(findEnquiryDates("29 FEB 2026\nQUANTITY: 1000 MT VLSFO"), [])
  assert.deepEqual(findEnquiryDates("29 FEB 2026, 1000 MT VLSFO"), [])
})

test("line-wrapped quantity units do not turn a yearless date into an invalid supplied year", () => {
  for (const newline of ["\n", "\r\n"]) {
    for (const suffix of [`1000${newline}MT VLSFO`, `1000${newline}MT${newline}VLSFO`]) {
      assert.deepEqual(findEnquiryDates(`29 FEB ${suffix}`), ["29 feb"], suffix)
      assert.deepEqual(findEnquiryDates(`FEB 29 ${suffix}`), ["29 feb"], suffix)
      assert.ok(findEnquiryDates(`28-29 FEB ${suffix}`).includes("28 - 29 feb"), suffix)
      const raw = `VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}ETA: 29 FEB ${suffix}`
      // Preserve existing date output without adding unsupported split-line fuel formatting.
      assert.equal(worksheetOutput(raw), "alpha / 9450674 / singapore 29 feb", suffix)
    }
    for (const suffix of [`2026${newline}VLSFO 100MT`, `2026${newline}QUANTITY: 1000 MT VLSFO`]) {
      assert.deepEqual(findEnquiryDates(`29 FEB ${suffix}`), [], suffix)
      const raw = `VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}ETA: 29 FEB ${suffix}`
      assert.equal(worksheetOutput(raw), `alpha / 9450674 / singapore / vlsfo ${suffix.includes("QUANTITY:") ? "1,000" : "100"}mts`, suffix)
    }
    assert.deepEqual(findEnquiryDates(`2026-02-29${newline}MT VLSFO`), [])
    assert.equal(worksheetOutput(`VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}ETA: 2026-02-29${newline}MT VLSFO`), "alpha / 9450674 / singapore")
    assert.deepEqual(findEnquiryDates(`1000-02-29${newline}MT VLSFO`), [])
    assert.deepEqual(findEnquiryDates(`29 FEB 1000${newline}VLSFO`), [])
    assert.ok(!worksheetOutput(`VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}ETA: 29 FEB 1000${newline}VLSFO`).includes("29 feb"))
    assert.deepEqual(findEnquiryDates(`29 FEB 2028${newline}VLSFO 100MT`), ["29 feb"])
    assert.equal(worksheetOutput(`VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}ETA: 29 FEB 2028${newline}VLSFO 100MT`), "alpha / 9450674 / singapore 29 feb / vlsfo 100mts")
    assert.equal(worksheetOutput(`VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}ETA: 29 FEB 1000${newline}MT VLSFO${newline}ETD: 1 MAR 2026`), "alpha / 9450674 / singapore eta 29 feb, etd 1 mar")
    // These direct-helper controls do not broaden preexisting worksheet line selection.
    assert.deepEqual(findEnquiryDates(`29 FEB${newline}2026${newline}VLSFO 100MT`), [])
    assert.deepEqual(findEnquiryDates(`29 FEB${newline}2028${newline}VLSFO 100MT`), ["29 feb"])
  }
})

test("quantity-unit date context preserves continuation line ports, dates and schedule labels", () => {
  const portNames = ["SINGAPORE", "ROTTERDAM"]
  for (const newline of ["\n", "\r\n"]) {
    for (const [schedule, expected] of [
      [`ETA: 12 JUL 1000${newline}MT ROTTERDAM 13 JUL`, "alpha / 9450674 / rotterdam 13 jul"],
      [`ETA: 1000${newline}MT 12 JUL`, "alpha / 9450674 / singapore"],
      [`DELIVERY: 1000${newline}MT 12 JUL`, "alpha / 9450674 / singapore"],
    ]) {
      const raw = `VESSEL: ALPHA${newline}IMO: 9450674${newline}PORT: SINGAPORE${newline}${schedule}`
      const guess = parseEnquiryWorksheetGuess(raw, { portNames })
      assert.equal(buildShortenedEnquiry(raw, guess.vesselName, guess.imo, [], {
        autoDetectVlsfoRemarks: false, includePort: true, port: guess.port, portNames,
      }), expected, schedule)
    }
  }
})

test("supplied-year range validation preserves valid ranges but not invalid endpoint fallback", () => {
  for (const date of ["28-29 FEB 2026", "28th-29th of FEB 2026", "FEB 28-29, 2026", "28 FEB 2026 - 29 FEB 2026", "28/02/2026 - 29/02/2026", "2026-02-28 - 2026-02-29", "2026年2月28日-2月29日"]) {
    assert.deepEqual(findEnquiryDates(date), [], date)
  }
  for (const date of ["28-29 FEB 2028", "28th-29th of FEB 2028", "FEB 28-29, 2028", "28 FEB 2028 - 29 FEB 2028", "28/02/2028 - 29/02/2028", "2028年2月28日-2月29日", "28-29 FEB"]) {
    assert.ok(findEnquiryDates(date).includes("28 - 29 feb"), date)
  }
})

test("invalid supplied-year dates do not erase an independent valid ETA/ETD", () => {
  const dates = findEnquiryDates("ETA: 29 FEB 2026\nETD: 1 MAR 2026")
  assert.deepEqual(dates, ["1 mar"])
  const independentValidSchedule = "VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETD: 1 MAR 2026\nVLSFO 100MT"
  assert.equal(worksheetOutput("VESSEL: ALPHA\nIMO: 9450674\nPORT: SINGAPORE\nETA: 29 FEB 2026\nETD: 1 MAR 2026\nVLSFO 100MT"), worksheetOutput(independentValidSchedule))
})

test("supplied-year dates agree with an independent Gregorian calendar across month/century boundaries", () => {
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
  for (const year of [1900, 2000, 2024, 2026, 2028, 2100]) {
    for (const [index, month] of months.entries()) for (let day = 0; day <= 32; day += 1) {
      const calendar = new Date(Date.UTC(year, index, day))
      const valid = calendar.getUTCFullYear() === year && calendar.getUTCMonth() === index && calendar.getUTCDate() === day
      for (const input of [`${day} ${month} ${year}`, `${month} ${day}, ${year}`, `${year}-${index + 1}-${day}`]) {
        const dates = findEnquiryDates(input)
        if (valid) assert.ok(dates.includes(`${day} ${month}`), input)
        else assert.deepEqual(dates, [], input)
      }
    }
  }
})
