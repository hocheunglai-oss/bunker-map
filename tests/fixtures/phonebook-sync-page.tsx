import React from "react"
import { createRoot } from "react-dom/client"
import PhonebookPage from "../../app/admin/phonebook/page"
import { installPhonebookSyncHarness } from "./phonebook-sync-mocks"

installPhonebookSyncHarness()
createRoot(document.getElementById("root")!).render(
  <>
    <aside style={{ padding: "8px 18px", background: "#fff7d1", fontSize: "12px" }}>
      Synthetic local Phonebook sync test. No production services or data are used.
    </aside>
    <PhonebookPage />
  </>,
)
