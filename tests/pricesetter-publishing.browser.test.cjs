// Compatibility entry point. Publication coverage now exercises the actual
// audited APIs and SQL rather than synthesizing report writes in the browser.
const { spawnSync } = require("node:child_process")
const path = require("node:path")
if (process.argv.some(arg => arg.startsWith("--baseline-ref="))) {
  throw Error("Historical direct-writer reproduction is recorded in the audit evidence. Use the current API/SQL flow regression for this implementation.")
}
const result = spawnSync(process.execPath, ["--import", "tsx", path.join(__dirname, "pricesetter-publication-flow.browser.test.mjs")], { stdio: "inherit", env: process.env })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
