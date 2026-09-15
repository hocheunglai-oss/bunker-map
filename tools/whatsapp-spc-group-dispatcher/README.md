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

The dispatcher never sends to a partial group-name match. Group comparisons normalize whitespace and invisible direction marks on both the configured name and the visible title, while preserving the stored route name. Nested WhatsApp wrappers for one visible result are treated as one chat. Delivery requires one exact search result and the same exact title after opening; genuinely separate exact results, a different opened title, or uncertain sends stop for manual review. Search, open, compose, and send steps use pauses for reliability.

Version 1.3.2 reserves submission on the server immediately before sending. Only one job can be in flight across the dispatcher's WhatsApp tabs. Once submission is reserved, an interrupted or uncertain attempt is retained for manual review instead of automatically sent again. An older identical message is never proof that the current enquiry was sent. Update the existing installed folder to 1.3.2 before resuming delivery.

## Retry timing

The queue is checked every 2 seconds. Failures before submission retry after 15, 30, 45, 60 seconds and so on, with 20 total attempts. The last possible retry waits 285 seconds; after the final failed attempt the job requires manual review. Processing and browser suspension can add time. An unsubmitted claim lasts 90 seconds; an expired submission reservation requires manual review.

These are application reliability settings, not a WhatsApp-approved sending rate. WhatsApp publishes no interval that guarantees protection from account restrictions for WhatsApp Web automation. See [WhatsApp's automated messaging guidance](https://faq.whatsapp.com/5957850900902049/?locale=en_US).

REDelivery keeps a compact journal of confirmed sends from the last 24 hours. A WhatsApp sent acknowledgement does not establish that every group member has received or read the message. It can be minimized to a narrow right-edge control without stopping queue processing. Failed or manual-review deliveries remain visible here and are also reported to every signed-in SPC Speed Board.

An unpaired installation reads its empty local state before requesting automatic pairing. Keep `spc.fcuno.com` signed in within the same Chrome profile while installing or reloading the dispatcher.
