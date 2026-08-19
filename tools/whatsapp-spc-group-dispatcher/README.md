# FCUNO SPC Group Dispatcher

This is the dedicated Windows dispatcher for the Singapore Purchasing Center. It is intentionally separate from the trader Speed Board.

## Installation

1. Keep the approved WhatsApp Business App number logged in at `https://web.whatsapp.com/` on the designated Windows desktop.
2. Log in to `https://spc.fcuno.com/chrome` in the same Chrome profile.
3. Download and extract the Group Dispatcher ZIP.
4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
5. Refresh WhatsApp Web.
6. Enter a device label, then choose **Pair Dispatcher**.
7. In SPC User Management, create each delivery route with the exact existing WhatsApp group name and assign every buyer to the correct route.

Only one dispatcher device is active at a time. Pairing a replacement device revokes the previous device. One dispatcher can service multiple centrally assigned groups. Keep WhatsApp Web open; queued enquiries wait safely while the desktop is offline.

The dispatcher never sends to a partial group-name match. Nested WhatsApp wrappers for one visible result are treated as one chat, while genuinely separate exact group results or uncertain sends are stopped for manual review instead of being retried blindly.
