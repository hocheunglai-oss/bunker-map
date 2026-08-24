import assert from "node:assert/strict"
import test, { mock } from "node:test"
import {
  applyVlsfoMaxRemarksToShortenedEnquiry,
  buildShortenedEnquiry,
  detectAttentionTerms,
  detectSpcCautionTerms,
  detectVlsfoMaxRemarks,
  formatSpcCautionWarning,
  normalizeEnquiryQuantityNumber,
  normalizeEnquiryQuantityText,
  replaceHsfoWithRmk,
} from "../lib/enquiryShortener"
import { parseEnquiryWorksheetGuess } from "../lib/enquiryWorksheetParser"
import {
  ensureSpcSingaporeEta,
  extractExplicitSpcFuelFields,
  parseSpcEnquiryText,
  restoreStoredSpcEnquiryFields,
} from "../lib/spcEnquiryText"

mock.timers.enable({ apis: ["Date"], now: new Date("2026-07-30T00:00:00.000Z") })
test.after(() => mock.timers.reset())

test("restores stored SPC amendment fields even when a test IMO fails checksum validation", () => {
  const restored = restoreStoredSpcEnquiryFields({
    formattedText: "testing vessel 1 / 9847286 / sg 14 sep / vlsfo 500mts / lsmgo 100mts",
    vesselName: "testing vessel 1",
    meta: {
      imo: "9847286",
      eta: "sg 14 sep",
      vlsfo: "500",
      lsmgo: "100",
    },
  })

  assert.equal(restored.imo, "9847286")
  assert.equal(restored.eta, "sg 14 sep")
  assert.equal(restored.vlsfo, "500")
  assert.equal(restored.lsmgo, "100")
})

function worksheetOutput(rawText: string, manualVlsfoMaxRemarks: Array<"80cst max" | "120cst max" | "180cst max"> = []) {
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

test("normalises Port Louis anchorage to the preferred port name", () => {
  const raw = [
    "hi Stanley, price for me",
    "HTK Symphony (9668271) / Port Louis anchorage, Mauritius 14 - 16 Aug / LSFO 150 - 200mts",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw),
    "htk symphony / 9668271 / port louis 14 - 16 aug / vlsfo 150-200mts",
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

test("shows Singapore on FCUNO and abbreviates it as sg on SPC", () => {
  const raw = "GUANG MAO 8-9日到达新加坡，lsfo 700吨"
  assert.equal(worksheetOutput(raw), "guang mao / singapore 8 - 9 jul / vlsfo 700mts")
  assert.equal(parseSpcEnquiryText(raw).standardText, "guang mao / sg 8 - 9 jul / vlsfo 700mts")
})

test("normalises compact SPC dates, vessel types, and concatenated fuels", () => {
  assert.equal(
    parseSpcEnquiryText("OCEAN LEADER General Cargo. IMO 9260976/SGP12JUL/HSFO500mts/lsmgo100mts").standardText,
    "ocean leader / 9260976 / sg 12 jul / HSFO 500mts / lsmgo 100mts",
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
  assert.equal(parseSpcEnquiryText(raw).standardText, "test ship / sg 12 jul")
})

test("does not use specification or viscosity numbers as quantities", () => {
  const raw = "VESSEL: TEST SHIP\nPORT: BUSAN\nETA: 12 JUL\nPRODUCT: VLSFO RMG 380 ISO 8217:2017 180CST"
  assert.equal(worksheetOutput(raw), "test ship / busan 12 jul")
})

test("flags all requested caution terms", () => {
  assert.deepEqual(detectVlsfoMaxRemarks("VLSFO 180CST"), ["180cst max"])
  assert.deepEqual(detectVlsfoMaxRemarks("VLSFO 80CST"), ["80cst max"])
  assert.deepEqual(detectAttentionTerms("RMK: 200 CBM / 250 KL"), ["RMK", "CBM", "KL"])
  assert.deepEqual(
    detectSpcCautionTerms("VLSFO 80CST / 120CST / 180CST / RMK"),
    ["80", "120", "180", "RMK"],
  )
  assert.equal(
    formatSpcCautionWarning(["80"]),
    "WARNING: 80 spotted. Confirm VLSFO viscosity requirement before sending.",
  )
  assert.equal(
    formatSpcCautionWarning(["RMK"]),
    "WARNING: RMK spotted. Confirm RMK requirement before sending.",
  )
  assert.equal(
    formatSpcCautionWarning(["80", "RMK"]),
    "WARNING: 80 / RMK spotted. Confirm VLSFO viscosity and RMK requirements before sending.",
  )
})

test("SPC parser preserves RMK as the HSFO-side product", () => {
  const parsed = parseSpcEnquiryText("chan ming / 12 aug / RMK 500mts")
  assert.equal(parsed.hsfo, "500mts")
  assert.equal(parsed.vlsfo, "")
  assert.equal(parsed.lsmgo, "")
  assert.equal(parsed.standardText, "chan ming / 12 aug / RMK 500mts")

  const structured = parseSpcEnquiryText("VESSEL: CHAN MING\nETA: 12 AUG\nRMK: 500MT")
  assert.equal(structured.hsfo, "500mts")
  assert.equal(structured.standardText, "chan ming / 12 aug / RMK 500mts")
})

test("RMK conversion changes HSFO only", () => {
  assert.equal(
    replaceHsfoWithRmk("ship / hsfo 500mts / vlsfo 200mts / lsmgo 50mts"),
    "ship / RMK 500mts / vlsfo 200mts / lsmgo 50mts",
  )
  assert.equal(
    replaceHsfoWithRmk("ship / vlsfo 200mts / lsmgo 50mts"),
    "ship / vlsfo 200mts / lsmgo 50mts",
  )
})

test("replays the remaining distinct historical report formats", () => {
  const worksheetCases: Array<{
    raw: string
    expected: string
    remarks?: Array<"80cst max" | "120cst max" | "180cst max">
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
      expected: "ocean leader / 9260976 / sg 12 jul / HSFO 100mts / vlsfo 500mts / lsmgo 30mts",
    },
  ]

  for (const item of spcCases) {
    assert.equal(parseSpcEnquiryText(item.raw).standardText, item.expected)
  }
})

test("replays the July 14 reported parser formats", () => {
  const aalKembla = [
    "Account: AAL - Austral Asia Line Pte. Ltd.",
    "Vessel: AAL Kembla",
    "IMO No: 9498353",
    "Port: Incheon",
    "Terminal/Berth: TBA",
    "ETA: July 27th 2026",
    "ETB: TBA",
    "ETS: July 29th 2026",
    "Product & Qty: VLSFO RMG 380 0,5%",
    "880",
    "-",
    "1000",
    "mt",
    "Product & Qty: LSMGO DMA 0,10",
    "100",
    "mt",
  ].join("\n")
  assert.equal(
    worksheetOutput(aalKembla),
    "aal kembla / 9498353 / inchon eta 27 jul, etd 29 jul / vlsfo 880-1,000mts / lsmgo 100mts",
  )
  assert.equal(
    worksheetOutput("VESSEL: TEST SHIP\nPORT: INCHEON\nE.T.A.: 27 JUL\nE.T.S.: 29 JUL\nVLSFO 10MT"),
    "test ship / inchon eta 27 jul, etd 29 jul / vlsfo 10mts",
  )

  assert.equal(
    worksheetOutput("YN BUSAN (9805300) / ZHOUSHAN / 30 JUL / VLSFO 100MT / LSMGO 50MT"),
    "yn busan / 9805300 / zhoushan 30 jul / vlsfo 100mts / lsmgo 50mts",
  )

  const timestampedYeosu = [
    "[13/07/2026, 16:28:17] SEAN LEE: YN YEOSU (9805116) / HONG KONG / 21 JUL / VLSFO 90MT / LSMGO 30MT",
    "[13/07/2026, 16:28:23] SEAN LEE: lets try this one",
  ].join("\n")
  assert.equal(
    worksheetOutput(timestampedYeosu),
    "yn yeosu / 9805116 / hk 21 jul / vlsfo 90mts / lsmgo 30mts",
  )

  const lngtOceania = [
    "Kindly be advised that Our vessel “LNGT OCEANIA” will need around 1.500 mt LSMGO bunkering at Malaysia Linggi Anchorage.",
    "Below provided ETA’s are tentative.",
    "IMO : 8608884",
    "ETA : 15.07.2026",
  ].join("\n")
  assert.equal(
    worksheetOutput(lngtOceania),
    "lngt oceania / 8608884 / linggi 15 jul / lsmgo 1,500mts",
  )

  assert.equal(
    parseSpcEnquiryText("pacific hornbill / sg 17 - 22 jul / vlsfo 500mts / lsmgo 40mts").standardText,
    "pacific hornbill / sg 17 - 22 jul / vlsfo 500mts / lsmgo 40mts",
  )
})

test("normalises decimal and thousands punctuation without changing small decimals", () => {
  assert.equal(normalizeEnquiryQuantityNumber("1.500"), "1,500")
  assert.equal(normalizeEnquiryQuantityNumber("1,500"), "1,500")
  assert.equal(normalizeEnquiryQuantityNumber("1,5"), "1.5")
  assert.equal(normalizeEnquiryQuantityNumber("0,500"), "0.500")
  assert.equal(
    normalizeEnquiryQuantityText("9498353 / vlsfo 880-1000mt / lsmgo 100 mts"),
    "9498353 / vlsfo 880-1,000mts / lsmgo 100mts",
  )
})

test("replays the July 15 FCUNO reports without rebuilding manual edits", () => {
  const zhida = [
    "船名（IMO NO.)：MV ZHIDA 2（9602851)",
    "航次号：10-504",
    "加油港口（挂靠）：YEOSU,KOREA 定油公司： LYNUX SHIPPING LIMITED",
    "ETA YEASU: 2-6 AUG",
    "ETA ZHOUSHAN: 1-10 AUG",
    "加油量及规格: LSFO(180CST) 250-300MT +LSMGO 5MT",
    "Thanks & B.rgds // Gyeongseop Jeong",
  ].join("\n")
  assert.equal(
    worksheetOutput(zhida, ["180cst max"]),
    "zhida 2 / 9602851 / yosu 2 - 6 aug / vlsfo 180CST MAX 250-300mts / lsmgo 5mts",
  )

  const xinrunchen = [
    "船名 MV. XINRUNCHEN6",
    "IMO: 9556791",
    "加油港口：YOSU（挂靠）",
    "ETA/D YOSU 27TH JUL-06TH AUG",
    "LSFO 120- 170MT (RMG 180)",
    "LSMGO 20-40 MT",
    "VLSFO SPEC : ISO 8217:2017 MAX0.5% SULPHUR M/M",
    "LSMGO SPEC : ISO 8217:2017 MAX0.1% SULPHUR M/M",
    "#1707, Uion Center, 310 Gangnam-daero, Gangnam-gu,",
  ].join("\n")
  assert.equal(
    worksheetOutput(xinrunchen, ["180cst max"]),
    "xinrunchen6 / 9556791 / yosu 27 jul - 6 aug / vlsfo 180CST MAX 120-170mts / lsmgo 20-40mts",
  )

  const editedDraft = "zhida 2 / 9602851 / zhoushan 2 - 6 aug / vlsfo 250-300mts / lsmgo 5mts"
  const withRemark = applyVlsfoMaxRemarksToShortenedEnquiry(editedDraft, ["180cst max"])
  assert.equal(
    withRemark,
    "zhida 2 / 9602851 / zhoushan 2 - 6 aug / vlsfo 180CST MAX 250-300mts / lsmgo 5mts",
  )
  assert.equal(
    applyVlsfoMaxRemarksToShortenedEnquiry(withRemark, []),
    editedDraft,
  )
  assert.equal(
    applyVlsfoMaxRemarksToShortenedEnquiry(editedDraft, ["80cst max"]),
    "zhida 2 / 9602851 / zhoushan 2 - 6 aug / vlsfo 80CST MAX 250-300mts / lsmgo 5mts",
  )
})

test("replays the July 17 FCUNO reports with canonical schedules and fuels", () => {
  assert.equal(
    worksheetOutput("mv neng yuan (9185762) eta Busan(bunker call) 26/30th july\nabt vlsfo 350/550 mts"),
    "neng yuan / 9185762 / busan 26 - 30 jul / vlsfo 350-550mts",
  )

  assert.equal(
    worksheetOutput("JIN XU XIANG 88(imo:9989405) ETA安特卫普 27/July -08/Agu 2026 LSMGO:60MT\nLSMFO. 100MT"),
    "jin xu xiang 88 / 9989405 / antwerp 27 jul - 8 aug / vlsfo 100mts / lsmgo 60mts",
  )

  assert.equal(
    worksheetOutput("TS Shanghai / IMO 9937517\nETA Xiamen 05-12 Aug\nETA Nansha 07-14 Aug\n1,200 mt HSFO max 3,5%"),
    "ts shanghai / 9937517 / xiamen 5 - 12 aug OR nansha 7 - 14 aug / HSFO 1,200mts",
  )

  assert.equal(
    parseSpcEnquiryText("TEST SHIP / 5 - 12 aug / LSMFO 100MT / LSMGO 60MT").standardText,
    "test ship / 5 - 12 aug / vlsfo 100mts / lsmgo 60mts",
  )
})

test("replays the July 21 FCUNO samples without leaking schedule or offer numbers", () => {
  assert.equal(
    worksheetOutput("mv guang yuan eta hk 25/28th july abt 350/450 mts vlsfo (mfm apply w/o density fake)"),
    "guang yuan / hk 25 - 28 jul / vlsfo 350-450mts",
  )

  assert.equal(
    worksheetOutput("=VESSEL : MV VALENTE VENUS (IMO 9424637)\n=PORT : HONGKONG\nETA HONGKONG : 29 JUL\n=SPEC / QTY :\nVLSFO - 380 CST S 0.5% : 210~250 MT"),
    "valente venus / 9424637 / hk 29 jul / vlsfo 210-250mts",
  )

  const minRong = [
    "We are going to bunker our LNG vessel \"Min Rong\" in the name of Min Rong LNG Shipping Co., Ltd.",
    "1. Date: Scheduled 8th-9th August, 2026",
    "2. Quantity: LSMGO- 650MT(S< 0.1 %)",
    "3. Position: Hong Kong",
    "Other Conditions: Please make LSMGO bunkering carry out within 1 barge as possible.",
    "Please send the best price BEFORE 1730 PM today. The offer shall remain valid no later than 1745 PM.",
  ].join("\n")
  assert.equal(
    worksheetOutput(minRong),
    "min rong / hk 8 - 9 aug / lsmgo 650mts",
  )

  assert.equal(
    worksheetOutput("MV QI HANG，8853776，ETA BUSAN 28-31ST，0.1LSMGO/60-80MT\n如果跨月8/2，价格多少"),
    "qi hang / 8853776 / busan 28 - 31 jul / lsmgo 60-80mts",
  )

  const tangShan = [
    "Pls offer before 18:30 with validity till 19:00 JST",
    "TANG SHAN GANG JI 1",
    "9216858",
    "Incheon 2026/07/28",
    "VLSFO 380CST 240MT LSMGO 50MT",
  ].join("\n")
  assert.equal(
    worksheetOutput(tangShan),
    "tang shan gang ji 1 / 9216858 / inchon 28 jul / vlsfo 240mts / lsmgo 50mts",
  )
})

test("replays the July 22 FCUNO reports without treating viscosity as quantity", () => {
  const dmDragon = [
    "Vessel : MT DM Dragon",
    "Port : Singapore",
    "Date : 24 July - 02 August 2026",
    "Order quantity & grade : VLSFO 380 : 270 mt & LSMGO: 70 mt",
  ].join("\n")
  assert.equal(
    worksheetOutput(dmDragon),
    "dm dragon / singapore 24 jul - 2 aug / vlsfo 270mts / lsmgo 70mts",
  )

  const stormRider = [
    "MV. \"MV STORM RIDER\" (IMO 9595357)",
    "-. BUNKERING PORT : \"PORT KELANG, MALAYSIA\"",
    "-. EST' DATE : O/A 29 JUL ~ 13 AUG",
    "-. VLSFO : 250~350 MT",
    "-. REMARK : VLSFO - 380 Centistoke ISO 8217:2017 (E) RMG 380 with max Sulphur 0.50",
  ].join("\n")
  assert.equal(
    worksheetOutput(stormRider),
    "storm rider / 9595357 / port klang 29 jul - 13 aug / vlsfo 250-350mts",
  )
})

test("replays the July 24 FCUNO reports with alternative schedules and exact dates", () => {
  const anne = [
    "Vessel: Anne（9474553）",
    "[Case 1]",
    "Port: Daesan, South Korea",
    "ETA: 26th - 30th Jul 2026",
    "VLSFO (below 0.5% sul): 150MT",
    "LSMGO (below 0.1% sul): 50MT",
    "*Agent Info:",
    "DONGYANG SHIPPING CO., LTD.",
    "[Case 2]",
    "Port: Yosu, South Korea",
    "ETA: 3rd - 7th Aug 2026",
    "VLSFO (below 0.5% sul): 150MT",
    "LSMGO (below 0.1% sul): 50MT",
  ].join("\n")
  assert.equal(
    worksheetOutput(anne),
    "anne / 9474553 / daesan 26 - 30 jul OR yosu 3 - 7 aug / vlsfo 150mts / lsmgo 50mts",
  )

  assert.equal(
    worksheetOutput("AL ATHFAR, inchon b/o 25 Jul, Vlsfo 100mt, mgo 50mt"),
    "al athfar / inchon 25 jul / vlsfo 100mts / lsmgo 50mts",
  )

  const bbcOcean = [
    "Account: BLUE WATER SHIPPING PTY LTD",
    "Vessel: BBC OCEAN",
    "IMO No: 9569530",
    "Port: BUSAN NEW PORT",
    "ETA: 1-Aug-26",
    "ETS: 3-Aug-26",
    "Product & Qty: RMG 380 0,5%",
    "210",
    "0",
    "Product & Qty: DMA 0,1%",
    "15",
    "0",
  ].join("\n")
  assert.equal(
    worksheetOutput(bbcOcean),
    "bbc ocean / 9569530 / busan new port eta 1 aug, etd 3 aug / vlsfo 210mts / lsmgo 15mts",
  )

  const buenaSuerte = [
    "Could you try till 17:20 HK?",
    "Vessel: BUENA SUERTE",
    "IMO NO: 9528550",
    "Port: ONSAN, KOREA",
    "Date: 7/28~",
    "Qtty: VLSFO : 135.0 MT",
    "LSMGO : 45.0 MT",
  ].join("\n")
  assert.equal(
    worksheetOutput(buenaSuerte),
    "buena suerte / 9528550 / onsan 28 jul / vlsfo 135mts / lsmgo 45mts",
  )
})

test("replays the July 30 FCUNO reports with delivery windows and candidate ports", () => {
  const weaverArrow = [
    "Offer Required:",
    "Buyer",
    "G2 Ocean AS",
    "Vessel: WEAVER ARROW",
    "IMO: 9151826",
    "Port: Kaohsiung",
    "ETA: 03 Aug 26",
    "ETD: 07 Aug 26",
    "Grades and Quantities",
    "ISO 8217 2017 RMG180 0.50%",
    "330 mt",
  ].join("\n")
  assert.equal(
    worksheetOutput(weaverArrow),
    "weaver arrow / 9151826 / kaohsiung 3 - 7 aug / vlsfo 330mts",
  )

  const xingChangHai = [
    "M/V XING CHANG HAI (9758492)",
    "YEOSU, SOUTH KOREA (FOR BUNKERS ONLY)",
    "04th - 07th August, 2026",
    "650 - 750 MT // VLSFO / RMG 380 - Sulphur max 0.50 % ISO 8217 - 2017",
    "80 - 100 MT // LS MGO DMA - Sulphur max 0.10% - ISO 8217 - 2017",
  ].join("\n")
  assert.equal(
    worksheetOutput(xingChangHai),
    "xing chang hai / 9758492 / yosu 4 - 7 aug / vlsfo 650-750mts / lsmgo 80-100mts",
  )

  const gaschemAfrica = [
    "GASCHEM AFRICA / Bunker Request:",
    "LPG/C GASCHEM AFRICA",
    "VLSFO = 650 MT RMG 380 ISO 2017 0.5%",
    "LSMGO = 100 MT MGO DMA 0.1 ISO 2017",
    "ETA:",
    "Ulsan -> 29 July 2026",
    "Daesan -> 02 August 2026",
  ].join("\n")
  assert.equal(
    worksheetOutput(gaschemAfrica),
    "gaschem africa / ulsan 29 jul OR daesan 2 aug / vlsfo 650mts / lsmgo 100mts",
  )
})

test("replays the August 3 reports with slash windows and structured SPC specifications", () => {
  assert.equal(
    worksheetOutput("mv bei yuan eta busan 1/5 aug abt vlsfo 200/300 mts"),
    "bei yuan / busan 1 - 5 aug / vlsfo 200-300mts",
  )

  const harmony = [
    "NAME(IMO NO.):HARMONY IMO: 9402017",
    "VOYAGE NO:2605",
    "BUNKER PORT:SINGAPORE",
    "ETA SINGAPORE:22ND AUG -06TH SEP",
    "BUNKER QUANTITY AND SPECS:",
    "LSFO:700MT",
    "LSMGO:30MT",
    "FUEL OIL 380 CST SPECS: ISO 8217 2010 RMG 380 (SULPHUR CONTENT < 0.5%)",
    "DIESEL OILS SPECS: ISO-8217 2010 DMA/B (SULPHUR CONTENT < 0.1%)",
  ].join("\n")

  assert.deepEqual(extractExplicitSpcFuelFields(harmony), {
    vlsfo: "700mts",
    lsmgo: "30mts",
  })
  assert.equal(
    parseSpcEnquiryText(harmony).standardText,
    "harmony / 9402017 / sg 22 aug - 6 sep / vlsfo 700mts / lsmgo 30mts",
  )
})

test("ignores narrative dates beneath an operational notes heading", () => {
  const ravenArrow = [
    "Vessel:",
    "Raven Arrow",
    "IMO:",
    "9574858",
    "Port:",
    "Singapore",
    "Agent:",
    "TBA",
    "ETA:",
    "01 Sep 26",
    "Operational Notes",
    "IF UNABLE TO OFFER FOR A DELIVERY 1 JANUARY, PLS OFFER BASED ON YR EARLIEST DELIVERY DATE.",
    "OFFICIAL SAMPLES FOR DISPUTE RESOLUTION ARE TO BE TAKEN AT THE RECEIVING VESSELS MANIFOLD.",
    "G2 Ocean will appoint Lintec/Intertek to perform a Bunker Quantity Survey on this delivery.",
    "The Bunker delivery is NOT to commence until the Surveyor is present and has performed pre delivery checks.",
    "Note: In ports where procedures permit the vessel must receive a Certificate of Quality (COQ) for each supply of VLSFO.",
    "Grades and Quantities",
    "Spec",
    "Quantity",
    "ISO 8217 2017 VLSFO RMG 380 0.50%",
    "1000 mt",
  ].join("\n")

  assert.equal(
    parseSpcEnquiryText(ravenArrow).standardText,
    "raven arrow / 9574858 / sg 1 sep / vlsfo 1,000mts",
  )
})

test("replays the August 7 compact IMO, separated port, KL, and gas oil reports", () => {
  const tigerPioneer = [
    "船名（IMO NO.)：TIGER PIONEER (IMO9712199)",
    "航次号：20-0419",
    "加油港口：BUSAN（挂靠）",
    "定油公司：LYNUX SHIPPING BULK PTE LIMITED",
    "ETA/D: 12TH/22TH AUG, 2026",
    "加油量及规格: LSFO 300-400 MT (380 as per I.S.O 8217 - 2017)",
  ].join("\n")
  assert.equal(
    worksheetOutput(tigerPioneer),
    "tiger pioneer / 9712199 / busan 12 - 22 aug / vlsfo 300-400mts",
  )

  const goldenShine = [
    "GOLDEN SHINE (IMO: 9902457) / HONGKONG",
    "LYCN 14TH-28TH,AUG",
    "VLSFO 100-140MT under 180cst",
    "LSMGO 35-50 MT",
  ].join("\n")
  assert.equal(
    worksheetOutput(goldenShine, ["180cst max"]),
    "golden shine / 9902457 / hk 14 - 28 aug / vlsfo 180CST MAX 100-140mts / lsmgo 35-50mts",
  )

  assert.equal(
    worksheetOutput("Ile De Re 8200278 / Taichung / 11-19 August / LSMGO 400kl"),
    "ile de re / 8200278 / taichung 11 - 19 aug / lsmgo 400kl",
  )

  const barbaraLeeBattler = [
    "Barbara Lee Battler(IMO8738328)",
    "DATE: 01ST SEP 26",
    "FUEL OIL 0.5 500MTS",
    "GAS OIL S0.1 100MTS",
    "REFUELING PORT: SINGAPORE",
  ].join("\n")
  assert.deepEqual(extractExplicitSpcFuelFields(barbaraLeeBattler), {
    vlsfo: "500mts",
    lsmgo: "100mts",
  })
  assert.equal(
    parseSpcEnquiryText(barbaraLeeBattler).standardText,
    "barbara lee battler / 8738328 / sg 1 sep / vlsfo 500mts / lsmgo 100mts",
  )
})

test("uses sg only for Singapore enquiries on SPC", () => {
  assert.equal(ensureSpcSingaporeEta("Singapore 16 - 18 Aug"), "sg 16 - 18 aug")
  assert.equal(ensureSpcSingaporeEta("SGP12 Jul"), "sg 12 jul")
  assert.equal(
    parseSpcEnquiryText("SHAN REN / 9474606 / SINGAPORE / 16 - 18 AUG / VLSFO 110MT").standardText,
    "shan ren / 9474606 / sg 16 - 18 aug / vlsfo 110mts",
  )
  assert.equal(
    parseSpcEnquiryText("SHAN REN / 9474606 / SIN 16 - 18 AUG / VLSFO 110MT").standardText,
    "shan ren / 9474606 / sg 16 - 18 aug / vlsfo 110mts",
  )
  assert.equal(
    parseSpcEnquiryText("SHAN REN / 9474606 / TAICHUNG / 16 - 18 AUG / VLSFO 110MT").standardText,
    "shan ren / 9474606 / 16 - 18 aug / vlsfo 110mts",
  )
})

test("pairs labelled grade and quantity lists in order", () => {
  const raw = [
    "Vessel: JOSCO LUCKY",
    "Port: PORT KLANG",
    "Date: 25th Aug. 2026",
    "Grade: VLSFO VIS＜180CST / LSMGO",
    "Quantity: 650-790 MT / 90-100 MT",
  ].join("\n")

  assert.equal(
    worksheetOutput(raw, ["180cst max"]),
    "josco lucky / port klang 25 aug / vlsfo 180CST MAX 650-790mts / lsmgo 90-100mts",
  )
  assert.equal(
    parseSpcEnquiryText(raw, ["180cst max"]).standardText,
    "josco lucky / 25 aug / vlsfo 180CST MAX 650-790mts / lsmgo 90-100mts",
  )
})

test("replays the August 18 pending review reports", () => {
  const bangor = [
    "M/V BANGOR (9228057)",
    "YEOSU, SOUTH KOREA",
    "27TH - 30TH AUGUST, 2026",
    "900 - 1000 MTONS // VLSFO RMG 380 0.5 % (ISO 8217 - 2017)",
  ].join("\n")
  assert.equal(
    worksheetOutput(bangor),
    "bangor / 9228057 / yosu 27 - 30 aug / vlsfo 900-1,000mts",
  )

  const oceanBanquet = [
    "MV. Ocean Banquet\t IMO: 9740108",
    "Port\tBusan",
    "Dates\t28 August 2026 - 02 September 2026",
    "ETA: 28 August 2026",
    "Requirements\t300 - 450 MT VLSFO 0.5% (ISO 8217:2010)",
  ].join("\n")
  assert.equal(
    worksheetOutput(oceanBanquet),
    "ocean banquet / 9740108 / busan 28 aug - 2 sep / vlsfo 300-450mts",
  )

  const sunnyBright = [
    "Vessel   Sunny Bright   (LPG Carrier)",
    "Place     Yeosu",
    "ETA       September 6~ 8 (this might change)",
    "Grade/Quantity   VLSFO(RMG380 Sulphur Max 0.5%) 600-700 MT",
  ].join("\n")
  assert.equal(
    worksheetOutput(sunnyBright),
    "sunny bright / yosu 6 - 8 sep / vlsfo 600-700mts",
  )

  const pazifik = [
    "Vessel / IMO : M/V PAZIFIK IMO 9293430 LPG",
    "Port / Berth : Yeosu",
    "Delivery Date / ETA / ETS : 02.09.2026 - 05.09.2026",
    "HFO 3,5% : Nil",
    "VLSFO 0,5% : 500 mts IFO380cst. RMG380 0,5% / VLSFO",
    "MGO/DMA 0,1% : Nil",
  ].join("\n")
  assert.equal(
    worksheetOutput(pazifik),
    "pazifik / 9293430 / yosu 2 - 5 sep / vlsfo 500mts",
  )

  const overseasSantorini = [
    "Vessel",
    "Overseas Santorini",
    "IMO",
    "9435909",
    "Port",
    "Singapore",
    "ETA",
    "19-Aug-26",
    "Bunker Date",
    "19-Aug-26",
    "204-Aug-26",
    "Quantity 1",
    "Units",
    "Grade",
    "ISO Spec",
    "Sulfur max",
    "535-610",
    "MTS",
    "DMA",
    "2017",
    "0.10%",
  ].join("\n")
  assert.equal(
    parseSpcEnquiryText(overseasSantorini).standardText,
    "overseas santorini / 9435909 / sg 19 aug / lsmgo 535-610mts",
  )
})
