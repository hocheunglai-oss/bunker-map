# FCUNO SPC WhatsApp Board

Separate Chrome extension for SPC supplier trading workflow on WhatsApp Web.

## What It Does

- Keeps a local Supplier/Buyer shortcut board for the trader's WhatsApp Web session.
- Adds a second 360px enquiry panel beside the shortcut board.
- Loads recent SPC enquiries from `https://spc.fcuno.com/api/spc/enquiries`.
- Keeps the same two-second refresh while WhatsApp is visible, transfers only changed enquiries after the first load, and resumes immediately when the tab becomes visible.
- Shows standard enquiry text, who sent it, new-enquiry badges, and STEM/LOST/POSTPONED/CANCELLED labels.
- Lets the user edit and tick/untick a reusable opening template before sending enquiries.
- Lets the user click an enquiry row to select it with a blue highlight, then click it again to cancel selection.
- Shows a WhatsApp-style paper-plane button on each enquiry. It opens the sender's individual chat through WhatsApp's visible search results without navigating or refreshing the page; ambiguous phonebook matches are never guessed.
- Uses checkbox-free enquiry rows and sends all currently blue-selected enquiries into the current WhatsApp chat.
- Lets the user drag one sent enquiry directly onto a saved Supplier/Buyer chat to open that chat and send it.
- Lets each trader locally remove one enquiry or clear the visible list without affecting other traders.
- The handle beside each saved chat opens Rename/Send Selected/Remove on click, hides shortly after you move away, and reliably rearranges saved chats when dragged.
- A new installation starts with an empty enquiry panel by baselining the existing API history; only enquiries created after that first successful load appear.
- `Rename` changes only the local display label. The original WhatsApp contact or group name remains hidden as the routing identity, so renaming cannot redirect the shortcut.
- After updating the unpacked extension, reload the extension and WhatsApp Web. An invalidated previous content script now shuts down cleanly and releases the page for the replacement board.

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
- If the enquiry panel says to log in, open `https://spc.fcuno.com`, log in, then return to WhatsApp Web.
- The board data is stored locally in Chrome extension storage under `fcuno-wa-spc-board-v1`.
- The extension uses Chrome's debugger permission only to dispatch the WhatsApp send action from the background worker when DOM events are ignored.
- Background refreshes update only changed data and preserve active template editing and dragging. The enquiry cache is reset automatically when the SPC login changes.
