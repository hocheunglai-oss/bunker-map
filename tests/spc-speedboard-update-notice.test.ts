import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import {
  buildSpcSpeedBoardUpdateEmail,
  resolveSpcSpeedBoardNoticeRecipients,
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

test("builds beginner update instructions for the current SPC Speed Board version", () => {
  const email = buildSpcSpeedBoardUpdateEmail()

  assert.equal(email.subject, `SPC Speed Board ${SPC_SPEED_BOARD_VERSION} - Update Notice`)
  assert.match(email.html, new RegExp(SPC_SPEED_BOARD_PAGE_URL.replace(/[./]/g, "\\$&")))
  assert.match(email.html, /chrome:\/\/extensions/)
  assert.match(email.html, /existing folder that Chrome already uses/)
  assert.match(email.html, /click <strong>Reload<\/strong>/)
  assert.match(email.html, /Do not remove the extension or load it from a different folder/)
  assert.match(email.html, /Refresh .*WhatsApp Web/)
})
