# FCUNO SPC WhatsApp Board

Current version: `0.6.5`.

Separate Chrome extension for SPC supplier trading workflow on WhatsApp Web.

## What It Does

- Keeps a local Supplier/Buyer shortcut board for the trader's WhatsApp Web session.
- Adds a second 360px enquiry panel beside the shortcut board.
- Loads recent SPC enquiries from `https://spc.fcuno.com/api/spc/enquiries`.
- Keeps the same two-second refresh while WhatsApp is visible, transfers only changed enquiries after the first load, and resumes immediately when the tab becomes visible.
- Shows standard enquiry text, who sent it, new-enquiry badges, and STEM/LOST/POSTPONED/CANCELLED labels.
- Every authenticated SPC extension user receives the same shared enquiry feed
  and outcome updates, regardless of which SPC user created the enquiry.
- Remove and Clear All are intentionally local to the current Chrome profile.
  They never delete or hide the enquiry for another trader.
- Lets the user edit and tick/untick a reusable opening template before sending enquiries.
- Lets the user click an enquiry row to select it with a blue highlight, then click it again to cancel selection.
- Shows the Send command and effective selection inside the fixed button, including whether the opening template will be included.
- Shows the supplied green paper-plane button on each enquiry. It opens the exact SPC enquiry group without refreshing the page, puts the full enquiry in WhatsApp bold syntax on the first line, leaves the cursor ready on the second line, and does not send automatically.
- Uses checkbox-free enquiry rows and sends all currently blue-selected enquiries into the current WhatsApp chat.
- Lets the user drag one sent enquiry directly onto a saved Supplier/Buyer chat to open that chat and send it.
- Suppresses only immediate duplicate drag/send events; a deliberate retry is available after 2.5 seconds instead of being silently blocked for 30 seconds.
- Lets each trader locally remove one enquiry or clear the visible list without affecting other traders.
- The handle beside each saved chat opens Rename/Send Selected/Remove on click, hides shortly after you move away, and reliably rearranges saved chats when dragged.
- All authenticated traders share enquiries created after the controlled feed start on 23 July 2026, while Remove and Clear All remain local to each Chrome profile.
- `Rename` changes only the local display label. The original WhatsApp contact or group name remains hidden as the routing identity, so renaming cannot redirect the shortcut.
- Saved Supplier/Buyer shortcuts keep the exact local WhatsApp chat or group name seen by that trader. Adding a shortcut never opens Contact Info, reads a phone number, or consults the FCUNO phonebook.
- Enquiry-sender buttons receive one normalized WhatsApp number from SPC. They use native keyboard input in WhatsApp's normal left search, require one direct-chat result, open it with a native click, verify the opened header, and only then prefill the reply. There is no sender-name or direct-link fallback.
- After updating the unpacked extension, reload the extension and WhatsApp Web. An invalidated previous content script now shuts down cleanly and releases the page for the replacement board.
- Checks the required production version every five minutes. A persistent red
  `UPDATE REQUIRED` bar identifies an old unpacked copy; an amber warning shows
  when the version service cannot be reached, so stale installations do not
  remain silent.
- Shows a one-time Chrome notification for each required release and keeps a red
  exclamation indicator visible when an outdated board is collapsed.

## Install

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select:
   `/Users/hocheunglai/Desktop/bunker-map/tools/whatsapp-spc-speed-board`
6. Log in to `https://spc.fcuno.com` in the same Chrome profile.
7. Open `https://web.whatsapp.com`.

Enable only one FCUNO WhatsApp board in a Chrome profile. If both FCUNO and SPC extensions are enabled accidentally, the first board loaded keeps control and the other does not mount over it.

## Notes

- This is intentionally separate from `tools/whatsapp-speed-board`, so the current personal version can stay unchanged.
- Buyer amendments retain the same enquiry and are highlighted with a red outline and revision details.
- The Brent indicator uses SPC's validated `/api/market/brent` service, backed by
  the official ICE front-month Brent futures feed. ICE data is delayed by at
  least 15 minutes, and the numeric quote is hidden whenever validation fails.
- If the enquiry panel says to log in, open `https://spc.fcuno.com`, log in, then return to WhatsApp Web.
- The board data is stored locally in Chrome extension storage under `fcuno-wa-spc-board-v1`.
- Locally removed enquiry IDs remain hidden only for that Chrome profile, even
  when another trader changes the shared enquiry status.
- The extension uses Chrome's debugger permission for native text input, result clicks, and send actions when WhatsApp ignores synthetic DOM events.
- Background refreshes update only changed data and preserve active template editing and dragging. The enquiry cache is reset automatically when the SPC login changes.
