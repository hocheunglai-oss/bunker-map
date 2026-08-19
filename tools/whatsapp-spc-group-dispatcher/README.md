# FCUNO SPC Group Dispatcher

Install the unpacked extension once from the stable `fcuno-spc-group-dispatcher` folder. Later releases update that same folder from `spc.fcuno.com/chrome` and reload the extension automatically.

Copies older than 1.1.6 require one final manual **Reload** in `chrome://extensions` after using **Update Installed Folder**. Do not remove and reinstall the extension.

This is the dedicated Windows dispatcher for the Singapore Purchasing Center. It is intentionally separate from the trader Speed Board.

## Installation

1. Keep the approved WhatsApp Business App number logged in at `https://web.whatsapp.com/` on the designated Windows desktop.
2. Log in to `https://spc.fcuno.com/chrome` in the same Chrome profile.
3. Download and extract the Group Dispatcher ZIP.
4. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
5. Refresh WhatsApp Web.
6. The dispatcher connects automatically. In SPC User Management, create each delivery route with the exact existing WhatsApp group name and assign every buyer to the correct route.

Only one dispatcher device is active at a time. Pairing a replacement device revokes the previous device. One dispatcher can service multiple centrally assigned groups. Keep WhatsApp Web open; queued enquiries wait safely while the desktop is offline.

Installing or reloading a dispatcher update automatically refreshes open WhatsApp Web tabs so Chrome replaces the previous content script. The dispatcher pairing remains in extension storage when the same unpacked extension folder is updated.

The dispatcher never sends to a partial group-name match. Nested WhatsApp wrappers for one visible result are treated as one chat. Delivery requires one exact search result and the same exact title after opening; genuinely separate exact results, a different opened title, or uncertain sends stop for manual review instead of being retried blindly. Search, open, compose, and send steps intentionally use conservative pauses for reliability.

An unpaired installation reads its empty local state before requesting automatic pairing. Keep `spc.fcuno.com` signed in within the same Chrome profile while installing or reloading the dispatcher.
