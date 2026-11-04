import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import ts from "typescript"
import { NextResponse } from "next/server"
import * as shortener from "../lib/enquiryShortener"
import * as worksheet from "../lib/enquiryWorksheetParser"
import * as spc from "../lib/spcEnquiryText"
import * as config from "../lib/parserAiConfig"

const missingWarning = "IMO is not provided and could not be confirmed with high confidence."
const lookupWarning = "IMO found by web search; please double check."
const safetyWarning = "Found 9543970, but it failed IMO check digit validation."
const invalidWarning = "IMO is not confirmed because its check digit is invalid."
const compoundWarning = "IMO is not provided; port is uncertain."
const originalWarnings = [missingWarning, "RMK was spotted; double check.", safetyWarning, invalidWarning, compoundWarning]

function harness(lookupSucceeds: boolean) {
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
    if (calls.length === 1) return Response.json({ output_text: JSON.stringify(draft) })
    return Response.json({
      output_text: JSON.stringify({ imo: lookupSucceeds ? "9543976" : "", confidence: lookupSucceeds ? 0.99 : 0, warning: lookupWarning }),
      output: [{ type: "web_search_call", action: { sources: lookupSucceeds ? [source] : [] } }],
    })
  }
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse },
    "@/lib/enquiryShortener": shortener, "@/lib/enquiryWorksheetParser": worksheet,
    "@/lib/spcEnquiryText": spc, "@/lib/parserAiConfig": config,
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
