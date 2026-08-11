import { normalizeEmailList } from "@/lib/emailAddress"

export const SPC_SPEED_BOARD_VERSION = "0.5.5"
export const SPC_SPEED_BOARD_PAGE_URL = "https://spc.fcuno.com/chrome"
export const SPC_SPEED_BOARD_ROLE = "SUPPLIER TRADER"
export const SPC_SPEED_BOARD_NOTICE_CC = ["otto@cosulich.com.hk"] as const

type NoticeRecipient = {
  username: string
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function resolveSpcSpeedBoardNoticeRecipients(users: NoticeRecipient[]) {
  return normalizeEmailList(users.map((user) => user.username))
}

export function buildSpcSpeedBoardNoticeDelivery(users: NoticeRecipient[]) {
  return {
    to: resolveSpcSpeedBoardNoticeRecipients(users),
    cc: [...SPC_SPEED_BOARD_NOTICE_CC],
  }
}

export function buildSpcSpeedBoardUpdateEmail(version = SPC_SPEED_BOARD_VERSION) {
  const safeVersion = escapeHtml(version)

  return {
    subject: `SPC Speed Board ${version} - Update Notice`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.5;max-width:680px">
        <h2 style="margin:0 0 12px">SPC Speed Board Update</h2>
        <p style="margin:0 0 14px">Version <strong>${safeVersion}</strong> is ready. Please update your SPC Speed Board before trading.</p>
        <ol style="margin:0 0 16px;padding-left:22px">
          <li style="margin:0 0 8px">Open <a href="${SPC_SPEED_BOARD_PAGE_URL}" style="color:#0a73c9">${SPC_SPEED_BOARD_PAGE_URL}</a> and download the latest <strong>WHATSAPP EXTENSION</strong> ZIP.</li>
          <li style="margin:0 0 8px">Extract the downloaded ZIP file.</li>
          <li style="margin:0 0 8px">Copy all files from the new <strong>fcuno-spc-whatsapp-board</strong> folder into the existing folder that Chrome already uses. Choose <strong>Replace</strong> when asked.</li>
          <li style="margin:0 0 8px">In Chrome, open <strong>chrome://extensions</strong>.</li>
          <li style="margin:0 0 8px">Find <strong>FCUNO SPC WhatsApp Board</strong> and click <strong>Reload</strong>.</li>
          <li>Refresh <a href="https://web.whatsapp.com/" style="color:#0a73c9">WhatsApp Web</a>.</li>
        </ol>
        <p style="margin:0;padding:10px 12px;background:#f3f7fb;border-left:3px solid #0a73c9"><strong>Important:</strong> Keep the extension folder in its existing location. Do not remove the extension or load it from a different folder, so your saved Speed Board settings remain attached to the same extension.</p>
        <p style="margin:14px 0 0">Please report any issues you notice while updating or using the Speed Board.</p>
      </div>
    `,
  }
}
