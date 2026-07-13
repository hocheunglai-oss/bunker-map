import assert from "node:assert/strict"
import test from "node:test"
import {
  buildShortenedEnquiry,
  detectAttentionTerms,
} from "../lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "../lib/enquiryWorksheetParser"
import { parseSpcEnquiryText } from "../lib/spcEnquiryText"

function worksheetOutput(rawText: string, manualVlsfoMaxRemarks: Array<"180cst max" | "120cst max"> = []) {
  const guess = parseEnquiryWorksheetGuess(rawText)
  return buildShortenedEnquiry(
    rawText,
    guess.vesselName,
    guess.imo,
    manualVlsfoMaxRemarks,
    {
      autoDetectVlsfoRemarks: false,
      includePort: true,
      port: guess.port,
    },
  )
}

test("keeps adjacent products and their own quantities", () => {
  const raw = [
    "VESSEL: TROPICAL BINTANG",
    "IMO: 9567348",
    "PORT: PORT KELANG",
    "ETA: 22 JUL",
    "VLSFO190",
    "LSMGO sulfur max 0.1% 55MT",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw),
    "tropical bintang / 9567348 / port klang 22 jul / vlsfo 190mts / lsmgo 55mts",
  )
})

test("pairs quantity-before-grade blocks and uses sulphur context", () => {
  const raw = [
    "VESSEL: M/V PURPLE RAIN",
    "IMO NUMBER: 1094644",
    "PORT: YOSU",
    "DATE: 25-27TH OF JULY",
    "QUANTITY: 650-850 MTONS",
    "GRADES: RMG 380 - Sulphur max 3.50 %",
    "QUANTITY: 70-90 MTONS",
    "GRADES: LS MGO DMA - Sulphur max 0.10%",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw),
    "purple rain / 1094644 / yosu 25 - 27 jul / HSFO 650-850mts / lsmgo 70-90mts",
  )
})

test("ignores product references, specs, and remark temperatures", () => {
  const raw = [
    "Please attach latest Lab issued COQ for VLSFO for client's guidance.",
    "***Vessel requesting 30 Day Time bar on Quality Claims***",
    "VESSEL: MDS ATHENA",
    "IMO: 9450674",
    "PORT: ONSAN",
    "E.T.A.: 23-24 July 2026",
    "QTY: 231 MTNS",
    "PROD: 380 CST - RMG 380 VLSFO",
    "SPEC: ISO 8217:2010 RMG 380",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw),
    "mds athena / 9450674 / onsan 23 - 24 jul / vlsfo 231mts",
  )
})

test("handles compact headers, quantity-before-product, and dotted dates", () => {
  assert.equal(
    worksheetOutput("MSC SOMYA III - HK Anchorahe - 08.Jul - 500 mt vlsfo + 100 mt lsmgo"),
    "msc somya iii / hk 8 jul / vlsfo 500mts / lsmgo 100mts",
  )
})

test("prioritises the ETA port over a port word in the vessel name", () => {
  assert.equal(
    worksheetOutput("TS Hong Kong ETA Tianjin 13 Jul VLSFO 100MT"),
    "ts hong kong / tianjin 13 jul / vlsfo 100mts",
  )
})

test("preserves preferred port aliases and labelled alternatives", () => {
  const raw = [
    "'- Vessel name：BAO LIAN",
    "- IMO No.：1095868",
    "- Bunker port：YOSU or BUSAN",
    "- Eta：15TH-20TH",
    "- Supply quantity：180cst(<0.5%) 80 MT",
    "LSMGO(<0.1%) 15MT",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw),
    "bao lian / 1095868 / yosu or busan 15 - 20 jul / vlsfo 80mts / lsmgo 15mts",
  )
})

test("does not turn voyage numbers or address floors into products and dates", () => {
  const raw = [
    "船名 MV. TOYO HOPE（IMO：9330147)",
    "航次号： V10540",
    "加油港口： BUSAN S KOREA",
    "动态： ETA : 18-27TH JUL",
    "加油量及规格 LSFO (CST380) : 200-250 LSMGO: 40-70MT",
    "4th Flr, One Bldg, 171 Gyeongin-ro, Incheon, Korea",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw),
    "toyo hope / 9330147 / busan 18 - 27 jul / vlsfo 200-250mts / lsmgo 40-70mts",
  )
})

test("shows Singapore on FCUNO but omits it on SPC", () => {
  const raw = "GUANG MAO 8-9日到达新加坡，lsfo 700吨"
  assert.equal(worksheetOutput(raw), "guang mao / singapore 8 - 9 jul / vlsfo 700mts")
  assert.equal(parseSpcEnquiryText(raw).standardText, "guang mao / 8 - 9 jul / vlsfo 700mts")
})

test("normalises compact SPC dates, vessel types, and concatenated fuels", () => {
  assert.equal(
    parseSpcEnquiryText("OCEAN LEADER General Cargo. IMO 9260976/SGP12JUL/HSFO500mts/lsmgo100mts").standardText,
    "ocean leader / 9260976 / 12 jul / HSFO 500mts / lsmgo 100mts",
  )
})

test("extracts CBM quantity without concatenating the sulphur decimal", () => {
  assert.equal(
    parseSpcEnquiryText("PACIFIC HORNBILL / 9833233 / JUL10 / LSMGO 0.1% 200 cbm").standardText,
    "pacific hornbill / 10 jul / lsmgo 200mts",
  )
})

test("requires manual viscosity confirmation in the deterministic parser", () => {
  const raw = "VESSEL: TEST SHIP\nPORT: SINGAPORE\nETA: 12 JUL\nVLSFO 180CST 80MT"
  assert.equal(worksheetOutput(raw), "test ship / singapore 12 jul / vlsfo 80mts")
  assert.equal(
    worksheetOutput(raw, ["180cst max"]),
    "test ship / singapore 12 jul / vlsfo 180CST MAX 80mts",
  )
})

test("does not infer HSFO or a quantity from an ambiguous RMG 380 grade", () => {
  const raw = "VESSEL: TEST SHIP\nPORT: SINGAPORE\nETA: 12 JUL\nPRODUCT: RMG 380"
  assert.equal(worksheetOutput(raw), "test ship / singapore 12 jul")
  assert.equal(parseSpcEnquiryText(raw).standardText, "test ship / 12 jul")
})

test("does not use specification or viscosity numbers as quantities", () => {
  const raw = "VESSEL: TEST SHIP\nPORT: BUSAN\nETA: 12 JUL\nPRODUCT: VLSFO RMG 380 ISO 8217:2017 180CST"
  assert.equal(worksheetOutput(raw), "test ship / busan 12 jul")
})

test("flags all requested caution terms", () => {
  assert.deepEqual(detectAttentionTerms("RMK: 200 CBM / 250 KL"), ["RMK", "CBM", "KL"])
})

test("replays the remaining distinct historical report formats", () => {
  const worksheetCases: Array<{
    raw: string
    expected: string
    remarks?: Array<"180cst max" | "120cst max">
  }> = [
    {
      raw: "MOONLIT (9293882) in Singapore inner anchorage\n300 mt VLSFO\n30 mt LSMGO\n12th July 2026",
      expected: "moonlit / 9293882 / singapore 12 jul / vlsfo 300mts / lsmgo 30mts",
    },
    {
      raw: "Vessel name：GOLDEN FOREST\nIMO No.：1094620\nBunker port：SINGAPORE\nEta：15TH~21ST/JUL iagw\nSupply quantity：VLSFO180cst(<0.5%) 500mt；\nLSMGO(<0.1%) 50mt.\nRemark:VLSFO and LSMGO flash point ＞70",
      expected: "golden forest / 1094620 / singapore 15 - 21 jul / vlsfo 180CST MAX 500mts / lsmgo 50mts",
      remarks: ["180cst max"],
    },
    {
      raw: "船名：MT SHAN REN\n时间：2026年7月10日-7月14日\n地点：TAICHUNG,TAIWAN\n油品/数量: LSFO 180CST 80MT;LSMGO (硫含量小于0.1%）45MT",
      expected: "shan ren / taichung 10 - 14 jul / vlsfo 180CST MAX 80mts / lsmgo 45mts",
      remarks: ["180cst max"],
    },
    {
      raw: "TS Chennai ETA Port Kelang Jul. 17th, 2026\nTS Chennai_LSFO 245mt in Port Kelang anchorage",
      expected: "ts chennai / port klang 17 jul / vlsfo 245mts",
    },
    {
      raw: "ROSSINI (imo 1057957) , HK 13-14 Jul, mgo 40mt\nRemark: density 0.86 max",
      expected: "rossini / 1057957 / hk 13 - 14 jul / lsmgo 40mts",
    },
    {
      raw: "TRAWIND GLORY\nIMO 9379868\nETA HK 16-26/JULY\nVLSFO 180cst 100-180MT\nLSMGO 20-50MT",
      expected: "trawind glory / 9379868 / hk 16 - 26 jul / vlsfo 100-180mts / lsmgo 20-50mts",
    },
    {
      raw: "amoy sunny， eta HK 25-30July, VLSFO 735-770mt\naccount reachy/starry bulk",
      expected: "amoy sunny / hk 25 - 30 jul / vlsfo 735-770mts",
    },
  ]

  for (const item of worksheetCases) {
    assert.equal(worksheetOutput(item.raw, item.remarks), item.expected)
  }

  const spcCases = [
    {
      raw: "OCEAN LEADER General Cargo. IMO 9260976/JUL12/LSFO180mts/lsmgo30mts",
      expected: "ocean leader / 9260976 / 12 jul / vlsfo 180mts / lsmgo 30mts",
    },
    {
      raw: "OCEAN LEADER General Cargo. IMO 9260976 / SGP 12 jul / HSFO 100mts, lsfo 500mts, lsmgo 30mts",
      expected: "ocean leader / 9260976 / 12 jul / HSFO 100mts / vlsfo 500mts / lsmgo 30mts",
    },
  ]

  for (const item of spcCases) {
    assert.equal(parseSpcEnquiryText(item.raw).standardText, item.expected)
  }
})
