import { execSync } from "node:child_process"

function run(command) {
  return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

const status = run("git status --porcelain")
const blockingStatus = status
  .split("\n")
  .filter(Boolean)
  .filter((line) => {
    const filePath = line.slice(3)
    return filePath !== "backups/" && !filePath.startsWith("backups/")
  })
  .join("\n")

if (blockingStatus) {
  fail(
    [
      "Release check failed: uncommitted files exist.",
      "Commit and push all intended changes before relying on production.",
      blockingStatus,
    ].join("\n")
  )
}

try {
  run("git rev-parse --abbrev-ref --symbolic-full-name @{u}")
} catch {
  fail("Release check failed: this branch has no upstream remote configured.")
}

const unpushed = Number(run("git rev-list --count @{u}..HEAD") || "0")
if (unpushed > 0) {
  fail(`Release check failed: ${unpushed} local commit(s) have not been pushed.`)
}

execSync("npm run build", { stdio: "inherit" })
console.log("Release check passed: working tree clean, branch pushed, build ok.")
