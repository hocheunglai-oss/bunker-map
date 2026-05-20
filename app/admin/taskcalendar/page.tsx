"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import {
  getDueTaskCalendarTasks,
  getTaskActiveMonths,
  resolveTaskRecipients,
  TaskCalendarTask,
  taskCalendarTasks,
} from "@/data/taskCalendar"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const STORAGE_KEY = "bunker-map-task-calendar-tasks"
const people = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"]
const frequencies: TaskCalendarTask["frequency"][] = ["1 Monthly", "2 Monthly", "4 Monthly", "4 Yearly", "6 Yearly"]

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.2), transparent 30%), radial-gradient(circle at bottom right, rgba(87, 227, 176, 0.12), transparent 28%), linear-gradient(180deg, #0a2c4c 0%, #06213b 42%, #041629 100%)",
  color: "#edf7ff",
  fontFamily: "Arial, Helvetica, sans-serif",
  padding: "18px",
}

const shellStyle: React.CSSProperties = { width: "min(1320px, 100%)", margin: "0 auto" }

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
  background: "linear-gradient(180deg, rgba(235, 244, 250, 0.16) 0%, rgba(182, 205, 218, 0.08) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.18)",
  borderRadius: "22px",
  padding: "12px",
  boxShadow: "0 30px 96px rgba(0, 0, 0, 0.28), inset 0 1px 0 rgba(255,255,255,0.08)",
  backdropFilter: "blur(18px)",
  WebkitBackdropFilter: "blur(18px)",
}

const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%", minWidth: "1180px" }

const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  padding: "7px",
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
  padding: "4px 7px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontSize: "12px",
  lineHeight: "16px",
  verticalAlign: "middle",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: "34px",
  border: "1px solid rgba(210,236,255,0.16)",
  borderRadius: "10px",
  background: "linear-gradient(180deg, rgba(246,251,255,0.98) 0%, rgba(232,243,252,0.95) 100%)",
  color: "#10243a",
  fontFamily: "Arial, Helvetica, sans-serif",
  fontSize: "13px",
  outline: "none",
  padding: "7px 10px",
  boxSizing: "border-box",
}

const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(2, 10, 18, 0.64)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  display: "grid",
  placeItems: "center",
  padding: "20px",
  zIndex: 3000,
}

const modalStyle: React.CSSProperties = {
  width: "min(640px, 100%)",
  background:
    "radial-gradient(circle at top left, rgba(88, 182, 255, 0.18), transparent 34%), linear-gradient(180deg, rgba(14, 43, 70, 0.96) 0%, rgba(7, 26, 44, 0.94) 100%)",
  border: "1px solid rgba(210,236,255,0.18)",
  borderRadius: "22px",
  boxShadow: "0 30px 96px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.08)",
  padding: "18px",
}

function monthNames(months: number[] | null) {
  if (!months) return "Every month"
  return months.map((month) => new Date(2026, month - 1, 1).toLocaleString("en-US", { month: "short" })).join(", ")
}

function buildBlankTask(): TaskCalendarTask {
  return {
    id: `task-custom-${Date.now()}`,
    sourceRow: 0,
    dayOfMonth: 1,
    notify: [],
    cc: [],
    task: "",
    company: "-",
    frequency: "1 Monthly",
    remark: "",
  }
}

function normalizeTasks(value: unknown) {
  if (!Array.isArray(value)) return taskCalendarTasks
  return value.filter((task): task is TaskCalendarTask => {
    return task && typeof task === "object" && typeof task.id === "string" && typeof task.task === "string"
  })
}

export default function TaskCalendarPage() {
  const router = useRouter()
  const { loading, authenticated } = useSimpleAdminAuth()
  const [tasks, setTasks] = useState<TaskCalendarTask[]>(taskCalendarTasks)
  const [selectedPerson, setSelectedPerson] = useState("All")
  const [modalOpen, setModalOpen] = useState(false)
  const [draftTask, setDraftTask] = useState<TaskCalendarTask>(buildBlankTask)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      if (stored) setTasks(normalizeTasks(JSON.parse(stored)))
    } catch {
      setTasks(taskCalendarTasks)
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  }, [tasks])

  const dueTodayIds = useMemo(() => new Set(getDueTaskCalendarTasks().map((task) => task.id)), [])
  const visibleTasks = useMemo(
    () =>
      tasks.filter(
        (task) => selectedPerson === "All" || task.notify.includes(selectedPerson) || task.cc.includes(selectedPerson)
      ),
    [selectedPerson, tasks]
  )

  function openAddModal() {
    setDraftTask(buildBlankTask())
    setModalOpen(true)
  }

  function openEditModal(task: TaskCalendarTask) {
    setDraftTask({ ...task })
    setModalOpen(true)
  }

  function saveDraftTask() {
    const nextTask = {
      ...draftTask,
      task: draftTask.task.trim() || "NEW TASK",
      dayOfMonth: Math.max(1, Math.min(31, Number(draftTask.dayOfMonth) || 1)),
    }
    setTasks((current) =>
      current.some((task) => task.id === nextTask.id)
        ? current.map((task) => (task.id === nextTask.id ? nextTask : task))
        : [nextTask, ...current]
    )
    setModalOpen(false)
  }

  function deleteDraftTask() {
    setTasks((current) => current.filter((task) => task.id !== draftTask.id))
    setModalOpen(false)
  }

  function toggleDraftPerson(person: string, field: "notify" | "cc") {
    setDraftTask((current) => ({
      ...current,
      [field]: current[field].includes(person)
        ? current[field].filter((item) => item !== person)
        : [...current[field], person],
    }))
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={{ ...pageStyle, display: "grid", placeItems: "center" }}>
        <div style={panelStyle}>
          <h1 style={{ margin: "0 0 12px", fontSize: "24px", color: "#edf7ff" }}>Task Calendar</h1>
          <button onClick={() => router.push("/admin")} style={buttonStyle}>Go To Admin</button>
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
            <button type="button" onClick={openAddModal} aria-label="Add task" style={{ ...buttonStyle, width: "34px", height: "34px", padding: 0, fontSize: "22px" }}>
              +
            </button>
            <span style={{ color: "#a9c4dc", fontSize: "13px", fontWeight: 800 }}>{tasks.length} recurring reminders</span>
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
                <th style={{ ...thStyle, width: "58px" }}>Day</th>
                <th style={thStyle}>Task / Email Subject</th>
                <th style={{ ...thStyle, width: "110px" }}>Company</th>
                <th style={{ ...thStyle, width: "96px" }}>Frequency</th>
                {people.map((person) => (
                  <th key={person} style={{ ...thStyle, width: "38px", textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>
                    {person}
                  </th>
                ))}
                <th style={{ ...thStyle, width: "130px" }}>Months</th>
                <th style={{ ...thStyle, width: "80px" }}>Email</th>
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
                    onDoubleClick={() => openEditModal(task)}
                    style={{
                      background: dueToday
                        ? "linear-gradient(90deg, rgba(73, 219, 165, 0.24), rgba(73, 219, 165, 0.08))"
                        : "rgba(5, 19, 34, 0.28)",
                      boxShadow: dueToday ? "inset 0 0 0 2px rgba(73, 219, 165, 0.42)" : "none",
                      cursor: "pointer",
                    }}
                  >
                    <td style={{ ...tdStyle, color: dueToday ? "#eafff4" : "#d9eeff", fontWeight: 900 }}>{task.dayOfMonth}</td>
                    <td style={{ ...tdStyle, color: "#edf7ff", fontWeight: 900 }}>***** {task.task}</td>
                    <td style={tdStyle}>{task.company || "-"}</td>
                    <td style={tdStyle}>{task.frequency}</td>
                    {people.map((person) => {
                      const notify = task.notify.includes(person)
                      const copied = task.cc.includes(person)
                      return (
                        <td key={person} style={{ ...tdStyle, textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>
                          <span
                            style={{
                              display: "inline-grid",
                              placeItems: "center",
                              width: "28px",
                              borderRadius: "999px",
                              background: notify ? "rgba(143, 215, 255, 0.24)" : copied ? "rgba(255, 218, 97, 0.2)" : "transparent",
                              color: notify ? "#d9eeff" : copied ? "#ffe895" : "rgba(31, 45, 58, 0.48)",
                              fontSize: "10px",
                              fontWeight: notify || copied ? 900 : 700,
                            }}
                          >
                            {notify ? "TO" : copied ? "CC" : person}
                          </span>
                        </td>
                      )
                    })}
                    <td style={tdStyle}>{monthNames(getTaskActiveMonths(task))}</td>
                    <td style={tdStyle}>
                      <span style={{ color: to.length ? "#bfffe5" : "#ffd6d6", fontWeight: 900 }}>TO {to.length}</span>
                      <span style={{ color: "#a9c4dc", fontWeight: 900 }}> / CC {cc.length}</span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 style={{ margin: "0 0 14px", fontSize: "24px" }}>{draftTask.sourceRow ? "Edit Task" : "New Task"}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "90px 1fr 140px", gap: "10px", marginBottom: "10px" }}>
              <label style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Day
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={draftTask.dayOfMonth}
                  onChange={(event) => setDraftTask((current) => ({ ...current, dayOfMonth: Number(event.target.value) }))}
                  style={inputStyle}
                />
              </label>
              <label style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Task
                <input
                  value={draftTask.task}
                  onChange={(event) => setDraftTask((current) => ({ ...current, task: event.target.value }))}
                  style={inputStyle}
                />
              </label>
              <label style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Company
                <input
                  value={draftTask.company}
                  onChange={(event) => setDraftTask((current) => ({ ...current, company: event.target.value }))}
                  style={inputStyle}
                />
              </label>
            </div>
            <div style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
              Frequency
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "12px" }}>
              {frequencies.map((frequency) => {
                const active = draftTask.frequency === frequency
                return (
                  <button
                    key={frequency}
                    type="button"
                    onClick={() => setDraftTask((current) => ({ ...current, frequency }))}
                    style={{ ...buttonStyle, background: active ? "rgba(143, 215, 255, 0.24)" : "rgba(2, 10, 18, 0.64)" }}
                  >
                    {frequency}
                  </button>
                )
              })}
            </div>
            {(["notify", "cc"] as const).map((field) => (
              <div key={field} style={{ marginBottom: "12px" }}>
                <div style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
                  {field === "notify" ? "Notify To" : "CC Copy"}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                  {people.map((person) => {
                    const active = draftTask[field].includes(person)
                    return (
                      <button
                        key={person}
                        type="button"
                        onClick={() => toggleDraftPerson(person, field)}
                        style={{
                          ...buttonStyle,
                          background: active ? "rgba(143, 215, 255, 0.24)" : "rgba(2, 10, 18, 0.64)",
                          color: active ? "#edf7ff" : "#8fa9bf",
                          minWidth: "42px",
                        }}
                      >
                        {person}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <label style={{ display: "block", color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "14px" }}>
              Remark
              <input
                value={draftTask.remark}
                onChange={(event) => setDraftTask((current) => ({ ...current, remark: event.target.value }))}
                style={inputStyle}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "9px" }}>
              <button
                type="button"
                onClick={deleteDraftTask}
                style={{ ...buttonStyle, borderColor: "rgba(255, 105, 105, 0.48)", color: "#ffd6d6" }}
              >
                Delete
              </button>
              <div style={{ display: "flex", gap: "9px" }}>
                <button type="button" onClick={() => setModalOpen(false)} style={buttonStyle}>Cancel</button>
                <button type="button" onClick={saveDraftTask} style={buttonStyle}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
