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
const motionScene = readFileSync(
  new URL("../components/spc-readme/PresentationMotionScene.tsx", import.meta.url),
  "utf8",
)
const liveDemonstrationMigration = readFileSync(
  new URL("../supabase/migrations/20260901045509_add_spc_live_demonstration.sql", import.meta.url),
  "utf8",
)

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

test("SPC presentation adds a responsive live demonstration warm-up before the final chapter", () => {
  assert.match(liveDemonstrationMigration, /50,[\s\S]*?'LIVE DEMONSTRATION',[\s\S]*?'WARM UP ACTIVITY'/)
  assert.match(liveDemonstrationMigration, /'warm-up-enquiry'/)
  assert.doesNotMatch(liveDemonstrationMigration, /LIVE DEMOSTRATION/)
  assert.match(liveDemonstrationMigration, /'Raven Arrow'/)
  assert.match(liveDemonstrationMigration, /'9574858'/)
  assert.match(liveDemonstrationMigration, /'300 - 400 METRIC TONS'/)
  assert.match(motionScene, /function WarmUpEnquiryScene/)
  assert.match(motionScene, /<dl>/)
  assert.match(motionScene, /<table className="spc-readme-warm-up-grades">/)
  assert.match(motionScene, /scene === "warm-up-enquiry" \? "region" : "img"/)
  assert.equal((presentationPage.match(/visualCopy=\{selected\.visualCopy\}/g) || []).length, 2)
  assert.match(globalStyles, /\.spc-readme-motion-layout\.is-warm-up \{[\s\S]*?linear-gradient/)
  assert.match(globalStyles, /\.spc-readme-workspace\.is-activity:not\(\.is-editing\)/)
})

test("SPC live demonstration uses a neutral box colourway", () => {
  const warmUpStyles = globalStyles.match(/\.spc-readme-motion-layout\.is-warm-up \{[\s\S]*?\n\}/)?.[0] || ""

  assert.match(warmUpStyles, /#efefec[\s\S]*?#faf9f7[\s\S]*?#f2f1ee/)
  assert.doesNotMatch(warmUpStyles, /#eaf3ff|#f7faff|#eef3f8|rgba\(11, 112, 224/)
  assert.match(globalStyles, /\.spc-readme-warm-up-countdown \{[\s\S]*?background: rgba\(255, 255, 255, 0\.92\);/)
})

test("SPC warm-up follows the original enquiry format and includes a manual countdown", () => {
  assert.doesNotMatch(motionScene, /BUNKER ENQUIRY/)
  assert.match(motionScene, /<h3>Operational Notes<\/h3>/)
  assert.match(motionScene, /<caption>Grades and Quantities<\/caption>/)
  assert.match(motionScene, /label === "Port" \? "is-new-block"/)
  assert.match(globalStyles, /\.spc-readme-warm-up-details dl \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/)
  assert.match(globalStyles, /\.spc-readme-warm-up-content \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(160px, 0\.23fr\);/)
  assert.match(motionScene, /const WARM_UP_DURATION_SECONDS = 2 \* 60/)
  assert.match(motionScene, /timerRemainingMsRef = useRef\(WARM_UP_DURATION_MS\)/)
  assert.match(motionScene, /Date\.now\(\) \+ startingMilliseconds/)
  assert.match(motionScene, /remainingSeconds > 0 && remainingSeconds <= 15/)
  assert.match(motionScene, /remainingSeconds === 15 \? "15 seconds remaining"/)
  assert.match(motionScene, /<strong role="timer"/)
  assert.match(motionScene, />START<\/button>/)
  assert.match(motionScene, />PAUSE<\/button>/)
  assert.match(motionScene, />RESET<\/button>/)
  assert.match(globalStyles, /\.spc-readme-warm-up-countdown-actions button \{[\s\S]*?min-height: 44px;/)
})
