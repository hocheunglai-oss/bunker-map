"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  getTaskScheduleText,
  monthNames,
  resolveTaskRecipients,
  TaskCalendarTask,
  TaskScheduleType,
  taskCalendarTasks,
  weekDays,
} from "@/data/taskCalendar"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

const STORAGE_KEY = "bunker-map-task-calendar-tasks-v2"
const SHARED_STORE_KEY = "task-calendar"
const people = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"]
const scheduleTypes: TaskScheduleType[] = ["Weekly", "Monthly", "Yearly"]

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}
const shellStyle: React.CSSProperties = { width: "min(1320px, 100%)", margin: "0 auto" }
const buttonStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-button-border)",
  borderRadius: "999px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 800,
  padding: "8px 12px",
  boxShadow: "none",
}
const panelStyle: React.CSSProperties = {
  overflow: "auto",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "22px",
  padding: "12px",
  boxShadow: "0 16px 36px #00000012",
}
const tableStyle: React.CSSProperties = { borderCollapse: "collapse", width: "100%", minWidth: "1120px" }
const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 2,
  padding: "7px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-table-head-bg)",
  color: "var(--fc-table-head-text)",
  fontSize: "10px",
  fontWeight: 900,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  textAlign: "left",
}
const tdStyle: React.CSSProperties = {
  padding: "4px 7px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  fontSize: "12px",
  lineHeight: "16px",
  verticalAlign: "middle",
}
const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "34px",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "10px",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  fontSize: "13px",
  outline: "none",
  padding: "7px 10px",
  boxSizing: "border-box",
}
const modalBackdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#1d1d1f",
  display: "grid",
  placeItems: "center",
  padding: "20px",
  zIndex: 3000,
}
const modalStyle: React.CSSProperties = {
  width: "min(700px, 100%)",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "22px",
  boxShadow: "0 18px 42px #0000001f",
  padding: "18px",
}

const primaryActionButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-primary-button-bg)",
  background: "var(--fc-admin-primary-button-bg)",
  color: "var(--fc-admin-primary-button-text)",
}

const dangerActionButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-danger-border)",
  background: "var(--fc-admin-danger-bg)",
  color: "var(--fc-admin-danger-text)",
}

function buildBlankTask(): TaskCalendarTask {
  return {
    id: `task-custom-${Date.now()}`,
    sourceRow: 0,
    scheduleType: "Monthly",
    daysOfMonth: [1],
    months: [],
    notify: [],
    cc: [],
    task: "",
    remark: "",
  }
}

function parseNumberList(value: string, min: number, max: number) {
  return Array.from(
    new Set(
      value
        .split(/[,;\s]+/)
        .map((item) => Number(item.trim()))
        .filter((item) => Number.isInteger(item) && item >= min && item <= max)
    )
  )
}

function normalizeTasks(value: unknown) {
  if (!Array.isArray(value)) return taskCalendarTasks
  const tasks = value.filter((task): task is TaskCalendarTask => {
    return task && typeof task === "object" && typeof task.id === "string" && typeof task.task === "string" && Array.isArray(task.daysOfMonth)
  })
  return tasks.length ? tasks : taskCalendarTasks
}

export default function TaskCalendarPage() {
  const router = useRouter()
  const { loading, authenticated } = useSimpleAdminAuth()
  const [tasks, setTasks] = useState<TaskCalendarTask[]>(taskCalendarTasks)
  const [selectedPerson, setSelectedPerson] = useState("All")
  const [modalOpen, setModalOpen] = useState(false)
  const [draftTask, setDraftTask] = useState<TaskCalendarTask>(buildBlankTask)
  const loadedRef = useRef(false)
  const remoteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    document.title = "Task Calendar - FC Uno"
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadTasks() {
      let fallbackTasks = taskCalendarTasks

      try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        if (stored) fallbackTasks = normalizeTasks(JSON.parse(stored))
      } catch {
        fallbackTasks = taskCalendarTasks
      }

      try {
        const response = await fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`)
        const data = await response.json()
        if (response.ok && Array.isArray(data?.payload?.tasks)) {
          fallbackTasks = normalizeTasks(data.payload.tasks)
        }
      } catch {
        // Local storage remains the fallback when the shared store is unavailable.
      }

      if (cancelled) return
      setTasks(fallbackTasks)
      loadedRef.current = true
    }

    loadTasks()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks))
  }, [tasks])

  useEffect(() => {
    if (!authenticated || !loadedRef.current) return
    if (remoteSaveTimerRef.current) clearTimeout(remoteSaveTimerRef.current)

    remoteSaveTimerRef.current = setTimeout(() => {
      void fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tasks }),
      })
    }, 700)

    return () => {
      if (remoteSaveTimerRef.current) clearTimeout(remoteSaveTimerRef.current)
    }
  }, [authenticated, tasks])

  useEffect(() => {
    return () => {
      if (remoteSaveTimerRef.current) clearTimeout(remoteSaveTimerRef.current)
    }
  }, [])

  function openAddModal() {
    setDraftTask(buildBlankTask())
    setModalOpen(true)
  }

  function openEditModal(task: TaskCalendarTask) {
    setDraftTask({ ...task, months: task.months || [] })
    setModalOpen(true)
  }

  function saveDraftTask() {
    const nextTask = {
      ...draftTask,
      task: draftTask.task.trim() || "NEW TASK",
      daysOfMonth: draftTask.scheduleType === "Weekly" ? [] : draftTask.daysOfMonth.length ? draftTask.daysOfMonth : [1],
      months: draftTask.scheduleType === "Yearly" ? draftTask.months || [] : [],
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

  function toggleDraftMonth(month: number) {
    setDraftTask((current) => {
      const months = current.months || []
      return {
        ...current,
        months: months.includes(month) ? months.filter((item) => item !== month) : [...months, month].sort((a, b) => a - b),
      }
    })
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>
  if (!authenticated) return <div style={pageStyle}><button onClick={() => router.push("/admin")} style={buttonStyle}>Go To Admin</button></div>

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header style={{ marginBottom: "12px" }}>
          <div style={{ color: "var(--fc-admin-link)", fontSize: "12px", fontWeight: 800, letterSpacing: "0.16em", textTransform: "uppercase" }}>Office Tools</div>
          <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "6px" }}>
            <button type="button" onClick={() => router.push("/admin")} style={{ ...buttonStyle, height: "36px", padding: "7px 12px" }}>Back</button>
            <h1 style={{ margin: 0, fontSize: "34px", lineHeight: 1, color: "var(--fc-admin-panel-text)" }}>Task Calendar</h1>
            <button type="button" onClick={openAddModal} aria-label="Add task" style={{ ...buttonStyle, width: "34px", height: "34px", padding: 0, fontSize: "22px" }}>+</button>
            <span style={{ color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 800 }}>{tasks.length} recurring reminders</span>
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
                  background: active ? "var(--fc-admin-selected-bg)" : buttonStyle.background,
                  color: active ? "var(--fc-admin-selected-text)" : buttonStyle.color,
                  boxShadow: "none",
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
                <th style={thStyle}>Task / Email Subject</th>
                <th style={{ ...thStyle, width: "210px" }}>Schedule</th>
                {people.map((person) => (
                  <th key={person} style={{ ...thStyle, width: "38px", textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>{person}</th>
                ))}
                <th style={{ ...thStyle, width: "80px" }}>Email</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const to = resolveTaskRecipients(task.notify)
                const cc = resolveTaskRecipients(task.cc)
                const rowHighlighted = selectedPerson !== "All" && (task.notify.includes(selectedPerson) || task.cc.includes(selectedPerson))
                return (
                  <tr
                    key={task.id}
                    onDoubleClick={() => openEditModal(task)}
                    style={{
                      background: rowHighlighted ? "var(--fc-admin-selected-bg)" : "var(--fc-row-bg)",
                      boxShadow: rowHighlighted ? "inset 0 0 0 2px var(--fc-admin-selected-border)" : "none",
                      cursor: "pointer",
                      opacity: selectedPerson !== "All" && !rowHighlighted ? 0.46 : 1,
                    }}
                  >
                    <td style={{ ...tdStyle, color: "var(--fc-admin-panel-text)", fontWeight: 900 }}>***** {task.task}</td>
                    <td style={tdStyle}>{getTaskScheduleText(task)}</td>
                    {people.map((person) => {
                      const notify = task.notify.includes(person)
                      const copied = task.cc.includes(person)
                      const personBackground = notify ? "#ffffff" : copied ? "#fff8e5" : rowHighlighted ? "var(--fc-admin-selected-bg)" : "var(--fc-row-bg)"
                      return (
                        <td key={person} style={{ ...tdStyle, textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>
                          <span style={{
                            display: "inline-grid",
                            placeItems: "center",
                            width: "28px",
                            borderRadius: "999px",
                            background: personBackground,
                            color: notify ? "var(--fc-admin-panel-text)" : copied ? "var(--fc-admin-warning-text)" : "var(--fc-admin-muted)",
                            fontSize: "10px",
                            fontWeight: notify || copied ? 900 : 500,
                          }}>{notify ? "TO" : copied ? "CC" : person}</span>
                        </td>
                      )
                    })}
                    <td style={tdStyle}>
                      <span style={{ color: to.length ? "var(--fc-admin-success-text)" : "var(--fc-admin-danger-text)", fontWeight: 900 }}>TO {to.length}</span>
                      <span style={{ color: "var(--fc-admin-muted)", fontWeight: 900 }}> / CC {cc.length}</span>
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
            <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>
              Task
              <input value={draftTask.task} onChange={(event) => setDraftTask((current) => ({ ...current, task: event.target.value }))} style={inputStyle} />
            </label>
            <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>Schedule</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "12px" }}>
              {scheduleTypes.map((scheduleType) => {
                const active = draftTask.scheduleType === scheduleType
                return (
                  <button
                    key={scheduleType}
                    type="button"
                    onClick={() => setDraftTask((current) => ({ ...current, scheduleType }))}
                    style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)" }}
                  >
                    {scheduleType}
                  </button>
                )
              })}
            </div>
            {draftTask.scheduleType === "Weekly" && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "12px" }}>
                {weekDays.map((day, index) => {
                  const active = draftTask.dayOfWeek === index
                  return (
                    <button key={day} type="button" onClick={() => setDraftTask((current) => ({ ...current, dayOfWeek: index }))} style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)" }}>
                      {day.slice(0, 3)}
                    </button>
                  )
                })}
              </div>
            )}
            {(draftTask.scheduleType === "Monthly" || draftTask.scheduleType === "Yearly") && (
              <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "12px" }}>
                Day Of Month
                <input
                  value={draftTask.daysOfMonth.join(", ")}
                  onChange={(event) => setDraftTask((current) => ({ ...current, daysOfMonth: parseNumberList(event.target.value, 1, 31) }))}
                  style={inputStyle}
                />
              </label>
            )}
            {draftTask.scheduleType === "Yearly" && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "12px" }}>
                {monthNames.map((month, index) => {
                  const value = index + 1
                  const active = (draftTask.months || []).includes(value)
                  return (
                    <button key={month} type="button" onClick={() => toggleDraftMonth(value)} style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)" }}>
                      {month}
                    </button>
                  )
                })}
              </div>
            )}
            {(["notify", "cc"] as const).map((field) => (
              <div key={field} style={{ marginBottom: "12px" }}>
                <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>{field === "notify" ? "Notify To" : "CC Copy"}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                  {people.map((person) => {
                    const active = draftTask[field].includes(person)
                    return (
                      <button key={person} type="button" onClick={() => toggleDraftPerson(person, field)} style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)", color: active ? "var(--fc-admin-selected-text)" : "var(--fc-admin-button-text)", minWidth: "42px" }}>
                        {person}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
            <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "14px" }}>
              Remark
              <input value={draftTask.remark} onChange={(event) => setDraftTask((current) => ({ ...current, remark: event.target.value }))} style={inputStyle} />
            </label>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "9px" }}>
              <button type="button" onClick={deleteDraftTask} style={dangerActionButtonStyle}>Delete</button>
              <div style={{ display: "flex", gap: "9px" }}>
                <button type="button" onClick={() => setModalOpen(false)} style={buttonStyle}>Cancel</button>
                <button type="button" onClick={saveDraftTask} style={primaryActionButtonStyle}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
