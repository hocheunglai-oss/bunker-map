import React from "react"
import { createRoot } from "react-dom/client"
import EventCalendarPage from "../../app/admin/eventcalendar/page"
import { AdminRouteGuard } from "../../components/AdminRouteGuard"
import { installEventCalendarHarness } from "./event-calendar-mocks"

installEventCalendarHarness()
createRoot(document.getElementById("root")!).render(<main className="fc-admin-scope"><AdminRouteGuard><EventCalendarPage /></AdminRouteGuard></main>)
