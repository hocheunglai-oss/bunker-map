# FCUNO SPC Group Dispatcher

This is the dedicated Windows dispatcher for the Singapore Purchasing Center. It is intentionally separate from the trader Speed Board.

## Installation

1. Keep the approved WhatsApp Business App number logged in at `https://web.whatsapp.com/` on the designated Windows desktop.
2. Log in to `https://spc.fcuno.com/chrome` in the same Chrome profile.
3. Download and extract the Group Dispatcher ZIP.
4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
5. Refresh WhatsApp Web.
6. Enter a device label and the exact existing WhatsApp trading group name, then choose **Pair Dispatcher**.

Only one dispatcher device is active at a time. Pairing a replacement device revokes the previous device. Keep WhatsApp Web open; queued enquiries wait safely while the desktop is offline.

The dispatcher never sends to a partial group-name match. An ambiguous group or an uncertain send is stopped for manual review instead of being retried blindly.
