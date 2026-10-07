import React from "react"
import { createRoot } from "react-dom/client"
import TaskCalendarPage from "../../app/admin/taskcalendar/page"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import { installTaskCalendarHarness } from "./task-calendar-mocks"

installTaskCalendarHarness()
createRoot(document.getElementById("root")!).render(
  <main className="fc-admin-scope">
    <AdminRouteGuard><TaskCalendarPage /></AdminRouteGuard>
  </main>,
)
