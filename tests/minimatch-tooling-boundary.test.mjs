// Exact GHSA-g3hv-75wg-m249 applicability evidence, not an audit replacement.
// Keep the raw npm audit result and the security report's review state visible.
// Changed versions, callers or parser configuration require fresh assessment.
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = fileURLToPath(new URL("../", import.meta.url))
const require = createRequire(import.meta.url)
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"))
const legacyPath = "node_modules/minimatch"
const modernPath = "node_modules/@typescript-eslint/typescript-estree/node_modules/minimatch"
const estreePath = path.join(root, "node_modules/@typescript-eslint/typescript-estree")
const estreeRequire = createRequire(path.join(estreePath, "package.json"))

function javascriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const filename = path.join(directory, entry.name)
    return entry.isDirectory() ? javascriptFiles(filename) : entry.isFile() && entry.name.endsWith(".js") ? [filename] : []
  })
}

test("all locked minimatch copies remain development-only and match the reviewed implementations", () => {
  const copies = Object.entries(lock.packages).filter(([name]) => /(?:^|\/)node_modules\/minimatch$/.test(name))
  assert.deepEqual(copies.map(([name]) => name).sort(), [legacyPath, modernPath].sort())
  for (const [name, entry] of copies) {
    assert.equal(entry.dev, true, `${name}: not part of the production dependency set`)
    const installed = JSON.parse(readFileSync(path.join(root, name, "package.json"), "utf8"))
    assert.equal(installed.name, "minimatch")
    assert.equal(installed.version, entry.version, `${name}: installed source must match the audited lock`)
  }
  assert.equal(lock.packages[legacyPath].version, "3.1.5")
  assert.equal(lock.packages[modernPath].version, "10.2.5")
  const dependents = Object.entries(lock.packages).filter(([, entry]) => entry.dependencies?.minimatch)
  assert.deepEqual(dependents.map(([name]) => name).sort(), [
    "node_modules/@eslint/config-array", "node_modules/@eslint/eslintrc",
    "node_modules/@typescript-eslint/typescript-estree", "node_modules/eslint",
    "node_modules/eslint-plugin-import", "node_modules/eslint-plugin-jsx-a11y",
    "node_modules/eslint-plugin-react",
  ].sort())
  for (const [name, entry] of dependents) assert.equal(entry.dev, true, `${name}: consumer must remain development-only`)
})

test("legacy minimatch has no algorithm or option identified by this advisory", () => {
  const filename = path.join(root, legacyPath, "minimatch.js")
  const source = readFileSync(filename, "utf8")
  assert.doesNotMatch(source, /firstPhasePreProcess|secondPhasePreProcess|optimizationLevel/)
  const legacy = require(filename)
  assert.equal(typeof legacy, "function", "legacy plugins retain their callable API")
  assert.equal(typeof legacy.makeRe, "function", "import/no-internal-modules still has its required API")
  assert.equal(legacy.Minimatch.prototype.firstPhasePreProcess, undefined)
  assert.equal(legacy.Minimatch.prototype.secondPhasePreProcess, undefined)
  assert.equal(legacy("example.ts", "*.ts"), true)
  assert.equal(legacy.makeRe("*.ts").test("example.ts"), true)
})

test("the only modern minimatch caller fixes options below the affected optimization level", () => {
  const callers = javascriptFiles(path.join(estreePath, "dist")).filter(filename =>
    /require\(["']minimatch["']\)/.test(readFileSync(filename, "utf8")))
  assert.deepEqual(callers.map(filename => path.relative(estreePath, filename)), ["dist/useProgramFromProjectService.js"])
  const caller = readFileSync(callers[0], "utf8")
  assert.match(caller, /function filePathMatchedBy\(filePath, allowDefaultProject\)\s*\{\s*return !!allowDefaultProject\?\.some\(pattern => \(0, minimatch_1\.minimatch\)\(filePath, pattern, \{ dot: true \}\)\);\s*\}/)
  assert.equal(estreeRequire.resolve("minimatch"), path.join(root, modernPath, "dist/commonjs/index.js"))
  const modernSource = readFileSync(estreeRequire.resolve("minimatch"), "utf8")
  assert.match(modernSource, /const \{ optimizationLevel = 1 \} = this\.options;\s*if \(optimizationLevel >= 2\)\s*\{[\s\S]*?globParts = this\.firstPhasePreProcess\(globParts\);\s*globParts = this\.secondPhasePreProcess\(globParts\);/)
  const modern = estreeRequire("minimatch")
  assert.equal(modern.minimatch("example.ts", "*.ts", { dot: true }), true)
  assert.equal(modern.minimatch("example.js", "*.ts", { dot: true }), false)
  class CheckedMatcher extends modern.Minimatch {
    firstPhasePreProcess() { throw new Error("Affected optimizer entered") }
    secondPhasePreProcess() { throw new Error("Affected optimizer entered") }
  }
  // Brace expansion can construct ** even when a literal ** validator passes.
  // Fixed optimization options, not the literal validator, enforce this boundary.
  for (const pattern of ["**/../a/b", "{*,x}*/../a/b", "nested/{*,x}*/../a/{*,y}*/../b/c"]) {
    assert.doesNotThrow(() => new CheckedMatcher(pattern, { dot: true }))
  }
  assert.throws(() => new CheckedMatcher("**/../a/b", { optimizationLevel: 2 }), /Affected optimizer entered/)
})

test("the actual TypeScript parser additionally rejects literal globstar forms", () => {
  const { parseAndGenerateServices } = require("@typescript-eslint/typescript-estree")
  for (const pattern of ["**/../example.ts", "nested/**/../a/**/../example.ts", "nested/**\\..\\example.ts"]) {
    assert.throws(() => parseAndGenerateServices("export const fixture = true", {
      filePath: path.join(root, "synthetic-minimatch-boundary.ts"),
      tsconfigRootDir: root,
      projectService: { allowDefaultProject: [pattern] },
    }), /contains a disallowed '\*\*'/)
  }
})

test("the real FCUNO lint configuration and CLI retain legitimate behavior without project-service matching", async () => {
  const { ESLint } = require("eslint")
  const eslint = new ESLint({ cwd: root })
  const filename = "app/admin/attendancerecord/attendanceDayEditor.ts"
  const config = await eslint.calculateConfigForFile(path.join(root, filename))
  assert.ok(config, "the real checked-in lint configuration must apply")
  assert.ok(!config.languageOptions.parserOptions?.project, "project-aware linting requires reassessment")
  assert.ok(!config.languageOptions.parserOptions?.projectService, "project-service matching is not enabled")
  const result = spawnSync(process.execPath, [path.join(root, "node_modules/eslint/bin/eslint.js"),
    "--stdin", "--stdin-filename", filename, "--format", "json"], {
    cwd: root, encoding: "utf8", input: "export const attendanceFixture = true\n",
    timeout: 30000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const [report] = JSON.parse(result.stdout)
  assert.equal(report.errorCount, 0)
  assert.equal(report.fatalErrorCount, 0)
  assert.deepEqual(report.messages, [])
})

// Run in the production-build CI job as well as testing the exact tooling paths.
// A devDependency label alone is not proof that a package was not bundled.
if (process.env.FCUNO_REQUIRE_BUILD_TRACE === "1") test("compiled production function traces do not include minimatch", () => {
  const build = path.join(root, ".next")
  const traces = readdirSync(build, { recursive: true }).filter(name => name.endsWith(".nft.json"))
  assert.ok(traces.length > 0, "a real production build is required")
  assert.ok(traces.some(name => name.includes("api/admin/attendance/route")), "attendance API trace must be present")
  for (const trace of traces) {
    const files = JSON.parse(readFileSync(path.join(build, trace), "utf8")).files
    assert.ok(Array.isArray(files), `${trace}: expected a real file trace`)
    assert.deepEqual(files.filter(filename => /(?:^|[\\/])minimatch(?:[\\/]|$)/.test(filename)), [], `${trace}: reviewed matcher must not ship`)
  }
})
