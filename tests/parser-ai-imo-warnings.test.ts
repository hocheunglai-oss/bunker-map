import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import * as shortener from "../lib/enquiryShortener"
import * as worksheet from "../lib/enquiryWorksheetParser"
import * as spc from "../lib/spcEnquiryText"
import * as config from "../lib/parserAiConfig"
import * as ports from "../lib/enquiryPortIndex"

const missingWarning = "IMO is not provided and could not be confirmed with high confidence."
const lookupWarning = "IMO found by web search; please double check."
const safetyWarning = "Found 9543970, but it failed IMO check digit validation."
const invalidWarning = "IMO is not confirmed because its check digit is invalid."
const compoundWarning = "IMO is not provided; port is uncertain."
const originalWarnings = [missingWarning, "RMK was spotted; double check.", safetyWarning, invalidWarning, compoundWarning]

function harness(lookupSucceeds: boolean, draftOverrides: Record<string, unknown> = {}) {
  const calls: Record<string, unknown>[] = []
  const draft = {
    correctedOutput: "toyo shine / hk 15 nov / vlsfo 150mts", vesselName: "TOYO SHINE",
    imo: "", port: "hong kong", buyer: "", eta: "15 nov", hsfo: "", vlsfo: "150mts",
    lsmgo: "", remarks: "", vlsfoMaxRemarks: [], confidence: 0.99, warnings: originalWarnings,
  }
  const source = { title: "ClassNK TOYO SHINE IMO 9543976", url: "https://www.classnk.or.jp/register/regships/one_dsp.aspx?imo=9543976" }
  const provider = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body))
    calls.push(body)
    if (calls.length === 1) return Response.json({ output_text: JSON.stringify({ ...draft, ...draftOverrides }) })
    return Response.json({
      output_text: JSON.stringify({ imo: lookupSucceeds ? "9543976" : "", confidence: lookupSucceeds ? 0.99 : 0, warning: lookupWarning }),
      output: [{ type: "web_search_call", action: { sources: lookupSucceeds ? [source] : [] } }],
    })
  }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/enquiryShortener": shortener, "@/lib/enquiryWorksheetParser": worksheet,
    "@/lib/spcEnquiryText": spc, "@/lib/parserAiConfig": config,
    "@/lib/enquiryPortIndex": ports,
    "@/lib/adminAuth": { requireAdminPagePermission: async () => ({ username: "synthetic" }) },
    "@/lib/spcAuth": { requireSpcPagePermission: async () => ({ username: "synthetic" }) },
    "@/lib/openAiUsage": { recordOpenAiUsage: async () => {} },
  }
  const code = ts.transpileModule(readFileSync(new URL("../app/api/parser-ai/route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mod = { exports: {} as { POST: (request: Request) => Promise<Response> } }
  new Function("require", "module", "exports", "process", "fetch", code)((name: string) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`)
    return modules[name]
  }, mod, mod.exports, { env: { OPENAI_API_KEY: "synthetic-only-no-live-provider" } }, provider)
  return { calls, post: mod.exports.POST }
}

test("worksheet AI normalization preserves alternative ports instead of selecting the first indexed match", async () => {
  const h = harness(true, {
    vesselName: "ALPHA", imo: "9594573", port: "gibraltar or malta", eta: "28 nov",
    correctedOutput: "alpha / 9594573 / gibraltar or malta 28 nov / vlsfo 150mts", warnings: [],
  })
  const response = await h.post(new Request("https://synthetic.invalid/api/parser-ai", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source: "enquiryworksheet", rawText: "VESSEL: ALPHA\nIMO: 9594573\nPORT: Gibraltar or Malta\nETA: 28 Nov\nVLSFO 150MT" }),
  }))
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.correctedOutput, "alpha / 9594573 / gibraltar or malta 28 nov / vlsfo 150mts")
  assert.equal(body.fields.port, "gibraltar or malta")
})

for (const source of ["enquiryworksheet", "spc"]) {
  for (const separated of [false, true]) {
    test(`${source}: AI port fields and ${separated ? "separated" : "combined"} schedule preserve the approved Shanghai terminal qualifier`, async () => {
      const h = harness(true, {
        vesselName: "TEH PEACE", imo: "9868170", port: "shanghai, wai gao qiao", eta: "25 nov",
        hsfo: "230mts", vlsfo: "", warnings: [],
        correctedOutput: `teh peace / 9868170 / shanghai, wai gao qiao${separated ? " / " : " "}25 nov / HSFO 230mts`,
      })
      const response = await h.post(new Request("https://synthetic.invalid/api/parser-ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, rawText: "Vessel: TEH PEACE\nIMO: 9868170\nDemand port: Shanghai, Wai Gao Qiao\nRequire date: Nov. 25th, 2026\nHSFO 230MT" }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.correctedOutput, source === "spc"
        ? "TEH PEACE (9868170) / SHANGHAI (WAI GAO QIAO) / 25 NOV / 230 MT HSFO RMG380 (3.5%)"
        : "teh peace / 9868170 / shanghai (wai gao qiao) 25 nov / HSFO 230mts")
      if (source === "enquiryworksheet") assert.equal(body.fields.port, "shanghai (wai gao qiao)")
      assert.equal(h.calls.length, 1)
    })
  }

  test(`${source}: a standalone SLA note is excluded from the AI port and schedule`, async () => {
    const h = harness(true, {
      vesselName: "YUE DIAN 81", imo: "9161041", port: "hong kong (sla)", eta: "22 nov",
      vlsfo: "310mts", warnings: [],
      correctedOutput: "yue dian 81 / 9161041 / hong kong (sla) 22 nov / vlsfo 310mts",
    })
    const response = await h.post(new Request("https://synthetic.invalid/api/parser-ai", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, rawText: "YUE DIAN 81 / 9161041\nHONG KONG (SLA)\n22 NOV 2026\nLSFO / 310 MT" }),
    }))
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.correctedOutput, source === "spc"
      ? "YUE DIAN 81 (9161041) / HONG KONG / 22 NOV / 310 MT VLSFO (0.5%)"
      : "yue dian 81 / 9161041 / hk 22 nov / vlsfo 310mts")
    if (source === "enquiryworksheet") assert.equal(body.fields.port, "hong kong")
    assert.equal(h.calls.length, 1)
  })
}

for (const source of ["enquiryworksheet", "spc"]) {
  for (const succeeds of [true, false]) {
    test(`${source}: ${succeeds ? "sourced lookup clears only the obsolete missing-IMO warning" : "failed lookup preserves missing-IMO and safety warnings"}`, async () => {
      const h = harness(succeeds)
      const response = await h.post(new Request("https://synthetic.invalid/api/parser-ai", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, rawText: "Vessel: TOYO SHINE\nPort: Hong Kong\nDate: 15 Nov\nVLSFO 150MT" }),
      }))
      assert.equal(response.status, 200)
      const body = await response.json()
      assert.equal(body.fields.imo, succeeds ? "9543976" : "")
      assert.equal(body.warnings.includes(missingWarning), !succeeds)
      assert.ok(body.warnings.includes(originalWarnings[1]))
      assert.ok(body.warnings.includes(safetyWarning))
      assert.ok(body.warnings.includes(invalidWarning))
      assert.ok(body.warnings.includes(compoundWarning))
      if (succeeds) {
        assert.ok(body.warnings.includes(lookupWarning))
        assert.match(body.correctedOutput, /9543976/)
        assert.match(body.correctedOutput, source === "spc" ? /\/ HONG KONG \// : /\/ hk 15 nov \//)
        assert.equal(body.imoSources.length, 1)
      }
      assert.equal(h.calls.length, 2)
      assert.equal(h.calls[1].tool_choice, "required")
    })
  }
}
