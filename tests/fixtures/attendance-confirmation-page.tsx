import React from "react"
import { createRoot } from "react-dom/client"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import AttendanceRecordClient from "../../app/admin/attendancerecord/AttendanceRecordClient"
import { installAttendanceConfirmationHarness } from "./attendance-confirmation-mocks"

installAttendanceConfirmationHarness()
createRoot(document.getElementById("root")!).render(
  <>
    <aside style={{ padding: "8px 18px", background: "#fff7d1", fontSize: "12px" }}>
      Synthetic local attendance confirmation test. No production services or attendance records are used.
    </aside>
    <main className="fc-admin-scope">
      <AdminRouteGuard><AttendanceRecordClient /></AdminRouteGuard>
    </main>
  </>,
)
