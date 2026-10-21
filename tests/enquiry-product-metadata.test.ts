import assert from "node:assert/strict"
import test from "node:test"
import { buildShortenedEnquiry } from "../lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "../lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "../lib/spcEnquiryText"

const header = "IMO: 9450674\nPORT: SINGAPORE\nETA: 12 JUL"

function outputs(raw: string) {
  const guess = parseEnquiryWorksheetGuess(raw)
  return {
    worksheet: buildShortenedEnquiry(raw, guess.vesselName, guess.imo, [], {
      autoDetectVlsfoRemarks: false, includePort: true, port: guess.port,
    }),
    spc: parseSpcEnquiryText(raw),
  }
}

for (const metadata of [
  "VESSEL: IFO380", "VESSEL: IFO 380", "VESSEL:\nIFO380", "Vessel\nIFO380",
  "Vessel name: IFO380", "vsl: IFO380", "SHIP NAME: IFO380",
  "REFERENCE: IFO380", "COMPANY: IFO380", "BUYER: IFO380", "AGENT: IFO380",
  "VESSEL: I F O380", "VESSEL: HSFO380", "VESSEL: MGO50", "VESSEL: VLSFO380",
]) {
  test(`metadata-only grade cannot become a fuel quantity: ${JSON.stringify(metadata)}`, () => {
    const raw = `${metadata}\n${header}\nVLSFO 100MT`
    const { worksheet, spc } = outputs(raw)
    assert.doesNotMatch(worksheet, /(?:HSFO 380mts|lsmgo 50mts|vlsfo 380mts)/i)
    assert.equal(spc.hsfo, "")
    assert.equal(spc.lsmgo, "")
    assert.equal(spc.vlsfo, "100mts")
  })
}

test("the retained exact metadata RED is corrected without naming an invalid vessel", () => {
  const raw = `VESSEL: IFO380\n${header}\nVLSFO 100MT`
  const { worksheet, spc } = outputs(raw)
  assert.equal(parseEnquiryWorksheetGuess(raw).vesselName, "")
  assert.equal(worksheet, "9450674 / singapore 12 jul / vlsfo 100mts")
  assert.equal(spc.hsfo, "")
  assert.equal(spc.vlsfo, "100mts")
})

test("CRLF metadata is not a 380-tonne request", () => {
  const raw = `VESSEL: IFO380\n${header}\nVLSFO 100MT`.replaceAll("\n", "\r\n")
  assert.equal(outputs(raw).worksheet, "9450674 / singapore 12 jul / vlsfo 100mts")
})

test("metadata is excluded without consuming a later genuine HSFO order", () => {
  const { worksheet, spc } = outputs(`VESSEL: IFO380\n${header}\nIFO380 95MT\nVLSFO 100MT`)
  assert.equal(worksheet, "9450674 / singapore 12 jul / HSFO 95mts / vlsfo 100mts")
  assert.equal(spc.hsfo, "95mts")
  assert.equal(spc.vlsfo, "100mts")
})

test("excluded metadata remains a boundary between an older quantity and a later grade", () => {
  const { worksheet, spc } = outputs(`VESSEL: ALPHA\n${header}\n100MT\nREFERENCE: IFO380\nVLSFO`)
  assert.doesNotMatch(worksheet, /(?:HSFO|vlsfo) (?:100|380)mts/i)
  assert.equal(spc.hsfo, "")
  assert.equal(spc.vlsfo, "")
})

test("filtering a wrapped metadata value does not rewrite the preserved raw text", () => {
  const raw = `VESSEL:\nIFO380\n${header}\nVLSFO 100MT`
  assert.equal(outputs(raw).spc.rawText, raw)
})

for (const separator of [" / ", "; ", " | ", ", "]) {
  test(`a separated request survives an unrelated metadata grade: ${JSON.stringify(separator)}`, () => {
    const raw = `VESSEL: IFO380${separator}VLSFO 100MT\n${header}`
    assert.doesNotMatch(outputs(raw).worksheet, /HSFO 380mts/i)
    assert.equal(outputs(raw).spc.vlsfo, "100mts")
    assert.equal(outputs(raw).spc.hsfo, "")
  })
}

for (const request of [
  "IFO380 100MT", "PRODUCT: IFO380\nQUANTITY: 100MT", "IFO380\n100MT",
  "100MT IFO380", "IFO380\n100\nMT", "VLSFO 1000\nMT",
]) {
  test(`actual request/quantity continuation is retained: ${JSON.stringify(request)}`, () => {
    const { worksheet, spc } = outputs(`VESSEL: ALPHA\n${header}\n${request}`)
    if (request.startsWith("VLSFO")) {
      assert.equal(spc.vlsfo, "1,000mts")
    } else {
      assert.match(worksheet, /HSFO 100mts/)
      assert.equal(spc.hsfo, "100mts")
    }
  })
}

test("same-line quantity clauses retain requests across repeated and mixed delimiters", () => {
  for (const grade of ["VESSEL: IFO380", "VESSEL:\nIFO380"]) {
    for (const separator of [" / ", "; ", " | ", ", ", "/;/", "; | , ", " / / ", "; ; "]) {
      for (const label of ["", "Qty:", "QUANTITY:", "qty"]) {
        for (const later of ["", " / VLSFO 20MT"]) {
          const raw = `${grade}${separator}${label}${separator}100MT${later}\n${header}`
          const { worksheet, spc } = outputs(raw)
          assert.match(worksheet, /HSFO 100mts/, raw)
          assert.equal(spc.hsfo, "100mts", raw)
          if (later) assert.equal(spc.vlsfo, "20mts", raw)
        }
      }
    }
  }
})

test("same-line continuation evidence stops at other metadata or a new product", () => {
  for (const separator of [" / ", "; ", " | ", ", ", "/;/", "; | , ", " / / ", "; ; "]) {
    for (const stop of ["IMO: 9450674", "PORT: SINGAPORE", "VLSFO 20MT"]) {
      const raw = `VESSEL: IFO380${separator}QUANTITY:${separator}${stop}\n100MT\n${header}\nVLSFO 20MT`
      assert.doesNotMatch(outputs(raw).worksheet, /HSFO (?:100|380)mts/, raw)
      assert.equal(outputs(raw).spc.hsfo, "", raw)
    }
  }
})

for (const request of [
  "VESSEL: IFO380 / QUANTITY: / 100MT", "VESSEL: IFO380; QTY: ; 100MT",
  "VESSEL: IFO380 / qty / 100MT", "VESSEL: IFO380 / / 100MT",
  "VESSEL: IFO380 / QUANTITY: / 100MT / VLSFO 20MT",
  "VESSEL: IFO380; QTY: ; 100MT / VLSFO 20MT",
  "VESSEL: IFO380 / qty / 100MT / VLSFO 20MT",
]) {
  test(`same-line quantity-prefix clauses are not dropped: ${JSON.stringify(request)}`, () => {
    const { worksheet, spc } = outputs(`${request}\n${header}`)
    assert.match(worksheet, /HSFO 100mts/)
    assert.equal(spc.hsfo, "100mts")
    if (request.includes("VLSFO")) assert.equal(spc.vlsfo, "20mts")
  })
}

for (const stop of ["IMO: 9450674", "PORT: SINGAPORE", "VLSFO 20MT"]) {
  test(`quantity continuation cannot cross a different metadata/product block: ${stop}`, () => {
    const raw = `VESSEL: IFO380\n${stop}\n100MT\n${header}\nVLSFO 20MT`
    assert.doesNotMatch(outputs(raw).worksheet, /HSFO (?:100|380)mts/)
    assert.equal(outputs(raw).spc.hsfo, "")
  })
}

test("continuation evidence stays within the existing five-line bound", () => {
  const raw = `VESSEL: IFO380\na\nb\nc\nd\ne\n100MT\n${header}\nVLSFO 20MT`
  assert.doesNotMatch(outputs(raw).worksheet, /HSFO (?:100|380)mts/)
})

for (const request of ["VESSEL: IFO380\nMT", "VESSEL: IFO380 / MT"]) {
  test(`the existing ambiguous grade/unit-only interpretation is not changed: ${JSON.stringify(request)}`, () => {
    assert.match(outputs(`${request}\n${header}`).worksheet, /HSFO 380mts/)
  })
}

for (const request of [
  "VESSEL: ALPHA / IFO380 100MT", "VESSEL: IFO380 100MT",
  "VESSEL: IFO380\n100MT", "VESSEL:\nIFO380\n100MT",
  "VESSEL: IFO380\n100\nMT", "VESSEL: ALPHA / 100MT IFO380",
  "VESSEL: IFO380 / 100MT", "VESSEL: IFO380; QUANTITY: 100MT",
  "VESSEL: IFO380 / 100MT / VLSFO 20MT",
]) {
  test(`an explicit same-line/wrapped quantity is not removed as metadata: ${JSON.stringify(request)}`, () => {
    const { worksheet, spc } = outputs(`${request}\n${header}`)
    assert.match(worksheet, /HSFO 100mts/)
    assert.equal(spc.hsfo, "100mts")
  })
}

for (const vessel of ["CALIFORNIA380", "ALPHA"]) {
  test(`ordinary vessel naming is unchanged: ${vessel}`, () => {
    const raw = `VESSEL: ${vessel}\n${header}\nVLSFO 100MT`
    assert.equal(outputs(raw).worksheet, `${vessel.toLowerCase()} / 9450674 / singapore 12 jul / vlsfo 100mts`)
  })
}

for (const grade of ["IFO380", "PRODUCT: IFO380"]) {
  test(`existing unquantified grade policy is not changed: ${grade}`, () => {
    assert.equal(outputs(`VESSEL: ALPHA\n${header}\n${grade}`).worksheet,
      "alpha / 9450674 / singapore 12 jul / HSFO 380mts")
  })
}

for (const request of [
  "VESSEL: IFO380\n- 100MT", "VESSEL: IFO380\n* 100MT", "VESSEL: IFO380\n/ 100MT",
  "VESSEL: IFO380\nQty: - 100MT", "VESSEL: IFO380; QUANTITY:\n100MT",
  "VESSEL: IFO380 / 100\nMT",
  "VESSEL: IFO380 / QUANTITY:\n100MT", "VESSEL: IFO380; QUANTITY: 100\nMT",
  "VESSEL: IFO380;\nQUANTITY: 100MT", "VESSEL: IFO380 /\n100MT",
]) {
  test(`baseline formatted quantity continuation survives metadata exclusion: ${JSON.stringify(request)}`, () => {
    const { worksheet, spc } = outputs(`${request}\n${header}`)
    assert.match(worksheet, /HSFO 100mts/)
    assert.equal(spc.hsfo, "100mts")
  })
}
