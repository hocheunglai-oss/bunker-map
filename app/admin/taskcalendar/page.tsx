"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  getDueTaskCalendarTasks,
  getTaskActiveMonths,
  resolveTaskRecipients,
  taskCalendarTasks,
} from "@/data/taskCalendar"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.2), transparent 30%), radial-gradient(circle at bottom right, rgba(87, 227, 176, 0.12), transparent 28%), linear-gradient(180deg, #0a2c4c 0%, #06213b 42%, #041629 100%)",
  color: "#edf7ff",
  fontFamily: "Arial, Helvetica, sans-serif",
  padding: "18px",
}

const shellStyle: React.CSSProperties = {
  width: "min(1320px, 100%)",
  margin: "0 auto",
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid rgba(210,236,255,0.16)",
  borderRadius: "999px",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 800,
  padding: "8px 12px",
  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08), 0 10px 24px rgba(8,24,44,0.16)",
}

const panelStyle: React.CSSProperties = {
  overflow: "auto",
  background:
    "linear-gradient(180deg, rgba(235, 244, 250, 0.16) 0%, rgba(182, 205, 218, 0.08) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.18)",
  borderRadius: "22px",
  padding: "12px",
  boxShadow: "0 30px 96px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255,255,255,0.08)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
}

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  minWidth: "1120px",
}

const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  padding: "8px 7px",
  borderBottom: "1px solid rgba(210, 236, 255, 0.15)",
  background: "linear-gradient(180deg, rgba(12, 40, 68, 0.98) 0%, rgba(8, 29, 50, 0.96) 100%)",
  color: "#b9d6ed",
  fontSize: "10px",
  fontWeight: 900,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  textAlign: "left",
}

const tdStyle: React.CSSProperties = {
  padding: "6px 7px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontSize: "12px",
  lineHeight: "16px",
  verticalAlign: "middle",
}

function monthNames(months: number[] | null) {
  if (!months) return "Every month"
  return months.map((month) => new Date(2026, month - 1, 1).toLocaleString("en-US", { month: "short" })).join(", ")
}

export default function TaskCalendarPage() {
  const router = useRouter()
  const { loading, authenticated } = useSimpleAdminAuth()
  const [selectedPerson, setSelectedPerson] = useState("All")
  const dueTodayIds = useMemo(() => new Set(getDueTaskCalendarTasks().map((task) => task.id)), [])
  const people = useMemo(
    () => Array.from(new Set(taskCalendarTasks.flatMap((task) => [...task.notify, ...task.cc]))).filter((person) => person !== "SY"),
    []
  )
  const visibleTasks = useMemo(
    () =>
      taskCalendarTasks.filter(
        (task) => selectedPerson === "All" || task.notify.includes(selectedPerson) || task.cc.includes(selectedPerson)
      ),
    [selectedPerson]
  )

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={{ ...pageStyle, display: "grid", placeItems: "center" }}>
        <div style={panelStyle}>
          <h1 style={{ margin: "0 0 12px", fontSize: "24px", color: "#edf7ff" }}>Task Calendar</h1>
          <button onClick={() => router.push("/admin")} style={buttonStyle}>
            Go To Admin
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header style={{ marginBottom: "12px" }}>
          <div style={{ color: "#8fd7ff", fontSize: "12px", fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase" }}>
            Office Tools
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "6px" }}>
            <button type="button" onClick={() => router.push("/admin")} style={{ ...buttonStyle, height: "36px", padding: "7px 12px" }}>
              Back
            </button>
            <h1 style={{ margin: 0, fontSize: "34px", lineHeight: 1, color: "#edf7ff" }}>Task Calendar</h1>
            <span style={{ color: "#a9c4dc", fontSize: "13px", fontWeight: 800 }}>
              {taskCalendarTasks.length} recurring reminders
            </span>
          </div>
        </header>

        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "12px" }}>
          {["All", ...people].map((person) => {
            const active = selectedPerson === person
            return (
              <button
                key={person}
                type="button"
                onClick={() => setSelectedPerson(person)}
                style={{
                  ...buttonStyle,
                  background: active
                    ? "linear-gradient(180deg, rgba(143, 215, 255, 0.96) 0%, rgba(40, 128, 190, 0.9) 100%)"
                    : buttonStyle.background,
                  color: active ? "#031b36" : buttonStyle.color,
                }}
              >
                {person}
              </button>
            )
          })}
        </div>

        <div style={panelStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: "80px" }}>Day</th>
                <th style={{ ...thStyle, width: "100px" }}>Notify</th>
                <th style={{ ...thStyle, width: "100px" }}>CC</th>
                <th style={thStyle}>Task / Email Subject</th>
                <th style={{ ...thStyle, width: "130px" }}>Company</th>
                <th style={{ ...thStyle, width: "120px" }}>Frequency</th>
                <th style={{ ...thStyle, width: "180px" }}>Active Months</th>
                <th style={{ ...thStyle, width: "120px" }}>Email</th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((task) => {
                const dueToday = dueTodayIds.has(task.id)
                const to = resolveTaskRecipients(task.notify)
                const cc = resolveTaskRecipients(task.cc)
                return (
                  <tr
                    key={task.id}
                    style={{
                      background: dueToday
                        ? "linear-gradient(90deg, rgba(73, 219, 165, 0.24), rgba(73, 219, 165, 0.08))"
                        : "rgba(5, 19, 34, 0.28)",
                      boxShadow: dueToday ? "inset 0 0 0 2px rgba(73, 219, 165, 0.42)" : "none",
                    }}
                  >
                    <td style={{ ...tdStyle, color: dueToday ? "#eafff4" : "#d9eeff", fontWeight: 900 }}>
                      {task.dayOfMonth}
                    </td>
                    <td style={tdStyle}>{task.notify.join(", ")}</td>
                    <td style={tdStyle}>{task.cc.filter((person) => person !== "SY").join(", ") || "-"}</td>
                    <td style={{ ...tdStyle, color: "#edf7ff", fontWeight: 900 }}>***** {task.task}</td>
                    <td style={tdStyle}>{task.company || "-"}</td>
                    <td style={tdStyle}>{task.frequency}</td>
                    <td style={tdStyle}>{monthNames(getTaskActiveMonths(task))}</td>
                    <td style={tdStyle}>
                      <span style={{ color: to.length ? "#bfffe5" : "#ffd6d6", fontWeight: 900 }}>
                        TO {to.length}
                      </span>
                      <span style={{ color: "#a9c4dc", fontWeight: 900 }}> / CC {cc.length}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
