import React from "react"
import { createRoot } from "react-dom/client"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import AttendanceRecordClient from "../../app/admin/attendancerecord/AttendanceRecordClient"
import { installHalfdayHarness } from "./attendance-halfday-mocks"
installHalfdayHarness()
createRoot(document.getElementById("root")!).render(<main className="fc-admin-scope"><AdminRouteGuard><AttendanceRecordClient /></AdminRouteGuard></main>)
