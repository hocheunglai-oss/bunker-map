# FCUNO SPC WhatsApp Board

Separate Chrome extension for SPC supplier trading workflow on WhatsApp Web.

## What It Does

- Keeps a local Supplier/Buyer shortcut board for the trader's WhatsApp Web session.
- Adds a second 360px enquiry panel beside the shortcut board.
- Loads recent SPC enquiries from `https://spc.fcuno.com/api/spc/enquiries`.
- Shows standard enquiry text, who sent it, new-enquiry badges, and STEM/LOST/POSTPONED/CANCELLED labels.
- Lets the user edit and tick/untick a reusable opening template before sending enquiries.
- Lets the user select sent enquiry rows and send the selected text into the current WhatsApp chat.
- Lets the user drag one sent enquiry directly onto a saved Supplier/Buyer chat to open that chat and send it.
- Lets each trader locally remove one enquiry or clear the visible list without affecting other traders.
- The handle beside each saved chat opens Remove on click and works as the drag handle when held.

## Install

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select:
   `/Users/hocheunglai/Desktop/bunker-map/tools/whatsapp-spc-speed-board`
6. Log in to `https://spc.fcuno.com` in the same Chrome profile.
7. Open `https://web.whatsapp.com`.

## Notes

- This is intentionally separate from `tools/whatsapp-speed-board`, so the current personal version can stay unchanged.
- If the enquiry panel says to log in, open `https://spc.fcuno.com`, log in, then return to WhatsApp Web.
- The board data is stored locally in Chrome extension storage under `fcuno-wa-spc-board-v1`.
