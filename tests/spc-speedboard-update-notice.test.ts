import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  buildSpcSpeedBoardNoticeDelivery,
  buildSpcSpeedBoardUpdateEmail,
  resolveSpcSpeedBoardNoticeRecipients,
  SPC_SPEED_BOARD_NOTICE_CC,
  SPC_SPEED_BOARD_PAGE_URL,
  SPC_SPEED_BOARD_VERSION,
} from "../lib/spcSpeedBoardNotice"

test("keeps the notice version aligned with the downloadable extension", () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), "tools/whatsapp-spc-speed-board/manifest.json"), "utf8"),
  ) as { version?: string }

  assert.equal(SPC_SPEED_BOARD_VERSION, manifest.version)
})

test("resolves active supplier-trader usernames into unique email recipients", () => {
  assert.deepEqual(
    resolveSpcSpeedBoardNoticeRecipients([
      { username: " BARRY@COSULICH.COM.SG " },
      { username: "barry@cosulich.com.sg" },
      { username: "not-an-email" },
      { username: "michelle@cosulich.com.sg" },
    ]),
    ["barry@cosulich.com.sg", "michelle@cosulich.com.sg"],
  )
})

test("addresses all supplier traders in To and always copies Otto", () => {
  const delivery = buildSpcSpeedBoardNoticeDelivery([
    { username: "barry@cosulich.com.sg" },
    { username: "michelle@cosulich.com.sg" },
  ])

  assert.deepEqual(delivery.to, ["barry@cosulich.com.sg", "michelle@cosulich.com.sg"])
  assert.deepEqual(delivery.cc, ["otto@cosulich.com.hk"])
  assert.deepEqual(SPC_SPEED_BOARD_NOTICE_CC, ["otto@cosulich.com.hk"])
})

test("builds beginner update instructions for the current SPC Speed Board version", () => {
  const email = buildSpcSpeedBoardUpdateEmail()

  assert.equal(email.subject, `SPC Speed Board ${SPC_SPEED_BOARD_VERSION} - Update Notice`)
  assert.ok(email.html.includes(SPC_SPEED_BOARD_PAGE_URL))
  assert.match(email.html, /chrome:\/\/extensions/)
  assert.match(email.html, /existing folder that Chrome already uses/)
  assert.match(email.html, /click <strong>Reload<\/strong>/)
  assert.match(email.html, /Do not remove the extension or load it from a different folder/)
  assert.match(email.html, /Refresh .*WhatsApp Web/)
  assert.match(email.html, /Please report any issues you notice while updating or using the Speed Board\./)
})

test("the SPC download page explains how to update the loaded unpacked folder", () => {
  const page = readFileSync(join(process.cwd(), "app/spc/chrome/page.tsx"), "utf8")

  assert.match(page, /replace the files inside the same fcuno-spc-whatsapp-board folder that Chrome already uses/)
  assert.match(page, /confirm the new version is shown, then refresh WhatsApp Web/)
  assert.match(page, /checks its installed version automatically/)
  assert.match(page, /red UPDATE REQUIRED bar/)
})

test("documents the four informational matching-enquiry warnings", () => {
  const page = readFileSync(join(process.cwd(), "app/spc/chrome/page.tsx"), "utf8")
  const styles = readFileSync(join(process.cwd(), "app/globals.css"), "utf8")

  assert.match(page, /MATCHING ENQUIRY WARNINGS/)
  assert.match(page, /DUPLICATE/)
  assert.match(page, /DUP EX QTY/)
  assert.match(page, /CHECK IMO/)
  assert.match(page, /CHECK VSL NAME/)
  assert.match(page, /never merge, remove, reroute, or delay an enquiry/)
  assert.match(styles, /\.spc-chrome-matching-rule-list/)
  assert.match(styles, /background: #fff3bf/)
})

test("publishes a no-store version contract for every installed SPC board", () => {
  const route = readFileSync(
    join(process.cwd(), "app/api/spc/chrome-extension/version/route.ts"),
    "utf8",
  )
  const background = readFileSync(
    join(process.cwd(), "tools/whatsapp-spc-speed-board/background.js"),
    "utf8",
  )

  assert.match(route, /latestVersion: SPC_SPEED_BOARD_VERSION/)
  assert.match(route, /requiredVersion: SPC_SPEED_BOARD_VERSION/)
  assert.match(route, /Cache-Control.*no-store/)
  assert.match(background, /chrome\.runtime\.getManifest\(\)\.version/)
  assert.match(background, /compareVersions\(installedVersion, requiredVersion\) < 0/)
  assert.match(background, /load-spc-extension-version/)
  assert.match(background, /SPC Speed Board update required/)
  assert.match(background, /spc-update-notified-/)
})

test("shows a persistent update warning without changing the normal board size", () => {
  const content = readFileSync(
    join(process.cwd(), "tools/whatsapp-spc-speed-board/content.js"),
    "utf8",
  )
  const styles = readFileSync(
    join(process.cwd(), "tools/whatsapp-spc-speed-board/styles.css"),
    "utf8",
  )

  assert.match(content, /UPDATE REQUIRED/)
  assert.match(content, /const EXTENSION_UPDATE_PAGE_URL = "https:\/\/spc\.fcuno\.com\/chrome"/)
  assert.match(
    content,
    /<a href="\$\{escapeHtml\(updatePageUrl\)\}" target="_blank" rel="noreferrer">UPDATE<\/a>/,
  )
  assert.match(content, /VERSION CHECK OFFLINE/)
  assert.match(content, /VERSION_REFRESH_MS = 5 \* 60 \* 1000/)
  assert.match(styles, /\.fcuno-wa-spc-shell\.has-version-alert/)
  assert.match(styles, /grid-template-rows: 50px 38px minmax\(0, 1fr\)/)
  assert.match(styles, /\.fcuno-wa-spc-icon\.is-update-required/)
})

test("shows shared group-delivery failures on every signed-in SPC Speed Board", () => {
  const background = readFileSync(
    join(process.cwd(), "tools/whatsapp-spc-speed-board/background.js"),
    "utf8",
  )
  const content = readFileSync(
    join(process.cwd(), "tools/whatsapp-spc-speed-board/content.js"),
    "utf8",
  )

  assert.match(background, /api\/spc\/group-delivery-alerts/)
  assert.match(background, /SPC delivery needs review/)
  assert.match(background, /SPC group delivery retrying/)
  assert.match(background, /spc-delivery-\$\{key\}/)
  assert.match(content, /aria-label="SPC delivery alerts"/)
  assert.match(content, /REVIEW/)
  assert.match(content, /RETRYING/)
})
