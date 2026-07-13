# FCUNO WhatsApp Speed Board

Local Chrome extension for the trading-hour WhatsApp workflow.

## Purpose

- No Meta WhatsApp API.
- No FCUNO phonebook search.
- No webhook or message sync.
- Each trader keeps their own Supplier and Buyer board on their own WhatsApp Web session.
- Enquiries are queued from FCUNO Enquiry Worksheet into the trader's own Chrome extension storage.

## Install For Testing

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Enable `Developer mode`.
4. Click `Load unpacked`.
5. Select this folder:
   `/Users/hocheunglai/Desktop/bunker-map/tools/whatsapp-speed-board`
6. Open `https://fcuno.com/admin/enquiryworksheet` and `https://web.whatsapp.com` in the same Chrome profile.

Enable only one FCUNO WhatsApp board in a Chrome profile. If both FCUNO and SPC extensions are enabled accidentally, the first board loaded keeps control and the other does not mount over it.

## Trading Use

- Open a WhatsApp chat, then click `Add as Supplier` or `Add as Buyer`.
- Drag contacts to reorder. Use the handle menu to rename, send selected enquiries, or remove a saved contact; the menu hides shortly after you move away from it.
- Use `Rename` in the handle menu to set a local display name. The original WhatsApp contact or group name remains the routing identity and is shown underneath the alias.
- Click a contact to jump to the WhatsApp chat. Phone-number chats open directly with WhatsApp Web's `send?phone=` URL.
- Name-only chats use WhatsApp Web's left chat search as a fallback; the extension does not use in-chat search.
- Visible WhatsApp unread counts are mirrored as green badges on saved rows.
- In Enquiry Worksheet, edit the shortened enquiry if needed, then press the green WhatsApp send button.
- WhatsApp Web receives the enquiry in the right-hand queue. Tick one or more enquiries and click `Send`, or drag them onto a saved contact.
- The template above the queue can be enabled, disabled, or edited locally before sending.
- Board settings are stored under `fcuno-wa-speed-board-v1`, while the worksheet queue is isolated under `fcuno-wa-speed-board-enquiries-v1`. This prevents a newly queued enquiry from overwriting contact or template changes made at the same time.

## Notes

This extension does not use SPC enquiries or SPC outcome buttons. It uses Chrome's debugger permission only to make WhatsApp Web text insertion and send clicks more reliable when normal DOM events are ignored.
Crude and unread updates patch only their own indicators, so background refreshes do not interrupt template editing or dragging.
