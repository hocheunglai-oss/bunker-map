import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const nextCli = fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url))
const ansi = /\u001b\[[0-?]*[ -/]*[@-~]/g

// Next/Webpack can emit an unresolved export warning and still exit zero.
// Remember split chunks without retaining potentially sensitive build output.
export function createImportErrorDetector() {
  let tail = "", failed = false
  return {
    write(chunk) {
      const text = (tail + String(chunk)).replace(ansi, "")
      failed ||= /attempted import error\s*:|module not found\s*:|export\s+[^\n]{1,500}\s+(?:was|is) not found in/i.test(text)
      tail = text.slice(-8192)
    },
    failed: () => failed,
  }
}

export async function runProductionBuild({ spawn: spawnImpl = spawn, stdout = process.stdout, stderr = process.stderr } = {}) {
  const output = createImportErrorDetector(), errors = createImportErrorDetector()
  const child = spawnImpl(process.execPath, [nextCli, "build", "--webpack"], {
    cwd: root, env: process.env, stdio: ["inherit", "pipe", "pipe"],
  })
  let compilerError = false
  child.stdout.on("data", chunk => { output.write(chunk); stdout.write(chunk) })
  child.stderr.on("data", chunk => { errors.write(chunk); stderr.write(chunk) })
  child.once("error", () => { compilerError = true; stderr.write("Unable to start the production compiler.\n") })
  const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM")
  process.once("SIGINT", interrupt); process.once("SIGTERM", terminate)
  try {
    const result = await new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })))
    const unresolvedImport = output.failed() || errors.failed()
    if (unresolvedImport) stderr.write("Production build rejected: unresolved compiler imports. See compiler output above.\n")
    const exitCode = compilerError || result.signal || unresolvedImport ? 1 : Number.isInteger(result.code) ? result.code : 1
    return { exitCode, compilerExitCode: result.code, compilerSignal: result.signal, unresolvedImport }
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", terminate)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runProductionBuild().then(result => { process.exitCode = result.exitCode }).catch(() => {
    console.error("Production compiler failed before completion.")
    process.exitCode = 1
  })
}
