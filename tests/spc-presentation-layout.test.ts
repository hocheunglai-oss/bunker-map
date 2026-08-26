import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { SPC_PAGE_DEFINITIONS } from "../lib/spcPages"

const presentationPage = readFileSync(
  new URL("../app/spc/readme/page.tsx", import.meta.url),
  "utf8",
)
const presentationRoute = readFileSync(
  new URL("../app/spc/presentation/page.tsx", import.meta.url),
  "utf8",
)
const globalStyles = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")
const nextConfig = readFileSync(new URL("../next.config.js", import.meta.url), "utf8")

test("SPC presentation uses the renamed route without changing its permission id", () => {
  const page = SPC_PAGE_DEFINITIONS.find((item) => item.id === "spc-readme")
  assert.equal(page?.label, "PRESENTATION")
  assert.equal(page?.path, "/spc/presentation")
  assert.ok(page?.matchPrefixes?.includes("/spc/readme"))
  assert.match(presentationRoute, /export \{ default \} from "\.\.\/readme\/page"/)
  assert.match(presentationPage, /document\.title = "SPC PRESENTATION"/)
  assert.match(presentationPage, /<SpcShell title="PRESENTATION">/)
  assert.match(
    nextConfig,
    /source: "\/spc\/readme",[\s\S]*?destination: "\/spc\/presentation",[\s\S]*?permanent: true/,
  )
  assert.match(
    nextConfig,
    /source: "\/readme",[\s\S]*?destination: "\/presentation",[\s\S]*?permanent: true/,
  )
})

test("SPC presentation removes repeated preview topics and keeps sections editor-only", () => {
  assert.doesNotMatch(presentationPage, /className="spc-readme-stage-heading"/)
  assert.match(
    presentationPage,
    /\{editorMode && canEdit \? \([\s\S]*?<nav className="spc-readme-chunk-list"/,
  )
  assert.doesNotMatch(presentationPage, /spc-readme-section-count/)
  assert.doesNotMatch(presentationPage, />\s*PLAY CHAPTER\s*<\/button>/)
  assert.doesNotMatch(presentationPage, /INTERMEDIATE \/ \{activeChapter/)
})

test("SPC presentation gives the video a larger polished workspace", () => {
  assert.match(
    globalStyles,
    /\.spc-readme-workspace \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(280px, 330px\);/,
  )
  assert.match(
    globalStyles,
    /\.spc-readme-stage \{[\s\S]*?border-radius: 16px;[\s\S]*?box-shadow:/,
  )
  assert.match(
    globalStyles,
    /linear-gradient\(100deg, #eaf3ff 0%, #f7faff 45%, #ffffff 100%\)/,
  )
  assert.match(
    globalStyles,
    /\.spc-readme-toolbar > div:first-child strong \{[\s\S]*?font-size: clamp\(18px, 1\.7vw, 22px\);/,
  )
})
