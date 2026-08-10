"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  OfficeCalendarEvent,
  officeCalendarSeedEvents,
} from "@/data/eventCalendar"
import { mergeImportedEvents } from "@/lib/eventCalendarImport"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type EventCategory = "Public Holiday" | "Leave or Travel" | "Meeting Room" | "Unclassified"
type ViewMode = "upcoming" | "past" | "google"
type ModalMode = "add" | "edit" | null
type RecurrentFrequency = "daily" | "weekly" | "monthly"
type LeaveType = "Annual Leave" | "Sick Leave Notification (for medical treatment)" | "Compassionate Leave"
type GoogleCalendarEvent = {
  id: string
  calendarId: string
  title: string
  startDate: string
  endDate: string
  startTime: string
  endTime: string
  sourceEventId: string
  sourceTitle: string
}
type EmailPromptState = {
  event: ManagedEvent
  action: "created" | "updated"
  status: "idle" | "sending" | "sent" | "failed"
} | null
type LeaveRequestDraft = {
  from: string
  to: string
  type: LeaveType
  reason: string
  person: string
  status: "idle" | "sending" | "sent" | "failed"
  error: string
}
type RecurrentDraft = ManagedEvent & {
  frequency: RecurrentFrequency
  weeklyDays: number[]
  monthlyDay: number
}
type ManagedEvent = OfficeCalendarEvent & {
  eventType?: EventCategory
  uncertainPeople?: string[]
}

const STORAGE_KEY = "bunker-map-office-calendar-events"
const PEOPLE_STORAGE_KEY = "bunker-map-office-calendar-people"
const EMAIL_RECIPIENTS_STORAGE_KEY = "bunker-map-office-calendar-email-recipients"
const DELETED_EVENT_IDS_STORAGE_KEY = "bunker-map-office-calendar-deleted-event-ids"
const DELETED_REQUIRED_SEED_IDS_STORAGE_KEY = "bunker-map-office-calendar-deleted-required-seed-ids"
const SHARED_STORE_KEY = "event-calendar"
const CALENDAR_ID = "fcb.bunker@gmail.com"
const defaultPeople = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"]
const leaveTypes: LeaveType[] = [
  "Annual Leave",
  "Sick Leave Notification (for medical treatment)",
  "Compassionate Leave",
]
const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const shellStyle: React.CSSProperties = {
  width: "min(1320px, 100%)",
  margin: "0 auto",
}

const panelStyle: React.CSSProperties = {
  overflow: "auto",
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "22px",
  padding: "12px",
  boxShadow: "0 16px 36px #00000012",
}

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

const appleSecondaryButtonStyle: React.CSSProperties = {
  ...appleActionButtonStyle,
  borderColor: "var(--fc-admin-border)",
  background: "var(--fc-admin-panel-bg)",
  color: "var(--fc-admin-panel-text)",
}

const settingsButtonStyle: React.CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  width: "auto",
  minWidth: "0",
  height: "36px",
  minHeight: "36px",
  border: 0,
  background: "transparent",
  color: "var(--fc-admin-panel-text)",
  padding: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "7px",
  borderRadius: 0,
  boxShadow: "none",
  cursor: "pointer",
  fontSize: "14px",
  fontWeight: 500,
  lineHeight: 1,
}

const menuItemButtonStyle: React.CSSProperties = {
  appearance: "none",
  WebkitAppearance: "none",
  display: "flex",
  alignItems: "center",
  width: "100%",
  minHeight: "34px",
  justifyContent: "flex-start",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "10px",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-panel-text)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 700,
  padding: "9px 10px",
  boxShadow: "none",
  textAlign: "left",
}

const tabButtonBaseStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderBottom: "1px solid var(--fc-admin-border)",
  borderRadius: "13px 13px 0 0",
  background: "#e8e8ed",
  color: "var(--fc-admin-muted)",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 800,
  lineHeight: 1,
  padding: "11px 17px 10px",
  minHeight: "38px",
  boxShadow: "none",
  whiteSpace: "nowrap",
}

const tableStyle: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  minWidth: "1060px",
}

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
  height: "34px",
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
  width: "min(640px, 100%)",
  background:
    "var(--fc-admin-panel-bg)",
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

function parseLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

function toDateKey(date: Date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatDate(value: string) {
  const date = parseLocalDate(value)
  const day = String(date.getDate()).padStart(2, "0")
  const month = new Intl.DateTimeFormat("en-GB", { month: "short" }).format(date)
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date)
  return `${day} ${month} (${weekday})`
}

function formatEventRange(event: ManagedEvent) {
  if (event.startDate === event.endDate) return formatDate(event.startDate)
  return `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`
}

function formatGoogleEventDate(event: GoogleCalendarEvent) {
  if (!event.startDate) return "-"
  if (!event.endDate || event.startDate === event.endDate) return formatDate(event.startDate)
  return `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`
}

function formatGoogleEventTime(event: GoogleCalendarEvent) {
  if (!event.startTime && !event.endTime) return "All Day"
  if (event.startTime && event.endTime) return `${event.startTime}-${event.endTime}`
  return event.startTime || event.endTime || "-"
}

function addDaysToKey(dateKey: string, days: number) {
  const date = parseLocalDate(dateKey)
  date.setDate(date.getDate() + days)
  return toDateKey(date)
}

function getMeetingRoomStyle(event: GoogleCalendarEvent) {
  const title = `${event.title} ${event.sourceTitle}`.toUpperCase()

  if (title.includes("EXPRESS GLOBAL")) {
    return {
      background: "var(--fc-row-bg)",
      border: "var(--fc-row-border)",
      color: "var(--fc-admin-panel-text)",
      fontWeight: 500,
    }
  }

  if (title.includes("MARINE ENERGY")) {
    return {
      background: "#fff8e5",
      border: "#f7b500",
      color: "var(--fc-admin-warning-text)",
      fontWeight: 900,
    }
  }

  return {
    background: "var(--fc-admin-selected-bg)",
    border: "var(--fc-admin-selected-border)",
    color: "var(--fc-admin-panel-text)",
    fontWeight: 900,
  }
}

function normalizePeople(value: string[]) {
  return Array.from(new Set(value.map((item) => item.trim().toUpperCase()).filter(Boolean).filter((item) => item !== "??")))
}

function normalizeStringList(value: string[]) {
  return Array.from(new Set(value.map((item) => item.trim()).filter(Boolean)))
}

function inferCategory(event: Pick<ManagedEvent, "title" | "eventType">): EventCategory {
  const storedEventType = event.eventType as EventCategory | "Meeting" | undefined
  if (storedEventType === "Meeting") return "Meeting Room"
  if (event.eventType) return event.eventType

  const title = event.title.toLowerCase()
  if (title.includes("public holiday") || title.includes("holiday attendance")) return "Public Holiday"
  if (title.includes("leave") || title.includes("trip") || title.includes("genoa") || title.includes("vietnam")) return "Leave or Travel"
  return "Unclassified"
}

function isMeetingRoomBooked(event: Pick<ManagedEvent, "eventType">) {
  const storedEventType = event.eventType as EventCategory | "Meeting" | undefined
  return storedEventType === "Meeting Room" || storedEventType === "Meeting"
}

function parseTimeToMinutes(timeText: string) {
  const [hour, minute] = timeText.split(":").map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return hour * 60 + minute
}

function extractEventTimeRange(title: string) {
  const match = title.match(/\b([01]?\d|2[0-3])[:.]([0-5]\d)(?:\s*[-–]\s*([01]?\d|2[0-3])[:.]([0-5]\d))?\b/)
  if (!match) return null

  const start = `${match[1].padStart(2, "0")}:${match[2]}`
  const startMinutes = parseTimeToMinutes(start)
  if (startMinutes === null) return null

  const end = match[3] && match[4] ? `${match[3].padStart(2, "0")}:${match[4]}` : ""
  const endMinutes = end ? parseTimeToMinutes(end) : startMinutes + 60

  return {
    start,
    end: end || `${String(Math.floor((startMinutes + 60) / 60)).padStart(2, "0")}:${String((startMinutes + 60) % 60).padStart(2, "0")}`,
    startMinutes,
    endMinutes: endMinutes === null ? startMinutes + 60 : endMinutes,
  }
}

function getGoogleEventMinutes(event: GoogleCalendarEvent) {
  const startMinutes = event.startTime ? parseTimeToMinutes(event.startTime) : 0
  const endMinutes = event.endTime ? parseTimeToMinutes(event.endTime) : 24 * 60

  return {
    startMinutes: startMinutes ?? 0,
    endMinutes: endMinutes ?? 24 * 60,
  }
}

function normalizeStoredEvents(value: unknown): ManagedEvent[] {
  const rawEvents = Array.isArray(value) ? value : officeCalendarSeedEvents
  const events = rawEvents.filter((event): event is ManagedEvent => {
    return (
      event &&
      typeof event.id === "string" &&
      typeof event.startDate === "string" &&
      typeof event.endDate === "string" &&
      typeof event.title === "string" &&
      Array.isArray(event.people) &&
      Array.isArray(event.tags)
    )
  })

  return events.map((event) => ({
    ...event,
    people: normalizePeople(event.people),
    uncertainPeople: normalizePeople(event.uncertainPeople || []),
    eventType: inferCategory(event),
  }))
}

function isPastEvent(event: ManagedEvent, todayKey: string) {
  return event.endDate < todayKey
}

function eventHasSelectedPeople(event: ManagedEvent, selectedPeople: string[]) {
  if (!selectedPeople.length) return false
  const uncertainPeople = event.uncertainPeople || []
  return selectedPeople.some((person) => event.people.includes(person) || uncertainPeople.includes(person))
}

function buildBlankEvent(todayKey: string): ManagedEvent {
  return {
    id: `office-${Date.now()}`,
    startDate: todayKey,
    endDate: todayKey,
    title: "",
    people: [],
    uncertainPeople: [],
    tags: [],
    eventType: "Unclassified",
  }
}

function buildBlankRecurrentEvent(todayKey: string): RecurrentDraft {
  const today = parseLocalDate(todayKey)
  return {
    ...buildBlankEvent(todayKey),
    id: `recurrent-${Date.now()}`,
    frequency: "weekly",
    weeklyDays: [today.getDay()],
    monthlyDay: today.getDate(),
  }
}

function buildBlankLeaveRequest(todayKey: string, people: string[]): LeaveRequestDraft {
  return {
    from: todayKey,
    to: todayKey,
    type: "Annual Leave",
    reason: "",
    person: people[0] || "",
    status: "idle",
    error: "",
  }
}

const weekDayButtons = [
  { value: 0, label: "Sun" },
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
]

const requiredSeedEventIds = ["fc-2026-024"]

function ensureRequiredSeedEvents(events: ManagedEvent[], deletedRequiredSeedIds: string[]) {
  const requiredSeeds = officeCalendarSeedEvents.filter((event) => requiredSeedEventIds.includes(event.id))
  const deletedIds = new Set(deletedRequiredSeedIds)
  const existingIds = new Set(events.map((event) => event.id))
  const missingRequiredSeeds = normalizeStoredEvents(requiredSeeds).filter(
    (event) => !existingIds.has(event.id) && !deletedIds.has(event.id)
  )
  if (!missingRequiredSeeds.length) return events
  return [
    ...events,
    ...missingRequiredSeeds,
  ]
}

export default function EventCalendarPage() {
  const { loading, authenticated } = useSimpleAdminAuth()
  const todayKey = toDateKey(new Date())
  const tomorrowKey = addDaysToKey(todayKey, 1)
  const [events, setEvents] = useState<ManagedEvent[]>([])
  const [people, setPeople] = useState(defaultPeople)
  const [selectedPeople, setSelectedPeople] = useState<string[]>([])
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)
  const [deletedEventIds, setDeletedEventIds] = useState<string[]>([])
  const [deletedRequiredSeedIds, setDeletedRequiredSeedIds] = useState<string[]>([])
  const [calendarLoaded, setCalendarLoaded] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>("upcoming")
  const [eventModalMode, setEventModalMode] = useState<ModalMode>(null)
  const [recurrentModalOpen, setRecurrentModalOpen] = useState(false)
  const [leaveModalOpen, setLeaveModalOpen] = useState(false)
  const [peopleModalOpen, setPeopleModalOpen] = useState(false)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [addMenuOpen, setAddMenuOpen] = useState(false)
  const [draftEvent, setDraftEvent] = useState<ManagedEvent>(() => buildBlankEvent(todayKey))

  useEffect(() => {
    document.title = "Event Calendar - FC Uno"
  }, [])
  const [draftRecurrentEvent, setDraftRecurrentEvent] = useState<RecurrentDraft>(() => buildBlankRecurrentEvent(todayKey))
  const [leaveRequestDraft, setLeaveRequestDraft] = useState<LeaveRequestDraft>(() => buildBlankLeaveRequest(todayKey, defaultPeople))
  const [draftPeopleText, setDraftPeopleText] = useState(defaultPeople.join("\n"))
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [emailRecipientsText, setEmailRecipientsText] = useState("")
  const [emailPrompt, setEmailPrompt] = useState<EmailPromptState>(null)
  const [syncStatus, setSyncStatus] = useState("Sync ready")
  const [googleCalendarEvents, setGoogleCalendarEvents] = useState<GoogleCalendarEvent[]>([])
  const [googleCalendarStatus, setGoogleCalendarStatus] = useState("Calendar ready")
  const [saveStatus, setSaveStatus] = useState("Loading shared calendar")
  const [calendarLoadError, setCalendarLoadError] = useState("")
  const [holidayImportStatus, setHolidayImportStatus] = useState("")
  const [holidayImporting, setHolidayImporting] = useState(false)
  const [recoveryStatus, setRecoveryStatus] = useState("")
  const [recoveringEvents, setRecoveringEvents] = useState(false)
  const loadedRef = useRef(false)
  const remoteSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const toolsMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let cancelled = false

    async function loadCalendarData() {
      let fallbackEvents = normalizeStoredEvents(officeCalendarSeedEvents)
      let fallbackPeople = defaultPeople
      let fallbackEmailRecipients = ""
      let fallbackDeletedEventIds: string[] = []
      let fallbackDeletedRequiredSeedIds: string[] = []
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY)
        const storedPeople = window.localStorage.getItem(PEOPLE_STORAGE_KEY)
        const storedEmailRecipients = window.localStorage.getItem(EMAIL_RECIPIENTS_STORAGE_KEY)
        const storedDeletedEventIds = window.localStorage.getItem(DELETED_EVENT_IDS_STORAGE_KEY)
        const storedDeletedRequiredSeedIds = window.localStorage.getItem(DELETED_REQUIRED_SEED_IDS_STORAGE_KEY)
        if (stored) fallbackEvents = normalizeStoredEvents(JSON.parse(stored))
        if (storedPeople) fallbackPeople = normalizePeople(JSON.parse(storedPeople))
        if (storedEmailRecipients) fallbackEmailRecipients = storedEmailRecipients
        if (storedDeletedEventIds) fallbackDeletedEventIds = normalizeStringList(JSON.parse(storedDeletedEventIds))
        if (storedDeletedRequiredSeedIds) fallbackDeletedRequiredSeedIds = normalizeStringList(JSON.parse(storedDeletedRequiredSeedIds))
      } catch {
        fallbackEvents = normalizeStoredEvents(officeCalendarSeedEvents)
        fallbackPeople = defaultPeople
      }

      try {
        const response = await fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`)
        if (!response.ok) throw new Error("Could not load shared calendar data.")
        const data = await response.json()
        const payload = data?.payload

        if (response.ok && payload && typeof payload === "object") {
          if (Array.isArray(payload.events)) fallbackEvents = normalizeStoredEvents(payload.events)
          if (Array.isArray(payload.people)) fallbackPeople = normalizePeople(payload.people)
          if (typeof payload.emailRecipientsText === "string") fallbackEmailRecipients = payload.emailRecipientsText
          if (Array.isArray(payload.deletedEventIds)) {
            fallbackDeletedEventIds = normalizeStringList(payload.deletedEventIds)
          }
          if (Array.isArray(payload.deletedRequiredSeedIds)) {
            fallbackDeletedRequiredSeedIds = normalizeStringList(payload.deletedRequiredSeedIds)
          }
        }
      } catch (error) {
        if (cancelled) return
        setCalendarLoadError(error instanceof Error ? error.message : "Could not load shared calendar data.")
        setSaveStatus("Shared calendar unavailable")
        setCalendarLoaded(true)
        return
      }

      fallbackEvents = ensureRequiredSeedEvents(fallbackEvents, [...fallbackDeletedRequiredSeedIds, ...fallbackDeletedEventIds])

      if (cancelled) return
      setEvents(fallbackEvents)
      setPeople(fallbackPeople)
      setEmailRecipientsText(fallbackEmailRecipients)
      setDeletedEventIds(fallbackDeletedEventIds)
      setDeletedRequiredSeedIds(fallbackDeletedRequiredSeedIds)
      setCalendarLoadError("")
      setSaveStatus("Shared calendar loaded")
      loadedRef.current = true
      setCalendarLoaded(true)
    }

    loadCalendarData()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!loadedRef.current) return
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  }, [events])

  useEffect(() => {
    if (!loadedRef.current) return
    window.localStorage.setItem(PEOPLE_STORAGE_KEY, JSON.stringify(people))
  }, [people])

  useEffect(() => {
    if (!loadedRef.current) return
    window.localStorage.setItem(EMAIL_RECIPIENTS_STORAGE_KEY, emailRecipientsText)
  }, [emailRecipientsText])

  useEffect(() => {
    if (!loadedRef.current) return
    window.localStorage.setItem(DELETED_EVENT_IDS_STORAGE_KEY, JSON.stringify(deletedEventIds))
  }, [deletedEventIds])

  useEffect(() => {
    if (!loadedRef.current) return
    window.localStorage.setItem(DELETED_REQUIRED_SEED_IDS_STORAGE_KEY, JSON.stringify(deletedRequiredSeedIds))
  }, [deletedRequiredSeedIds])

  useEffect(() => {
    if (!authenticated || !loadedRef.current) return
    if (remoteSaveTimerRef.current) clearTimeout(remoteSaveTimerRef.current)

    remoteSaveTimerRef.current = setTimeout(() => {
      setSaveStatus("Saving shared calendar")
      void fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events, people, emailRecipientsText, deletedEventIds, deletedRequiredSeedIds }),
      })
        .then(async (response) => {
          if (!response.ok) {
            const payload = await response.json().catch(() => null)
            throw new Error(payload?.message || "Shared calendar save failed")
          }
          setSaveStatus("Shared calendar saved")
        })
        .catch((error) => {
          setSaveStatus(error instanceof Error ? error.message : "Shared calendar save failed")
        })
    }, 700)

    return () => {
      if (remoteSaveTimerRef.current) clearTimeout(remoteSaveTimerRef.current)
    }
  }, [authenticated, deletedEventIds, deletedRequiredSeedIds, emailRecipientsText, events, people])

  useEffect(() => {
    if (!authenticated || !loadedRef.current) return
    const currentYear = new Date().getFullYear()
    const years = [currentYear, currentYear + 1].join(",")
    let cancelled = false

    async function importPublicHolidays() {
      setHolidayImportStatus("Importing holidays")

      try {
        const response = await fetch(`/api/event-calendar/public-holidays?years=${years}`)
        const payload = await response.json()

        if (!response.ok || !Array.isArray(payload.events)) {
          setHolidayImportStatus("Holiday import pending")
          return
        }

        if (cancelled) return
        setEvents((current) => mergeImportedEvents(current, normalizeStoredEvents(payload.events)))
        setHolidayImportStatus(`Holidays ready ${years.replace(",", "-")}`)
      } catch {
        if (!cancelled) setHolidayImportStatus("Holiday import pending")
      }
    }

    importPublicHolidays()

    return () => {
      cancelled = true
    }
  }, [authenticated])

  useEffect(() => {
    if (!authenticated || !loadedRef.current) return
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current)

    syncTimerRef.current = setTimeout(async () => {
      const meetingEvents = events.filter((event) => isMeetingRoomBooked(event))

      setSyncStatus("Syncing Google")

      try {
        const response = await fetch("/api/event-calendar/google-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendarId: CALENDAR_ID, events: meetingEvents, activeEventIds: meetingEvents.map((event) => event.id) }),
        })
        const payload = await response.json()

        if (!response.ok) {
          setSyncStatus(payload.message || "Google sync pending")
          return
        }

        setSyncStatus(`Synced ${payload.updated + payload.inserted} events${payload.deleted ? `, removed ${payload.deleted}` : ""}`)
        if (viewMode === "google") {
          setGoogleCalendarEvents((current) =>
            current.filter((event) => !event.sourceEventId || meetingEvents.some((item) => item.id === event.sourceEventId))
          )
        }
      } catch {
        setSyncStatus("Google sync pending")
      }
    }, 1200)

    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
  }, [authenticated, events, viewMode])

  useEffect(() => {
    if (!authenticated || viewMode !== "google") return
    let cancelled = false

    async function loadGoogleCalendarEvents() {
      setGoogleCalendarStatus("Loading Meeting Room")

      try {
        const response = await fetch(`/api/event-calendar/google-events?calendarId=${encodeURIComponent(CALENDAR_ID)}`)
        const payload = await response.json()

        if (!response.ok || !Array.isArray(payload.events)) {
          setGoogleCalendarStatus(payload.message || "Meeting Room pending")
          return
        }

        if (cancelled) return
        setGoogleCalendarEvents(payload.events)
        setGoogleCalendarStatus(`${payload.events.length} Meeting Room events`)
      } catch {
        if (!cancelled) setGoogleCalendarStatus("Meeting Room pending")
      }
    }

    loadGoogleCalendarEvents()

    return () => {
      cancelled = true
    }
  }, [authenticated, viewMode])

  useEffect(() => {
    return () => {
      if (remoteSaveTimerRef.current) clearTimeout(remoteSaveTimerRef.current)
      if (toolsMenuCloseTimerRef.current) clearTimeout(toolsMenuCloseTimerRef.current)
      if (addMenuCloseTimerRef.current) clearTimeout(addMenuCloseTimerRef.current)
    }
  }, [])

  async function sendEventEmail(event: ManagedEvent, action: "created" | "updated") {
    const response = await fetch("/api/event-calendar/email-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, event, recipients: emailRecipientsText }),
      })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.message || "Email notification failed.")
    }
  }

  const visibleEvents = useMemo(() => {
    if (viewMode === "google") return []

    return events
      .filter((event) => (viewMode === "past" ? isPastEvent(event, todayKey) : !isPastEvent(event, todayKey)))
      .sort(
        (a, b) =>
          (viewMode === "past" ? b.endDate.localeCompare(a.endDate) : a.startDate.localeCompare(b.startDate)) ||
          (viewMode === "past" ? b.startDate.localeCompare(a.startDate) : 0) ||
          (viewMode === "past"
            ? (b.sourceRow || Number.MIN_SAFE_INTEGER) - (a.sourceRow || Number.MIN_SAFE_INTEGER)
            : (a.sourceRow || Number.MAX_SAFE_INTEGER) - (b.sourceRow || Number.MAX_SAFE_INTEGER)) ||
          a.title.localeCompare(b.title)
      )
  }, [events, todayKey, viewMode])

  const highlightedEventCount = useMemo(() => {
    if (!selectedPeople.length) return 0
    return visibleEvents.filter((event) => eventHasSelectedPeople(event, selectedPeople)).length
  }, [selectedPeople, visibleEvents])

  function openAddModal() {
    setDraftEvent(buildBlankEvent(todayKey))
    setAddMenuOpen(false)
    setToolsMenuOpen(false)
    setEventModalMode("add")
  }

  function openRecurrentModal() {
    setDraftRecurrentEvent(buildBlankRecurrentEvent(todayKey))
    setAddMenuOpen(false)
    setToolsMenuOpen(false)
    setRecurrentModalOpen(true)
  }

  function openLeaveModal() {
    setLeaveRequestDraft(buildBlankLeaveRequest(todayKey, people))
    setAddMenuOpen(false)
    setToolsMenuOpen(false)
    setLeaveModalOpen(true)
  }

  function openEditModal(event: ManagedEvent) {
    setDraftEvent({
      ...event,
      people: normalizePeople(event.people),
      uncertainPeople: normalizePeople(event.uncertainPeople || []),
      eventType: inferCategory(event),
    })
    setEventModalMode("edit")
  }

  async function findMeetingRoomConflicts(event: ManagedEvent) {
    if (!isMeetingRoomBooked(event)) return []

    const bookingTime = extractEventTimeRange(event.title)
    if (!bookingTime) return []

    try {
      const response = await fetch(
        `/api/event-calendar/google-events?calendarId=${encodeURIComponent(CALENDAR_ID)}&timeMin=${encodeURIComponent(`${event.startDate}T00:00:00+08:00`)}&timeMax=${encodeURIComponent(`${event.startDate}T23:59:59+08:00`)}`
      )
      const payload = await response.json()
      if (!response.ok || !Array.isArray(payload.events)) return []

      return (payload.events as GoogleCalendarEvent[]).filter((googleEvent) => {
        if (googleEvent.sourceEventId && googleEvent.sourceEventId === event.id) return false
        if (googleEvent.startDate !== event.startDate) return false

        const googleTime = getGoogleEventMinutes(googleEvent)
        return bookingTime.startMinutes < googleTime.endMinutes && bookingTime.endMinutes > googleTime.startMinutes
      })
    } catch {
      return []
    }
  }

  async function saveDraftEvent() {
    const action = eventModalMode === "edit" ? "save these changes" : "create this event"
    if (!window.confirm(`Are you sure you want to ${action}?`)) return

    const nextEvent: ManagedEvent = {
      ...draftEvent,
      title: draftEvent.title.trim() || "NEW EVENT",
      people: normalizePeople(draftEvent.people),
      uncertainPeople: normalizePeople(draftEvent.uncertainPeople || []),
      endDate: draftEvent.endDate >= draftEvent.startDate ? draftEvent.endDate : draftEvent.startDate,
      eventType: draftEvent.eventType || "Unclassified",
    }

    const conflicts = await findMeetingRoomConflicts(nextEvent)
    if (conflicts.length) {
      const conflictText = conflicts
        .slice(0, 3)
        .map((event) => `${formatGoogleEventTime(event)} ${event.title}`)
        .join("\n")
      const proceed = window.confirm(
        `Meeting room booking conflict found:\n\n${conflictText}\n\nDo you still want to save this event?`
      )
      if (!proceed) return
    }

    setEvents((current) => {
      if (eventModalMode === "edit") {
        return current.map((event) => (event.id === nextEvent.id ? nextEvent : event))
      }
      return [nextEvent, ...current]
    })
    setEmailPrompt({
      event: nextEvent,
      action: eventModalMode === "edit" ? "updated" : "created",
      status: "idle",
    })
    setEventModalMode(null)
  }

  async function confirmEventEmailSend() {
    if (!emailPrompt || emailPrompt.status === "sending") return
    setEmailPrompt((current) => current && { ...current, status: "sending" })

    try {
      await sendEventEmail(emailPrompt.event, emailPrompt.action)
      setEmailPrompt((current) => current && { ...current, status: "sent" })
      window.setTimeout(() => setEmailPrompt(null), 900)
    } catch {
      setEmailPrompt((current) => current && { ...current, status: "failed" })
    }
  }

  function saveRecurrentEvents() {
    if (!window.confirm("Are you sure you want to create these recurrent events?")) return

    const rangeStart = parseLocalDate(draftRecurrentEvent.startDate)
    const rangeEnd = parseLocalDate(
      draftRecurrentEvent.endDate >= draftRecurrentEvent.startDate ? draftRecurrentEvent.endDate : draftRecurrentEvent.startDate
    )
    const occurrenceDates: string[] = []

    if (draftRecurrentEvent.frequency === "daily") {
      for (const cursor = new Date(rangeStart); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
        occurrenceDates.push(toDateKey(cursor))
      }
    }

    if (draftRecurrentEvent.frequency === "weekly") {
      for (const cursor = new Date(rangeStart); cursor <= rangeEnd; cursor.setDate(cursor.getDate() + 1)) {
        if (draftRecurrentEvent.weeklyDays.includes(cursor.getDay())) {
          occurrenceDates.push(toDateKey(cursor))
        }
      }
    }

    if (draftRecurrentEvent.frequency === "monthly") {
      const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1)
      while (cursor <= rangeEnd) {
        const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), draftRecurrentEvent.monthlyDay)
        if (candidate.getMonth() === cursor.getMonth() && candidate >= rangeStart && candidate <= rangeEnd) {
          occurrenceDates.push(toDateKey(candidate))
        }
        cursor.setMonth(cursor.getMonth() + 1)
      }
    }

    const nextEvents = occurrenceDates.map((dateKey, index) => ({
      ...draftRecurrentEvent,
      id: `recurrent-${Date.now()}-${index}`,
      title: draftRecurrentEvent.title.trim() || "NEW EVENT",
      people: normalizePeople(draftRecurrentEvent.people),
      uncertainPeople: normalizePeople(draftRecurrentEvent.uncertainPeople || []),
      startDate: dateKey,
      endDate: dateKey,
      eventType: draftRecurrentEvent.eventType || "Unclassified",
    }))

    setEvents((current) => [...nextEvents, ...current])
    setRecurrentModalOpen(false)
  }

  async function sendLeaveRequest() {
    if (!leaveRequestDraft.person || leaveRequestDraft.status === "sending") return
    setLeaveRequestDraft((current) => ({ ...current, status: "sending", error: "" }))

    try {
      const response = await fetch("/api/event-calendar/leave-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leaveRequestDraft),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.message || "Leave request failed.")
      setLeaveRequestDraft((current) => ({ ...current, status: "sent", error: "" }))
      window.setTimeout(() => setLeaveModalOpen(false), 900)
    } catch (error) {
      setLeaveRequestDraft((current) => ({
        ...current,
        status: "failed",
        error: error instanceof Error ? error.message : "Leave request failed.",
      }))
    }
  }

  function togglePersonFilter(person: string) {
    setSelectedPeople((current) =>
      current.includes(person) ? current.filter((item) => item !== person) : [...current, person]
    )
  }

  function cycleDraftPerson(person: string) {
    setDraftEvent((current) => {
      const attending = current.people.includes(person)
      const uncertain = (current.uncertainPeople || []).includes(person)

      if (!attending && !uncertain) {
        return {
          ...current,
          people: [...current.people, person],
          uncertainPeople: (current.uncertainPeople || []).filter((item) => item !== person),
        }
      }

      if (attending) {
        return {
          ...current,
          people: current.people.filter((item) => item !== person),
          uncertainPeople: [...(current.uncertainPeople || []), person],
        }
      }

      return {
        ...current,
        uncertainPeople: (current.uncertainPeople || []).filter((item) => item !== person),
      }
    })
  }

  function toggleDraftWeeklyDay(day: number) {
    setDraftRecurrentEvent((current) => {
      const hasDay = current.weeklyDays.includes(day)
      const nextDays = hasDay
        ? current.weeklyDays.filter((item) => item !== day)
        : [...current.weeklyDays, day].sort((a, b) => a - b)

      return {
        ...current,
        weeklyDays: nextDays.length ? nextDays : [day],
      }
    })
  }

  function openPeopleModal() {
    setDraftPeopleText(people.join("\n"))
    setToolsMenuOpen(false)
    setPeopleModalOpen(true)
  }

  function cancelToolsMenuClose() {
    if (toolsMenuCloseTimerRef.current) {
      clearTimeout(toolsMenuCloseTimerRef.current)
      toolsMenuCloseTimerRef.current = null
    }
  }

  function scheduleToolsMenuClose() {
    cancelToolsMenuClose()
    toolsMenuCloseTimerRef.current = setTimeout(() => {
      setToolsMenuOpen(false)
    }, 650)
  }

  function cancelAddMenuClose() {
    if (addMenuCloseTimerRef.current) {
      clearTimeout(addMenuCloseTimerRef.current)
      addMenuCloseTimerRef.current = null
    }
  }

  function scheduleAddMenuClose() {
    cancelAddMenuClose()
    addMenuCloseTimerRef.current = setTimeout(() => {
      setAddMenuOpen(false)
    }, 650)
  }

  function savePeople() {
    const nextPeople = normalizePeople(draftPeopleText.split(/\n|,/))
    setPeople(nextPeople)
    setEvents((current) =>
      current.map((event) => ({
        ...event,
        people: event.people.filter((person) => nextPeople.includes(person)),
        uncertainPeople: (event.uncertainPeople || []).filter((person) => nextPeople.includes(person)),
      }))
    )
    setSelectedPeople((current) => current.filter((person) => nextPeople.includes(person)))
    setPeopleModalOpen(false)
  }

  function openEmailModal() {
    setToolsMenuOpen(false)
    setEmailModalOpen(true)
  }

  async function importNextYearPublicHolidays() {
    if (holidayImporting) return
    const nextYear = new Date().getFullYear() + 1
    setToolsMenuOpen(false)
    setHolidayImporting(true)
    setHolidayImportStatus(`Importing ${nextYear} holidays`)

    try {
      const response = await fetch(`/api/event-calendar/public-holidays?years=${nextYear}&countries=TW,US,SG`)
      const payload = await response.json()

      if (!response.ok || !Array.isArray(payload.events)) {
        setHolidayImportStatus(`${nextYear} holiday import pending`)
        return
      }

      setEvents((current) => mergeImportedEvents(current, normalizeStoredEvents(payload.events)))
      setHolidayImportStatus(`${nextYear} holidays added`)
    } catch {
      setHolidayImportStatus(`${nextYear} holiday import pending`)
    } finally {
      setHolidayImporting(false)
    }
  }

  async function importNextYearHongKongHolidays() {
    if (holidayImporting) return
    const nextYear = new Date().getFullYear() + 1
    setToolsMenuOpen(false)
    setHolidayImporting(true)
    setHolidayImportStatus(`Importing ${nextYear} Hong Kong holidays`)

    try {
      const response = await fetch(
        `/api/event-calendar/public-holidays?years=${nextYear}&countries=HK&titleStyle=holiday-attendance`
      )
      const payload = await response.json()

      if (!response.ok || !Array.isArray(payload.events)) {
        setHolidayImportStatus(`${nextYear} Hong Kong holiday import pending`)
        return
      }

      setEvents((current) => mergeImportedEvents(current, normalizeStoredEvents(payload.events)))
      setHolidayImportStatus(`${nextYear} Hong Kong holidays added`)
    } catch {
      setHolidayImportStatus(`${nextYear} Hong Kong holiday import pending`)
    } finally {
      setHolidayImporting(false)
    }
  }

  async function recoverMissingEvents() {
    if (recoveringEvents) return
    if (!window.confirm("Restore missing future events found in audit history?")) return

    setToolsMenuOpen(false)
    setRecoveringEvents(true)
    setRecoveryStatus("Inspecting audit history")

    try {
      const response = await fetch("/api/event-calendar/recover-missing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      })
      const payload = await response.json()
      if (!response.ok || !Array.isArray(payload.restoredEvents)) {
        throw new Error(payload?.message || "Could not recover missing events.")
      }

      const restoredEvents = normalizeStoredEvents(payload.restoredEvents)
      setEvents((current) => mergeImportedEvents(current, restoredEvents))
      setRecoveryStatus(
        payload.restoredCount
          ? `Recovered ${payload.restoredCount} missing events`
          : "No missing future events found"
      )
    } catch (error) {
      setRecoveryStatus(error instanceof Error ? error.message : "Could not recover missing events.")
    } finally {
      setRecoveringEvents(false)
    }
  }

  function deleteDraftEvent() {
    if (eventModalMode !== "edit") return
    if (!window.confirm("Are you sure you want to delete this event?")) return

    setEvents((current) => {
      const nextEvents = current.filter((event) => event.id !== draftEvent.id)
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextEvents))
      return nextEvents
    })
    setDeletedEventIds((current) => {
      const nextDeletedIds = current.includes(draftEvent.id) ? current : [...current, draftEvent.id]
      window.localStorage.setItem(DELETED_EVENT_IDS_STORAGE_KEY, JSON.stringify(nextDeletedIds))
      return nextDeletedIds
    })
    if (requiredSeedEventIds.includes(draftEvent.id)) {
      setDeletedRequiredSeedIds((current) => {
        const nextDeletedIds = current.includes(draftEvent.id) ? current : [...current, draftEvent.id]
        window.localStorage.setItem(DELETED_REQUIRED_SEED_IDS_STORAGE_KEY, JSON.stringify(nextDeletedIds))
        return nextDeletedIds
      })
    }
    setEventModalMode(null)
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={{ ...pageStyle, display: "grid", placeItems: "center" }}>
        <div style={modalStyle}>
          <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
            Please log in from the admin homepage first.
          </p>
        </div>
      </div>
    )
  }

  if (!calendarLoaded) {
    return (
      <div style={pageStyle}>
        <div style={shellStyle}>
          <div style={panelStyle}>
            <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 800 }}>
              Loading calendar...
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
              Shared calendar unavailable
            </p>
            <p style={{ margin: 0, color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
              {calendarLoadError} Refresh the page before making calendar changes.
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
            justifyContent: "space-between",
            alignItems: "center",
            gap: "16px",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <div
            data-admin-button-style="preserve"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-start",
              gap: "8px",
              flexWrap: "wrap",
            }}
          >
            <div
              style={{ position: "relative" }}
              onMouseEnter={cancelAddMenuClose}
              onMouseLeave={scheduleAddMenuClose}
            >
              <button
                type="button"
                onClick={() => {
                  cancelAddMenuClose()
                  setToolsMenuOpen(false)
                  setAddMenuOpen((current) => !current)
                }}
                aria-expanded={addMenuOpen}
                style={{ ...appleActionButtonStyle, display: "inline-flex", alignItems: "center" }}
              >
                Add Event
              </button>
              {addMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "42px",
                    left: 0,
                    zIndex: 30,
                    minWidth: "198px",
                    padding: "7px",
                    border: "1px solid var(--fc-admin-border)",
                    borderRadius: "14px",
                    background: "var(--fc-admin-panel-bg)",
                    boxShadow: "0 16px 36px #00000018",
                  }}
                >
                  <button type="button" onClick={openAddModal} style={{ ...menuItemButtonStyle, marginBottom: "3px" }}>
                    Add New Event
                  </button>
                  <button type="button" onClick={openRecurrentModal} style={menuItemButtonStyle}>
                    Add Recurrent Event
                  </button>
                </div>
              )}
            </div>
            <button type="button" onClick={openLeaveModal} style={appleSecondaryButtonStyle}>
              Send Leave Request
            </button>
          </div>
          <div
            data-admin-button-style="preserve"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "8px",
              flexWrap: "wrap",
              marginLeft: "auto",
            }}
          >
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
            <div
              style={{ position: "relative" }}
              onMouseEnter={cancelToolsMenuClose}
              onMouseLeave={scheduleToolsMenuClose}
            >
              <button
                type="button"
                onClick={() => {
                  cancelToolsMenuClose()
                  setAddMenuOpen(false)
                  setToolsMenuOpen((current) => !current)
                }}
                aria-label="Event calendar settings"
                title="Settings"
                style={settingsButtonStyle}
              >
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  width="19"
                  height="19"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" />
                  <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 0 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1A2 2 0 0 1 4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.3 7A2 2 0 1 1 7.1 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1A2 2 0 0 1 19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4H21a1.7 1.7 0 0 0-1.6 1Z" />
                </svg>
                <span>Settings</span>
              </button>
              {toolsMenuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "42px",
                    right: 0,
                    zIndex: 30,
                    minWidth: "246px",
                    padding: "7px",
                    border: "1px solid var(--fc-admin-border)",
                    borderRadius: "14px",
                    background: "var(--fc-admin-panel-bg)",
                    boxShadow: "0 16px 36px #00000018",
                  }}
                >
                  <button type="button" onClick={openEmailModal} style={{ ...menuItemButtonStyle, marginBottom: "3px" }}>
                    Edit Email List
                  </button>
                  <button type="button" onClick={openPeopleModal} style={{ ...menuItemButtonStyle, marginBottom: "3px" }}>
                    Edit People List
                  </button>
                  <button
                    type="button"
                    onClick={importNextYearPublicHolidays}
                    disabled={holidayImporting}
                    style={{
                      ...menuItemButtonStyle,
                      whiteSpace: "normal",
                      marginBottom: "3px",
                      opacity: holidayImporting ? 0.58 : 1,
                      cursor: holidayImporting ? "not-allowed" : "pointer",
                    }}
                  >
                    Add USA, Taiwan, Singapore Holidays
                  </button>
                  <button
                    type="button"
                    onClick={importNextYearHongKongHolidays}
                    disabled={holidayImporting}
                    style={{
                      ...menuItemButtonStyle,
                      whiteSpace: "normal",
                      opacity: holidayImporting ? 0.58 : 1,
                      cursor: holidayImporting ? "not-allowed" : "pointer",
                    }}
                  >
                    Add HK Holidays
                  </button>
                  <button
                    type="button"
                    onClick={recoverMissingEvents}
                    disabled={recoveringEvents}
                    style={{
                      ...menuItemButtonStyle,
                      whiteSpace: "normal",
                      marginTop: "3px",
                      opacity: recoveringEvents ? 0.58 : 1,
                      cursor: recoveringEvents ? "not-allowed" : "pointer",
                    }}
                  >
                    Recover Missing Events
                  </button>
                  {holidayImportStatus && (
                    <div style={{ marginTop: "5px", padding: "7px 9px", color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 700 }}>
                      {holidayImportStatus}
                    </div>
                  )}
                  {recoveryStatus && (
                    <div style={{ marginTop: "5px", padding: "7px 9px", color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 700 }}>
                      {recoveryStatus}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        <div
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: "3px",
            marginBottom: "-1px",
            paddingLeft: "10px",
            overflowX: "auto",
          }}
        >
          {(["upcoming", "past", "google"] as ViewMode[]).map((mode) => {
            const active = viewMode === mode
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => setViewMode(mode)}
                style={{
                  ...tabButtonBaseStyle,
                  position: "relative",
                  zIndex: active ? 2 : 1,
                  background: active ? "var(--fc-admin-panel-bg)" : "#e8e8ed",
                  borderBottomColor: active ? "var(--fc-admin-panel-bg)" : "var(--fc-admin-border)",
                  color: active ? "var(--fc-admin-panel-text)" : "var(--fc-admin-muted)",
                  paddingTop: active ? "12px" : "10px",
                  paddingBottom: active ? "11px" : "9px",
                }}
              >
                {mode === "upcoming" ? "Upcoming Events" : mode === "past" ? "Past Events" : "Meeting Room"}
              </button>
            )
          })}
        </div>

        <div style={{ ...panelStyle, borderTopLeftRadius: "18px" }}>
          {viewMode === "google" ? (
            <table style={{ ...tableStyle, minWidth: "760px" }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, width: "150px" }}>Date</th>
                  <th style={{ ...thStyle, width: "120px" }}>Time</th>
                  <th style={thStyle}>Event</th>
                </tr>
              </thead>
              <tbody>
                {googleCalendarEvents.map((event) => {
                  const meetingStyle = getMeetingRoomStyle(event)
                  const canEditMeetingRoom = event.title === "MARINE ENERGY" && Boolean(event.sourceEventId)

                  return (
                    <tr
                      key={event.id}
                      onClick={() => setSelectedRowId(`google:${event.id}`)}
                      onDoubleClick={() => {
                        if (!canEditMeetingRoom) return
                        const matchingEvent = events.find((item) => item.id === event.sourceEventId)
                        if (matchingEvent) openEditModal(matchingEvent)
                      }}
                      style={{
                        background: selectedRowId === `google:${event.id}` ? "#eaf4ff" : meetingStyle.background,
                        cursor: canEditMeetingRoom ? "pointer" : "default",
                        boxShadow: selectedRowId === `google:${event.id}` ? "inset 0 0 0 1px #cfe4ff" : "none",
                      }}
                    >
                      <td style={{ ...tdStyle, color: meetingStyle.color, fontWeight: meetingStyle.fontWeight, whiteSpace: "nowrap", borderLeft: `4px solid ${meetingStyle.border}` }}>
                        {formatGoogleEventDate(event)}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--fc-admin-panel-text)", fontWeight: meetingStyle.fontWeight, whiteSpace: "nowrap" }}>
                        {formatGoogleEventTime(event)}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--fc-admin-panel-text)", fontWeight: meetingStyle.fontWeight }}>
                        {event.title}
                        {event.sourceTitle && event.sourceTitle.toUpperCase() !== event.title.toUpperCase() && (
                          <span style={{ color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 800, marginLeft: "8px" }}>
                            {event.sourceTitle}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {!googleCalendarEvents.length && (
                  <tr>
                    <td colSpan={3} style={{ ...tdStyle, height: "42px", color: "var(--fc-admin-muted)", fontWeight: 900 }}>
                      {googleCalendarStatus}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ) : (
            <>
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
                    <span style={{ color: "var(--fc-admin-muted)", fontSize: "12px", fontWeight: 800 }}>
                      {highlightedEventCount} highlighted
                    </span>
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
              <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, width: "150px" }}>
                    Date
                  </th>
                  <th style={thStyle}>
                    Event
                  </th>
                  {people.map((person) => {
                    const active = selectedPeople.includes(person)
                    return (
                      <th key={person} style={{ ...thStyle, width: "40px", textAlign: "center", paddingLeft: "3px", paddingRight: "3px" }}>
                        <button
                          type="button"
                          aria-pressed={active}
                          title={`Highlight ${person}`}
                          onClick={() => togglePersonFilter(person)}
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
                {visibleEvents.map((event) => {
                  const meetingRoomBooked = isMeetingRoomBooked(event)
                  const rowHighlighted = eventHasSelectedPeople(event, selectedPeople)
                  const isTodayEvent = event.startDate <= todayKey && event.endDate >= todayKey
                  const isTomorrowEvent = !isTodayEvent && event.startDate <= tomorrowKey && event.endDate >= tomorrowKey
                  const rowBackground = isTodayEvent
                    ? "#fff8e5"
                    : isTomorrowEvent
                      ? "#fff1df"
                      : "var(--fc-row-bg)"
                  const rowBorder = isTodayEvent
                    ? "#f7b500"
                    : isTomorrowEvent
                      ? "#ff9f1c"
                      : "var(--fc-row-border)"
                  const rowSelected = selectedRowId === `event:${event.id}`
                  const rowDisplayBackground = rowSelected ? "#eaf4ff" : rowHighlighted ? "#edf6ff" : rowBackground
                  const rowDisplayBorder = rowSelected ? "#cfe4ff" : rowHighlighted ? "var(--fc-admin-selected-border)" : rowBorder

                  return (
                    <tr
                      key={event.id}
                      onClick={() => setSelectedRowId(`event:${event.id}`)}
                      style={{
                        background: rowDisplayBackground,
                        boxShadow: rowSelected
                          ? "inset 0 0 0 1px #cfe4ff"
                          : rowHighlighted
                            ? "inset 0 0 0 1px #b8d5ff, inset 4px 0 0 var(--fc-admin-link)"
                            : "none",
                      }}
                    >
                      <td
                        onDoubleClick={() => openEditModal(event)}
                        style={{
                          ...tdStyle,
                          color: "var(--fc-admin-panel-text)",
                          fontWeight: isTodayEvent ? 900 : 500,
                          whiteSpace: "nowrap",
                          borderLeft: `4px solid ${rowDisplayBorder}`,
                        }}
                      >
                        {formatEventRange(event)}
                      </td>
                      <td
                        onDoubleClick={() => openEditModal(event)}
                        style={{ ...tdStyle, color: "var(--fc-admin-panel-text)", fontWeight: isTodayEvent ? 900 : 500 }}
                      >
                        {event.title}
                        {meetingRoomBooked && (
                          <span style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, marginLeft: "8px" }}>
                            MEETING ROOM BOOKED
                          </span>
                        )}
                      </td>
                      {people.map((person) => {
                        const attending = event.people.includes(person)
                        const uncertain = (event.uncertainPeople || []).includes(person)
                        const highlighted = selectedPeople.includes(person) && (attending || uncertain)
                        return (
                          <td
                            key={person}
                            onDoubleClick={() => openEditModal(event)}
                            style={{ ...tdStyle, textAlign: "center", paddingLeft: "3px", paddingRight: "3px", cursor: "pointer" }}
                          >
                            <span
                              title="Double-click the event row to edit attendance"
                              style={{
                                display: "inline-block",
                                pointerEvents: "none",
                                userSelect: "none",
                                width: "30px",
                                border: highlighted
                                  ? "1px solid var(--fc-admin-selected-border)"
                                  : uncertain || attending
                                    ? "1px solid var(--fc-admin-border-soft)"
                                    : "1px solid #00000000",
                                borderRadius: "999px",
                                background: attending
                                  ? "#ffffff"
                                  : uncertain
                                    ? "#fff8e5"
                                    : rowDisplayBackground,
                                color: attending
                                  ? "var(--fc-admin-panel-text)"
                                  : uncertain
                                    ? "var(--fc-admin-warning-text)"
                                    : "color-mix(in srgb, var(--fc-row-bg) 78%, var(--fc-admin-panel-text) 22%)",
                                cursor: "default",
                                fontSize: "11px",
                                fontWeight: attending || uncertain ? 900 : 400,
                                lineHeight: "13px",
                                padding: "2px 0",
                              }}
                            >
                              {uncertain ? "??" : person}
                            </span>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
                {!visibleEvents.length && (
                  <tr>
                    <td
                      colSpan={2 + people.length}
                      style={{
                        ...tdStyle,
                        height: "46px",
                        color: "var(--fc-admin-muted)",
                        fontWeight: 800,
                        textAlign: "center",
                      }}
                    >
                      No events
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            </>
          )}
        </div>
      </div>

      {eventModalMode && (
        <div style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 style={{ margin: "0 0 14px", fontSize: "24px" }}>
              {eventModalMode === "add" ? "New Event" : "Edit Event"}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                From
                <input
                  type="date"
                  value={draftEvent.startDate}
                  onChange={(event) =>
                    setDraftEvent((current) => ({
                      ...current,
                      startDate: event.target.value,
                      endDate: event.target.value,
                    }))
                  }
                  style={inputStyle}
                />
              </label>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                To
                <input
                  type="date"
                  value={draftEvent.endDate}
                  onChange={(event) => setDraftEvent((current) => ({ ...current, endDate: event.target.value }))}
                  style={inputStyle}
                />
              </label>
            </div>
            <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>
              Event
              <input
                value={draftEvent.title}
                onChange={(event) => setDraftEvent((current) => ({ ...current, title: event.target.value.toUpperCase() }))}
                style={inputStyle}
              />
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: "9px",
                color: "var(--fc-admin-panel-text)",
                fontSize: "12px",
                fontWeight: 900,
                marginBottom: "12px",
              }}
            >
              <input
                type="checkbox"
                checked={isMeetingRoomBooked(draftEvent)}
                onChange={(event) =>
                  setDraftEvent((current) => ({
                    ...current,
                    eventType: event.target.checked ? "Meeting Room" : "Unclassified",
                  }))
                }
              />
              Book Meeting Room
            </label>
            <div style={{ color: "var(--fc-admin-muted)", fontSize: "11px", fontWeight: 800, margin: "-7px 0 12px 24px" }}>
              Default is 1 hour from start time. Please enter exact timing if required e.g. 14:30-16:00
            </div>
            <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
              Attending
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "16px" }}>
              {people.map((person) => {
                const attending = draftEvent.people.includes(person)
                const uncertain = (draftEvent.uncertainPeople || []).includes(person)
                return (
                  <button
                    key={person}
                    type="button"
                    aria-pressed={attending || uncertain}
                    onClick={() => cycleDraftPerson(person)}
                    style={{
                      ...buttonStyle,
                      background: attending
                        ? "var(--fc-admin-selected-bg)"
                        : uncertain
                          ? "#fff8e5"
                          : "var(--fc-admin-button-bg)",
                      color: attending ? "var(--fc-admin-selected-text)" : uncertain ? "var(--fc-admin-warning-text)" : "var(--fc-admin-button-text)",
                      minWidth: "42px",
                    }}
                  >
                    {uncertain ? "??" : person}
                  </button>
                )
              })}
            </div>
            <div style={{ display: "flex", justifyContent: eventModalMode === "edit" ? "space-between" : "flex-end", gap: "9px" }}>
              {eventModalMode === "edit" && (
                <button
                  type="button"
                  onClick={deleteDraftEvent}
                  style={dangerActionButtonStyle}
                >
                  Delete Event
                </button>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px" }}>
                <button type="button" onClick={() => setEventModalMode(null)} style={buttonStyle}>
                  Cancel
                </button>
                <button type="button" onClick={saveDraftEvent} style={primaryActionButtonStyle}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {recurrentModalOpen && (
        <div style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 style={{ margin: "0 0 14px", fontSize: "24px" }}>Recurrent Event</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                From
                <input
                  type="date"
                  value={draftRecurrentEvent.startDate}
                  onChange={(event) =>
                    setDraftRecurrentEvent((current) => ({
                      ...current,
                      startDate: event.target.value,
                      endDate: event.target.value,
                    }))
                  }
                  style={inputStyle}
                />
              </label>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                To
                <input
                  type="date"
                  value={draftRecurrentEvent.endDate}
                  onChange={(event) => setDraftRecurrentEvent((current) => ({ ...current, endDate: event.target.value }))}
                  style={inputStyle}
                />
              </label>
            </div>
            <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>
              Event
              <input
                value={draftRecurrentEvent.title}
                onChange={(event) => setDraftRecurrentEvent((current) => ({ ...current, title: event.target.value.toUpperCase() }))}
                style={inputStyle}
              />
            </label>
            <div style={{ marginBottom: "10px" }}>
              <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
                Repeat
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                {(["daily", "weekly", "monthly"] as RecurrentFrequency[]).map((frequency) => {
                  const active = draftRecurrentEvent.frequency === frequency
                  return (
                    <button
                      key={frequency}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setDraftRecurrentEvent((current) => ({ ...current, frequency }))}
                      style={{
                        ...buttonStyle,
                        background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                        color: active ? "var(--fc-admin-selected-text)" : "var(--fc-admin-button-text)",
                        textTransform: "capitalize",
                      }}
                    >
                      {frequency}
                    </button>
                  )
                })}
              </div>
            </div>
            {draftRecurrentEvent.frequency === "weekly" && (
              <div style={{ marginBottom: "10px" }}>
                <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
                  Repeat On
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                  {weekDayButtons.map((day) => {
                    const active = draftRecurrentEvent.weeklyDays.includes(day.value)
                    return (
                      <button
                        key={day.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => toggleDraftWeeklyDay(day.value)}
                        style={{
                          ...buttonStyle,
                          background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                          color: active ? "var(--fc-admin-selected-text)" : "var(--fc-admin-button-text)",
                          minWidth: "46px",
                        }}
                      >
                        {day.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {draftRecurrentEvent.frequency === "monthly" && (
              <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>
                Day Of Month
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={draftRecurrentEvent.monthlyDay}
                  onChange={(event) =>
                    setDraftRecurrentEvent((current) => ({
                      ...current,
                      monthlyDay: Math.max(1, Math.min(31, Number(event.target.value) || 1)),
                    }))
                  }
                  style={inputStyle}
                />
              </label>
            )}
            <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
              Attending
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "16px" }}>
              {people.map((person) => {
                const attending = draftRecurrentEvent.people.includes(person)
                return (
                  <button
                    key={person}
                    type="button"
                    aria-pressed={attending}
                    onClick={() =>
                      setDraftRecurrentEvent((current) => ({
                        ...current,
                        people: attending
                          ? current.people.filter((item) => item !== person)
                          : [...current.people, person],
                      }))
                    }
                    style={{
                      ...buttonStyle,
                      background: attending ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                      color: attending ? "var(--fc-admin-selected-text)" : "var(--fc-admin-button-text)",
                      minWidth: "42px",
                    }}
                  >
                    {person}
                  </button>
                )
              })}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px" }}>
              <button type="button" onClick={() => setRecurrentModalOpen(false)} style={buttonStyle}>
                Cancel
              </button>
              <button type="button" onClick={saveRecurrentEvents} style={primaryActionButtonStyle}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {leaveModalOpen && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalStyle, width: "min(560px, 100%)" }}>
            <h2 style={{ margin: "0 0 14px", fontSize: "24px" }}>Leave Request</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Leave Period From
                <input
                  type="date"
                  value={leaveRequestDraft.from}
                  onChange={(event) =>
                    setLeaveRequestDraft((current) => ({ ...current, from: event.target.value, to: event.target.value }))
                  }
                  style={inputStyle}
                />
              </label>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                To
                <input
                  type="date"
                  value={leaveRequestDraft.to}
                  onChange={(event) => setLeaveRequestDraft((current) => ({ ...current, to: event.target.value }))}
                  style={inputStyle}
                />
              </label>
            </div>
            <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
              Leave Type
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "12px" }}>
              {leaveTypes.map((type) => {
                const active = leaveRequestDraft.type === type
                return (
                  <button
                    key={type}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setLeaveRequestDraft((current) => ({ ...current, type }))}
                    style={{
                      ...buttonStyle,
                      background: active ? "#fff8e5" : "var(--fc-admin-button-bg)",
                      color: active ? "var(--fc-admin-warning-text)" : "var(--fc-admin-muted)",
                    }}
                  >
                    {type}
                  </button>
                )
              })}
            </div>
            <label style={{ display: "block", color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "12px" }}>
              Reason (Non Compulsory)
              <textarea
                value={leaveRequestDraft.reason}
                onChange={(event) => setLeaveRequestDraft((current) => ({ ...current, reason: event.target.value }))}
                style={{ ...inputStyle, minHeight: "92px", resize: "vertical", lineHeight: 1.45 }}
              />
            </label>
            <div style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
              Applicant
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "14px" }}>
              {people.map((person) => {
                const active = leaveRequestDraft.person === person
                return (
                  <button
                    key={person}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setLeaveRequestDraft((current) => ({ ...current, person }))}
                    style={{
                      ...buttonStyle,
                      background: active ? "var(--fc-admin-selected-bg)" : "var(--fc-admin-button-bg)",
                      color: active ? "var(--fc-admin-selected-text)" : "var(--fc-admin-button-text)",
                      minWidth: "42px",
                    }}
                  >
                    {person}
                  </button>
                )
              })}
            </div>
            {leaveRequestDraft.status !== "idle" && (
              <div
                style={{
                  marginBottom: "14px",
                  borderRadius: "14px",
                  border:
                    leaveRequestDraft.status === "failed"
                      ? "1px solid var(--fc-admin-danger-border)"
                      : "1px solid var(--fc-admin-success-border)",
                  background:
                    leaveRequestDraft.status === "failed"
                      ? "var(--fc-admin-danger-bg)"
                      : "var(--fc-admin-success-bg)",
                  color: leaveRequestDraft.status === "failed" ? "var(--fc-admin-danger-text)" : "var(--fc-admin-success-text)",
                  fontSize: "13px",
                  fontWeight: 900,
                  padding: "11px 12px",
                }}
              >
                {leaveRequestDraft.status === "sending"
                  ? "Sending leave request..."
                  : leaveRequestDraft.status === "sent"
                    ? "Sent"
                    : leaveRequestDraft.error || "Could not send. Please check email settings and try again."}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px" }}>
              <button
                type="button"
                onClick={() => setLeaveModalOpen(false)}
                disabled={leaveRequestDraft.status === "sending"}
                style={{ ...buttonStyle, opacity: leaveRequestDraft.status === "sending" ? 0.58 : 1 }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={sendLeaveRequest}
                disabled={leaveRequestDraft.status === "sending" || leaveRequestDraft.status === "sent"}
                style={{ ...primaryActionButtonStyle, opacity: leaveRequestDraft.status === "sending" ? 0.72 : 1 }}
              >
                {leaveRequestDraft.status === "sending" ? "Sending" : leaveRequestDraft.status === "sent" ? "Sent" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}

      {emailPrompt && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalStyle, width: "min(430px, 100%)" }}>
            <h2 style={{ margin: "0 0 10px", fontSize: "22px" }}>Send Event Update?</h2>
            <p style={{ margin: "0 0 6px", color: "var(--fc-admin-panel-text)", fontSize: "14px", fontWeight: 800 }}>
              {emailPrompt.event.title || "NEW EVENT"}
            </p>
            <p style={{ margin: "0 0 16px", color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
              {formatEventRange(emailPrompt.event)}
            </p>

            {emailPrompt.status === "sending" && (
              <div
                style={{
                  marginBottom: "16px",
                  borderRadius: "14px",
                  border: "1px solid var(--fc-admin-selected-border)",
                  background: "var(--fc-admin-selected-bg)",
                  color: "var(--fc-admin-panel-text)",
                  fontSize: "13px",
                  fontWeight: 900,
                  padding: "11px 12px",
                }}
              >
                Sending update...
              </div>
            )}

            {emailPrompt.status === "sent" && (
              <div
                style={{
                  marginBottom: "16px",
                  borderRadius: "14px",
                  border: "1px solid var(--fc-admin-success-border)",
                  background: "var(--fc-admin-success-bg)",
                  color: "var(--fc-admin-success-text)",
                  fontSize: "13px",
                  fontWeight: 900,
                  padding: "11px 12px",
                  transform: "scale(1.01)",
                  transition: "transform 180ms ease",
                }}
              >
                Sent
              </div>
            )}

            {emailPrompt.status === "failed" && (
              <div
                style={{
                  marginBottom: "16px",
                  borderRadius: "14px",
                  border: "1px solid var(--fc-admin-danger-border)",
                  background: "var(--fc-admin-danger-bg)",
                  color: "var(--fc-admin-danger-text)",
                  fontSize: "13px",
                  fontWeight: 900,
                  padding: "11px 12px",
                }}
              >
                Could not send. Please check the email settings and try again.
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px" }}>
              <button
                type="button"
                onClick={() => setEmailPrompt(null)}
                disabled={emailPrompt.status === "sending"}
                style={{
                  ...buttonStyle,
                  opacity: emailPrompt.status === "sending" ? 0.58 : 1,
                  cursor: emailPrompt.status === "sending" ? "not-allowed" : "pointer",
                }}
              >
                No
              </button>
              <button
                type="button"
                onClick={confirmEventEmailSend}
                disabled={emailPrompt.status === "sending" || emailPrompt.status === "sent"}
                style={{
                  ...buttonStyle,
                  background:
                    emailPrompt.status === "sent"
                      ? "var(--fc-admin-success-bg)"
                      : "var(--fc-admin-primary-button-bg)",
                  borderColor:
                    emailPrompt.status === "sent"
                      ? "var(--fc-admin-success-border)"
                      : "var(--fc-admin-primary-button-bg)",
                  color: emailPrompt.status === "sent" ? "var(--fc-admin-success-text)" : "var(--fc-admin-primary-button-text)",
                  opacity: emailPrompt.status === "sending" ? 0.72 : 1,
                  cursor:
                    emailPrompt.status === "sending" || emailPrompt.status === "sent" ? "not-allowed" : "pointer",
                }}
              >
                {emailPrompt.status === "sending" ? "Sending" : emailPrompt.status === "sent" ? "Sent" : "Yes, Send"}
              </button>
            </div>
          </div>
        </div>
      )}

      {peopleModalOpen && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalStyle, width: "min(460px, 100%)" }}>
            <h2 style={{ margin: "0 0 10px", fontSize: "24px" }}>People Columns</h2>
            <p style={{ margin: "0 0 12px", color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
              One person per line. Reorder the lines to reorder the columns.
            </p>
            <textarea
              value={draftPeopleText}
              onChange={(event) => setDraftPeopleText(event.target.value.toUpperCase())}
              style={{
                ...inputStyle,
                minHeight: "220px",
                resize: "vertical",
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px", marginTop: "14px" }}>
              <button type="button" onClick={() => setPeopleModalOpen(false)} style={buttonStyle}>
                Cancel
              </button>
              <button type="button" onClick={savePeople} style={buttonStyle}>
                Save People
              </button>
            </div>
          </div>
        </div>
      )}

      {emailModalOpen && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalStyle, width: "min(520px, 100%)" }}>
            <h2 style={{ margin: "0 0 10px", fontSize: "24px" }}>Email Reminders</h2>
            <p style={{ margin: "0 0 12px", color: "var(--fc-admin-muted)", fontSize: "13px", fontWeight: 700 }}>
              One email per line. New and edited events will be emailed to this list from info@cosulich.com.hk.
            </p>
            <textarea
              value={emailRecipientsText}
              onChange={(event) => setEmailRecipientsText(event.target.value)}
              placeholder="name@company.com"
              style={{
                ...inputStyle,
                minHeight: "180px",
                resize: "vertical",
                lineHeight: 1.5,
              }}
            />
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px", marginTop: "14px" }}>
              <button type="button" onClick={() => setEmailModalOpen(false)} style={buttonStyle}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
