import React from "react"
import { createRoot } from "react-dom/client"
import OutlookAddressBookPage from "../../app/admin/outlookaddressbook/page"
import { installOutlookContactHarness } from "./outlook-contact-mocks"

installOutlookContactHarness()
createRoot(document.getElementById("root")!).render(
  <>
    <aside style={{ padding: "8px 18px", background: "#fff7d1", fontSize: "12px" }}>
      Synthetic local Outlook contact test. No production services or data are used.
      {" "}<a href="/another-page">Leave fixture page</a>
    </aside>
    <OutlookAddressBookPage />
  </>,
)
