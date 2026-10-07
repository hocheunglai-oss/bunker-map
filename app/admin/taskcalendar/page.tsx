"use client"

import { useEffect, useRef, useState } from "react"
import {
  getTaskScheduleText,
  monthNames,
  TaskCalendarTask,
  TaskScheduleType,
  parseTaskDays,
  readTaskCalendarTasks,
  TASK_CALENDAR_PROTOCOL_VERSION,
  validateTaskCalendarTask,
  weekDays,
} from "@/data/taskCalendar"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { canAccessAdminPage, isAdminRole } from "@/lib/adminPages"
import type { CalendarStaff } from "@/lib/calendarStaff"

const SHARED_STORE_KEY = "task-calendar"
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

const appleActionButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  minHeight: "36px",
  borderRadius: "980px",
  borderColor: "var(--fc-admin-primary-button-bg)",
  background: "var(--fc-admin-primary-button-bg)",
  color: "var(--fc-admin-primary-button-text)",
  fontSize: "14px",
  fontWeight: 700,
  lineHeight: 1,
  padding: "0 17px",
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
  padding: "7px 7px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-table-head-bg)",
  color: "var(--fc-table-head-text)",
  fontSize: "11px",
  fontWeight: 900,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  textAlign: "left",
}
const tdStyle: React.CSSProperties = {
  height: "20px",
  padding: "2px 7px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  fontSize: "12px",
  lineHeight: "17px",
  verticalAlign: "middle",
  boxSizing: "border-box",
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
    id: `task-custom-${crypto.randomUUID()}`,
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

function taskHasSelectedPeople(task: TaskCalendarTask, selectedPeople: string[]) {
  if (!selectedPeople.length) return false
  return selectedPeople.some((person) => task.notify.includes(person) || task.cc.includes(person))
}

export default function TaskCalendarPage() {
  const { loading, authenticated, role, permissions } = useSimpleAdminAuth()
  const canEdit = isAdminRole(role) || canAccessAdminPage(permissions, "task-calendar", "edit")
  const [tasks, setTasks] = useState<TaskCalendarTask[]>([])
  const [taskVersions, setTaskVersions] = useState<Record<string, string>>({})
  const [staff, setStaff] = useState<CalendarStaff[]>([])
  const [calendarLoaded, setCalendarLoaded] = useState(false)
  const [calendarLoadError, setCalendarLoadError] = useState("")
  const [saveStatus, setSaveStatus] = useState("Loading shared task calendar")
  const [selectedPeople, setSelectedPeople] = useState<string[]>([])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [draftTask, setDraftTask] = useState<TaskCalendarTask>(buildBlankTask)
  const [daysOfMonthText, setDaysOfMonthText] = useState("1")
  const [draftTaskVersion, setDraftTaskVersion] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [draftError, setDraftError] = useState("")
  const dialogRef = useRef<HTMLDivElement>(null)
  const mutationPendingRef = useRef(false)
  const people = Array.from(new Set([...staff.map((person) => person.code), ...tasks.flatMap((task) => [...task.notify, ...task.cc])]))

  useEffect(() => {
    document.title = "Task Calendar - FC Uno"
  }, [])

  useEffect(() => {
    if (loading || !authenticated) return
    let cancelled = false

    async function loadTasks() {
      try {
        const response = await fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`, { cache: "no-store" })
        if (!response.ok) throw new Error("Could not load shared task calendar data.")
        const data = await response.json()
        if (data.protocolVersion !== TASK_CALENDAR_PROTOCOL_VERSION) throw new Error("Task Calendar has been updated. Refresh this page before continuing.")
        const nextTasks = readTaskCalendarTasks(data.payload)
        if (cancelled) return
        setTasks(nextTasks)
        setTaskVersions(data.taskVersions || {})
        setStaff(Array.isArray(data.staff) ? data.staff : [])
        setCalendarLoadError("")
        setSaveStatus("Shared task calendar loaded")
        setCalendarLoaded(true)
      } catch (error) {
        if (cancelled) return
        setCalendarLoadError(error instanceof Error ? error.message : "Could not load shared task calendar data.")
        setSaveStatus("Shared task calendar unavailable")
        setCalendarLoaded(true)
        return
      }
    }

    loadTasks()

    return () => {
      cancelled = true
    }
  }, [authenticated, loading])

  useEffect(() => {
    if (!modalOpen) return
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus()
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", beforeUnload)
    return () => {
      window.removeEventListener("beforeunload", beforeUnload)
      if (previousFocus?.isConnected) previousFocus.focus()
    }
  }, [modalOpen])

  function closeModal() {
    if (mutationPendingRef.current) return
    const original = draftTaskVersion ? tasks.find((task) => task.id === draftTask.id) : null
    const dirty = original
      ? JSON.stringify(draftTask) !== JSON.stringify(original) || daysOfMonthText !== original.daysOfMonth.join(", ")
      : Boolean(draftTask.task.trim() || draftTask.remark.trim() || draftTask.notify.length || draftTask.cc.length)
    if (dirty && !window.confirm("Discard your unsaved task changes?")) return
    setModalOpen(false)
  }

  async function mutateTask(operation: "create" | "update" | "delete", task?: TaskCalendarTask) {
    const response = await fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: TASK_CALENDAR_PROTOCOL_VERSION, operation, ...(task ? { task } : { taskId: draftTask.id }), ...(draftTaskVersion ? { expectedTaskVersion: draftTaskVersion } : {}) }),
    })
    const data = await response.json().catch(() => null)
    if (data?.payload && data?.taskVersions) {
      setTasks(readTaskCalendarTasks(data.payload))
      setTaskVersions(data.taskVersions)
    }
    if (!response.ok) throw new Error(data?.message || "The task could not be saved. Your draft is kept; please try again.")
    if (data?.protocolVersion !== TASK_CALENDAR_PROTOCOL_VERSION || !data?.payload || !data?.taskVersions) throw new Error("The save could not be confirmed. Keep this window open and retry; your draft is kept.")
    setSaveStatus("Shared task calendar saved")
  }

  function openAddModal() {
    if (!canEdit || mutationPendingRef.current) return
    const blankTask = buildBlankTask()
    setDraftTask(blankTask)
    setDaysOfMonthText(blankTask.daysOfMonth.join(", "))
    setDraftTaskVersion(null)
    setDraftError("")
    setModalOpen(true)
  }

  function openEditModal(task: TaskCalendarTask) {
    if (!canEdit || mutationPendingRef.current) return
    setDraftTask({ ...task, months: task.months || [] })
    setDaysOfMonthText(task.daysOfMonth.join(", "))
    setDraftTaskVersion(taskVersions[task.id] || null)
    setDraftError("")
    setModalOpen(true)
  }

  async function saveDraftTask() {
    if (!canEdit || mutationPendingRef.current) return
    setDraftError("")
    mutationPendingRef.current = true
    setSaving(true)
    try {
      const parsedDaysOfMonth = draftTask.scheduleType === "Weekly" ? [] : parseTaskDays(daysOfMonthText)
      const nextTask = validateTaskCalendarTask({ ...draftTask, daysOfMonth: parsedDaysOfMonth })
      await mutateTask(draftTaskVersion ? "update" : "create", nextTask)
      setSelectedTaskId(nextTask.id)
      setModalOpen(false)
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Could not save the task. Your draft is kept.")
    } finally {
      mutationPendingRef.current = false
      setSaving(false)
    }
  }

  async function deleteDraftTask() {
    if (!canEdit || mutationPendingRef.current || !draftTaskVersion || !window.confirm("Delete this task and stop its future reminders?")) return
    setDraftError("")
    mutationPendingRef.current = true
    setSaving(true)
    try {
      await mutateTask("delete")
      setSelectedTaskId((id) => id === draftTask.id ? null : id)
      setModalOpen(false)
    } catch (error) {
      setDraftError(error instanceof Error ? error.message : "Could not delete the task. Please try again.")
    } finally {
      mutationPendingRef.current = false
      setSaving(false)
    }
  }

  function toggleDraftPerson(person: string, field: "notify" | "cc") {
    setDraftTask((current) => ({
      ...current,
      [field]: current[field].includes(person)
        ? current[field].filter((item) => item !== person)
        : [...current[field], person],
    }))
  }

  function togglePersonHighlight(person: string) {
    setSelectedPeople((current) =>
      current.includes(person) ? current.filter((item) => item !== person) : [...current, person]
    )
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
  if (!authenticated) {
    return (
      <div style={{ ...pageStyle, display: "grid", placeItems: "center" }}>
        <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
          Please log in from the admin homepage first.
        </p>
      </div>
    )
  }

  if (!calendarLoaded) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={panelStyle}>
            <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 800 }}>
              Loading task calendar...
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (calendarLoadError) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={panelStyle}>
            <p style={{ margin: "0 0 8px", color: "var(--fc-admin-danger-text)", fontSize: "14px", fontWeight: 900 }}>
              Shared task calendar unavailable
            </p>
            <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
              {calendarLoadError} Refresh the page before making task calendar changes.
            </p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div style={shellStyle}>
        <header
          style={{
            display: "flex",
            justifyContent: "flex-start",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <div data-admin-button-style="preserve">
            <button type="button" disabled={!canEdit || saving} onClick={openAddModal} style={appleActionButtonStyle}>
              Add New Task
            </button>
          </div>
          <span
            style={{
              border: "1px solid var(--fc-admin-border-soft)",
              borderRadius: "999px",
              background: saveStatus.toLowerCase().includes("fail") || saveStatus.toLowerCase().includes("unavailable")
                ? "var(--fc-admin-danger-bg)"
                : "var(--fc-admin-panel-bg)",
              color: saveStatus.toLowerCase().includes("fail") || saveStatus.toLowerCase().includes("unavailable")
                ? "var(--fc-admin-danger-text)"
                : "var(--fc-admin-muted)",
              fontSize: "11px",
              fontWeight: 800,
              lineHeight: 1,
              padding: "8px 10px",
              whiteSpace: "nowrap",
            }}
          >
            {saveStatus}
          </span>
        </header>

        <div style={panelStyle}>
          {selectedPeople.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "10px",
                flexWrap: "wrap",
                marginBottom: "10px",
                padding: "8px 10px",
                border: "1px solid var(--fc-admin-border-soft)",
                borderRadius: "12px",
                background: "var(--fc-admin-panel-soft-bg)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "7px", flexWrap: "wrap" }}>
                <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 800 }}>
                  Highlighting
                </span>
                {selectedPeople.map((person) => (
                  <span
                    key={person}
                    style={{
                      border: "1px solid var(--fc-admin-selected-border)",
                      borderRadius: "999px",
                      background: "var(--fc-admin-selected-bg)",
                      color: "var(--fc-admin-selected-text)",
                      fontSize: "12px",
                      fontWeight: 900,
                      lineHeight: 1,
                      padding: "5px 8px",
                    }}
                  >
                    {person}
                  </span>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setSelectedPeople([])}
                style={{
                  ...buttonStyle,
                  borderColor: "transparent",
                  background: "transparent",
                  color: "var(--fc-admin-link)",
                  padding: "5px 8px",
                  fontSize: "12px",
                }}
              >
                Clear
              </button>
            </div>
          )}
          {!tasks.length && <p style={{ color: "var(--fc-admin-muted)", fontSize: "13px" }}>No scheduled tasks.</p>}
          {staff.some((person) => person.issue) && <p role="status" style={{ color: "var(--fc-admin-warning-text)", fontSize: "12px" }}>
            Staff directory needs review: {staff.filter((person) => person.issue).map((person) => `${person.code}: ${person.issue}`).join("; ")}
          </p>}
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Task</th>
                <th style={{ ...thStyle, width: "210px" }}>Schedule</th>
                {people.map((person) => {
                  const active = selectedPeople.includes(person)
                  return (
                    <th key={person} style={{ ...thStyle, width: "40px", textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>
                      <button
                        type="button"
                        aria-pressed={active}
                        title={`Highlight ${person}`}
                        onClick={() => togglePersonHighlight(person)}
                        style={{
                          width: "34px",
                          minHeight: "26px",
                          border: active ? "1px solid var(--fc-admin-link)" : "1px solid #cfd7e6",
                          borderRadius: "7px",
                          background: active ? "var(--fc-admin-link)" : "#ffffff",
                          color: active ? "#ffffff" : "var(--fc-admin-panel-text)",
                          cursor: "pointer",
                          fontSize: "11px",
                          fontWeight: 900,
                          lineHeight: 1,
                          padding: 0,
                          boxShadow: active ? "0 1px 3px #0066cc3a" : "0 1px 2px #00000012",
                        }}
                      >
                        {person}
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const rowSelected = selectedTaskId === task.id
                const rowHighlighted = taskHasSelectedPeople(task, selectedPeople)
                const rowBackground = rowSelected
                  ? "var(--fc-admin-selected-bg)"
                  : rowHighlighted ? "#edf6ff" : "var(--fc-row-bg)"
                return (
                  <tr
                    key={task.id}
                    tabIndex={0}
                    aria-selected={rowSelected}
                    onClick={() => setSelectedTaskId(task.id)}
                    onFocus={() => setSelectedTaskId(task.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return
                      event.preventDefault()
                      setSelectedTaskId(task.id)
                    }}
                    onDoubleClick={() => openEditModal(task)}
                    style={{
                      background: rowBackground,
                      boxShadow: rowSelected
                        ? "inset 0 0 0 2px var(--fc-admin-selected-border), inset 4px 0 0 var(--fc-admin-link)"
                        : rowHighlighted ? "inset 0 0 0 1px #b8d5ff, inset 4px 0 0 var(--fc-admin-link)" : "none",
                      cursor: "pointer",
                    }}
                  >
                    <td style={{ ...tdStyle, color: "var(--fc-admin-panel-text)", fontWeight: 900 }}>***** {task.task}</td>
                    <td style={tdStyle}>{getTaskScheduleText(task)}</td>
                    {people.map((person) => {
                      const notify = task.notify.includes(person)
                      const copied = task.cc.includes(person)
                      const personBackground = notify ? "#ffe8e8" : copied ? "#fff8e5" : "transparent"
                      const personBorder = notify ? "#ffc4c4" : copied ? "#f3dfaa" : "transparent"
                      return (
                        <td key={person} style={{ ...tdStyle, textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>
                          <span style={{
                            display: "inline-grid",
                            placeItems: "center",
                            width: "30px",
                            border: `1px solid ${personBorder}`,
                            borderRadius: "999px",
                            background: personBackground,
                            color: notify ? "#b4232a" : copied ? "var(--fc-admin-warning-text)" : "var(--fc-admin-muted)",
                            fontSize: "11px",
                            fontWeight: notify || copied ? 900 : 500,
                            lineHeight: "13px",
                            padding: "2px 0",
                          }}>{notify ? "TO" : copied ? "CC" : person}</span>
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {modalOpen && (
        <div style={modalBackdropStyle}>
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-calendar-dialog-title"
            aria-busy={saving}
            style={{ ...modalStyle, maxHeight: "90vh", overflow: "auto" }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.preventDefault(); closeModal(); return }
              if (event.key !== "Tab") return
              const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'))
              const first = controls[0], last = controls[controls.length - 1]
              if (!first) { event.preventDefault(); return }
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
              else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
            }}
          >
            <h2 id="task-calendar-dialog-title" style={{ margin: "0 0 14px", fontSize: "24px" }}>{draftTaskVersion ? "Edit Task" : "New Task"}</h2>
            {draftError && <p role="alert" style={{ color: "var(--fc-admin-danger-text)", fontSize: "13px" }}>{draftError}</p>}
            <fieldset disabled={saving || !canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
                    aria-pressed={active}
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
                    <button key={day} type="button" aria-pressed={active} onClick={() => setDraftTask((current) => ({ ...current, dayOfWeek: index }))} style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)" }}>
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
                  value={daysOfMonthText}
                  onChange={(event) => setDaysOfMonthText(event.target.value)}
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
                    <button key={month} type="button" aria-pressed={active} onClick={() => toggleDraftMonth(value)} style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)" }}>
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
                      <button key={person} type="button" aria-pressed={active} title={staff.find((item) => item.code === person)?.name || `${person} — staff directory review required`} onClick={() => toggleDraftPerson(person, field)} style={{ ...buttonStyle, background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)", color: active ? "var(--fc-admin-selected-text)" : "var(--fc-admin-button-text)", minWidth: "42px" }}>
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
              {draftTaskVersion ? <button type="button" onClick={deleteDraftTask} style={dangerActionButtonStyle}>Delete</button> : <span />}
              <div style={{ display: "flex", gap: "9px" }}>
                <button type="button" onClick={closeModal} style={buttonStyle}>Cancel</button>
                <button type="button" onClick={saveDraftTask} style={primaryActionButtonStyle}>{saving ? "Saving…" : "Save"}</button>
              </div>
            </div>
            </fieldset>
          </div>
        </div>
      )}
    </div>
  )
}
