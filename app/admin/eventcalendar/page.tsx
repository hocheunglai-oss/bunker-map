"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import {
  OfficeCalendarEvent,
  officeCalendarSeedEvents,
} from "@/data/eventCalendar"
import { mergeImportedEvents } from "@/lib/eventCalendarImport"
import { EVENT_CALENDAR_PROTOCOL_VERSION } from "@/lib/eventCalendarProtocol"
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
  eventVersion: string
  action: "created" | "updated"
  status: "idle" | "sending" | "sent" | "failed"
  error: string
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

function normalizeEventVersions(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.entries(value).reduce<Record<string, string>>((versions, [id, version]) => {
    if (id.trim() && typeof version === "string" && /^[0-9a-f]{64}$/.test(version)) {
      versions[id.trim()] = version
    }
    return versions
  }, {})
}

function createEventId(prefix: string) {
  const randomId = globalThis.crypto?.randomUUID?.()
  return `${prefix}-${randomId || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
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
  const normalizedEndMinutes = endMinutes === null
    ? startMinutes + 60
    : endMinutes <= startMinutes
      ? endMinutes + (24 * 60)
      : endMinutes

  return {
    start,
    end: end || `${String(Math.floor((startMinutes + 60) / 60)).padStart(2, "0")}:${String((startMinutes + 60) % 60).padStart(2, "0")}`,
    startMinutes,
    endMinutes: normalizedEndMinutes,
  }
}

function getGoogleEventMinutes(event: GoogleCalendarEvent) {
  const startMinutes = event.startTime ? parseTimeToMinutes(event.startTime) : 0
  const rawEndMinutes = event.endTime ? parseTimeToMinutes(event.endTime) : 24 * 60
  const endMinutes = rawEndMinutes !== null && event.endDate > event.startDate
    ? rawEndMinutes + (24 * 60)
    : rawEndMinutes

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
    id: createEventId("office"),
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
    id: createEventId("recurrent"),
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
  const [draftEmailRecipientsText, setDraftEmailRecipientsText] = useState("")
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
  const [calendarMutationPending, setCalendarMutationPending] = useState(false)
  const [eventSubmissionPending, setEventSubmissionPending] = useState(false)
  const [draftEventVersion, setDraftEventVersion] = useState("")
  const [draftEventChangedElsewhere, setDraftEventChangedElsewhere] = useState(false)
  const [eventVersions, setEventVersions] = useState<Record<string, string>>({})
  const [settingVersions, setSettingVersions] = useState<Record<string, string>>({})
  const [draftPeopleVersion, setDraftPeopleVersion] = useState("")
  const [draftEmailRecipientsVersion, setDraftEmailRecipientsVersion] = useState("")
  const [googleRefreshKey, setGoogleRefreshKey] = useState(0)
  const loadedRef = useRef(false)
  const eventsRef = useRef<ManagedEvent[]>([])
  const calendarMutationPendingRef = useRef(false)
  const eventSubmissionPendingRef = useRef(false)
  const eventSubmissionTokenRef = useRef(0)
  const draftEventIdRef = useRef("")
  const draftEventVersionRef = useRef("")
  const calendarStateSequenceRef = useRef(0)
  const refreshRequestSequenceRef = useRef(0)
  const toolsMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const addMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function applyCanonicalCalendarPayload(
    rawPayload: unknown,
    rawEventVersions: unknown,
    rawSettingVersions: unknown,
  ) {
    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return false
    const payload = rawPayload as Record<string, unknown>
    if (!Array.isArray(payload.events)) return false

    const nextEvents = normalizeStoredEvents(payload.events)
    const nextEventVersions = normalizeEventVersions(rawEventVersions)
    eventsRef.current = nextEvents
    setEventVersions(nextEventVersions)
    setSettingVersions(normalizeEventVersions(rawSettingVersions))
    if (
      draftEventIdRef.current &&
      draftEventVersionRef.current &&
      nextEventVersions[draftEventIdRef.current] !== draftEventVersionRef.current
    ) {
      setDraftEventChangedElsewhere(true)
    }
    setEvents(nextEvents)
    setDeletedEventIds(normalizeStringList(Array.isArray(payload.deletedEventIds) ? payload.deletedEventIds.map(String) : []))
    if (Array.isArray(payload.people)) setPeople(normalizePeople(payload.people.map(String)))
    if (typeof payload.emailRecipientsText === "string") setEmailRecipientsText(payload.emailRecipientsText)
    if (Array.isArray(payload.deletedRequiredSeedIds)) {
      setDeletedRequiredSeedIds(normalizeStringList(payload.deletedRequiredSeedIds.map(String)))
    }
    return true
  }

  useEffect(() => {
    let cancelled = false

    async function loadCalendarData() {
      let fallbackEvents = normalizeStoredEvents(officeCalendarSeedEvents)
      let fallbackPeople = defaultPeople
      let fallbackEmailRecipients = ""
      let fallbackDeletedEventIds: string[] = []
      let fallbackDeletedRequiredSeedIds: string[] = []
      let fallbackEventVersions: Record<string, string> = {}
      let fallbackSettingVersions: Record<string, string> = {}
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

        if (data?.protocolVersion !== EVENT_CALENDAR_PROTOCOL_VERSION) {
          throw new Error("This Event Calendar tab is outdated. Refresh the page before making calendar changes.")
        }
        fallbackEventVersions = normalizeEventVersions(data.eventVersions)
        fallbackSettingVersions = normalizeEventVersions(data.settingVersions)

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
      eventsRef.current = fallbackEvents
      setEventVersions(fallbackEventVersions)
      setSettingVersions(fallbackSettingVersions)
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
    eventsRef.current = events
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
    if (!authenticated || !calendarLoaded || !loadedRef.current) return
    let cancelled = false

    async function refreshCanonicalCalendar() {
      if (calendarMutationPendingRef.current) return
      const requestSequence = ++refreshRequestSequenceRef.current
      const stateSequence = calendarStateSequenceRef.current

      try {
        const response = await fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`, { cache: "no-store" })
        const data = await response.json().catch(() => null)
        if (!response.ok) throw new Error(data?.message || "Could not refresh the shared calendar.")
        if (data?.protocolVersion !== EVENT_CALENDAR_PROTOCOL_VERSION) {
          setCalendarLoadError("This Event Calendar tab is outdated. Refresh the page before making calendar changes.")
          setSaveStatus("Calendar tab outdated - refresh required")
          return
        }
        if (
          cancelled ||
          requestSequence !== refreshRequestSequenceRef.current ||
          stateSequence !== calendarStateSequenceRef.current ||
          calendarMutationPendingRef.current
        ) return

        if (applyCanonicalCalendarPayload(data.payload, data.eventVersions, data.settingVersions)) {
          setCalendarLoadError("")
          setSaveStatus("Shared calendar refreshed")
        }
      } catch {
        if (!cancelled) setSaveStatus("Shared calendar refresh pending")
      }
    }

    const handleFocus = () => void refreshCanonicalCalendar()
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void refreshCanonicalCalendar()
    }
    window.addEventListener("focus", handleFocus)
    document.addEventListener("visibilitychange", handleVisibility)
    const refreshTimer = window.setInterval(() => void refreshCanonicalCalendar(), 60_000)

    return () => {
      cancelled = true
      window.removeEventListener("focus", handleFocus)
      document.removeEventListener("visibilitychange", handleVisibility)
      window.clearInterval(refreshTimer)
    }
  }, [authenticated, calendarLoaded])

  useEffect(() => {
    if (!authenticated || !calendarLoaded || !loadedRef.current) return
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
        await persistImportedEvents(normalizeStoredEvents(payload.events))
        setHolidayImportStatus(`Holidays ready ${years.replace(",", "-")}`)
      } catch {
        if (!cancelled) setHolidayImportStatus("Holiday import pending")
      }
    }

    importPublicHolidays()

    return () => {
      cancelled = true
    }
  }, [authenticated, calendarLoaded])

  async function syncCanonicalGoogleCalendar(eventIds: string[]) {
    if (!eventIds.length) return
    setSyncStatus("Syncing Google")
    try {
      const response = await fetch("/api/event-calendar/google-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventIds }),
      })
      const payload = await response.json()
      if (!response.ok || payload.success !== true) {
        setSyncStatus(payload.message || "Google sync pending")
        return
      }
      setSyncStatus(
        payload.queued
          ? `Meeting Room sync queued (${payload.queued})`
          : `Synced ${payload.updated + payload.inserted} events${payload.deleted ? `, removed ${payload.deleted}` : ""}`,
      )
      setGoogleRefreshKey((current) => current + 1)
    } catch {
      setSyncStatus("Google sync pending")
    }
  }

  useEffect(() => {
    if (!authenticated || viewMode !== "google") return
    let cancelled = false

    async function loadGoogleCalendarEvents() {
      setGoogleCalendarStatus("Loading Meeting Room")

      try {
        const response = await fetch("/api/event-calendar/google-events")
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
  }, [authenticated, googleRefreshKey, viewMode])

  useEffect(() => {
    return () => {
      if (toolsMenuCloseTimerRef.current) clearTimeout(toolsMenuCloseTimerRef.current)
      if (addMenuCloseTimerRef.current) clearTimeout(addMenuCloseTimerRef.current)
    }
  }, [])

  async function sendEventEmail(event: ManagedEvent, eventVersion: string, action: "created" | "updated") {
    const response = await fetch("/api/event-calendar/email-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, event, eventVersion }),
      })

    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      throw new Error(payload?.message || "Email notification failed.")
    }
  }

  async function mutateCalendar(
    operation: "create" | "update" | "upsert" | "insert" | "delete" | "people" | "settings",
    mutationEvents: ManagedEvent[] = [],
    eventIds: string[] = [],
    settings: Record<string, unknown> = {},
    expectedEventVersions: Record<string, string> = {},
    expectedSettingVersions: Record<string, string> = {},
  ) {
    if (calendarMutationPendingRef.current) {
      throw new Error("Another calendar change is still saving. Wait for it to finish, then try again.")
    }

    calendarMutationPendingRef.current = true
    calendarStateSequenceRef.current += 1
    setCalendarMutationPending(true)
    setSaveStatus("Saving shared calendar")
    try {
      const response = await fetch(`/api/office-calendar-store/${SHARED_STORE_KEY}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          protocolVersion: EVENT_CALENDAR_PROTOCOL_VERSION,
          operation,
          events: mutationEvents,
          eventIds,
          settings,
          expectedEventVersions,
          expectedSettingVersions,
        }),
      })
      const payload = await response.json().catch(() => null)

      if (payload?.payload) {
        applyCanonicalCalendarPayload(payload.payload, payload.eventVersions, payload.settingVersions)
      }
      if (!response.ok || !payload?.payload) {
        const message = payload?.message || "Shared calendar save failed"
        setSaveStatus(message)
        if (payload?.reloadRequired) {
          setCalendarLoadError(message)
        }
        throw new Error(message)
      }

      setCalendarLoadError("")
      setSaveStatus("Shared calendar saved")
      if (["create", "update", "delete"].includes(operation)) {
        const affectedEventIds = operation === "delete"
          ? eventIds
          : mutationEvents.map((event) => event.id)
        void syncCanonicalGoogleCalendar(affectedEventIds)
      }
      return payload
    } finally {
      calendarMutationPendingRef.current = false
      calendarStateSequenceRef.current += 1
      setCalendarMutationPending(false)
    }
  }

  async function persistImportedEvents(importedEvents: ManagedEvent[]) {
    const merged = mergeImportedEvents(eventsRef.current, importedEvents)
    const currentIds = new Set(eventsRef.current.map((event) => event.id))
    const additions = merged.filter((event) => !currentIds.has(event.id))
    if (!additions.length) return
    await mutateCalendar("insert", additions)
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
    eventSubmissionTokenRef.current += 1
    draftEventIdRef.current = ""
    draftEventVersionRef.current = ""
    setDraftEvent(buildBlankEvent(todayKey))
    setDraftEventVersion("")
    setDraftEventChangedElsewhere(false)
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
    const version = eventVersions[event.id] || ""
    eventSubmissionTokenRef.current += 1
    draftEventIdRef.current = event.id
    draftEventVersionRef.current = version
    setDraftEventVersion(version)
    setDraftEventChangedElsewhere(false)
    setDraftEvent({
      ...event,
      people: normalizePeople(event.people),
      uncertainPeople: normalizePeople(event.uncertainPeople || []),
      eventType: inferCategory(event),
    })
    setEventModalMode("edit")
  }

  function closeEventModal() {
    if (eventSubmissionPendingRef.current || calendarMutationPendingRef.current) return
    eventSubmissionTokenRef.current += 1
    draftEventIdRef.current = ""
    draftEventVersionRef.current = ""
    setDraftEventChangedElsewhere(false)
    setEventModalMode(null)
  }

  async function findMeetingRoomConflicts(event: ManagedEvent) {
    if (!isMeetingRoomBooked(event)) return []

    const bookingTime = extractEventTimeRange(event.title)

    try {
      const response = await fetch(
        `/api/event-calendar/google-events?timeMin=${encodeURIComponent(`${event.startDate}T00:00:00+08:00`)}&timeMax=${encodeURIComponent(`${event.startDate}T23:59:59+08:00`)}`
      )
      const payload = await response.json()
      if (!response.ok || !Array.isArray(payload.events)) {
        throw new Error(payload?.message || "Meeting-room availability could not be verified. Nothing was saved; try again.")
      }

      return (payload.events as GoogleCalendarEvent[]).filter((googleEvent) => {
        if (googleEvent.sourceEventId && googleEvent.sourceEventId === event.id) return false
        if (googleEvent.startDate !== event.startDate) return false
        if (!bookingTime) return true

        const googleTime = getGoogleEventMinutes(googleEvent)
        return bookingTime.startMinutes < googleTime.endMinutes && bookingTime.endMinutes > googleTime.startMinutes
      })
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "Meeting-room availability could not be verified. Nothing was saved; try again.",
      )
    }
  }

  async function saveDraftEvent() {
    if (calendarMutationPendingRef.current || eventSubmissionPendingRef.current || !eventModalMode) return
    const wasEdit = eventModalMode === "edit"
    const action = eventModalMode === "edit" ? "save these changes" : "create this event"
    if (!window.confirm(`Are you sure you want to ${action}?`)) return
    const submissionToken = ++eventSubmissionTokenRef.current
    eventSubmissionPendingRef.current = true
    setEventSubmissionPending(true)

    try {
      const nextEvent: ManagedEvent = {
        ...draftEvent,
        title: draftEvent.title.trim().toUpperCase() || "NEW EVENT",
        people: normalizePeople(draftEvent.people),
        uncertainPeople: normalizePeople(draftEvent.uncertainPeople || []),
        endDate: draftEvent.endDate >= draftEvent.startDate ? draftEvent.endDate : draftEvent.startDate,
        eventType: draftEvent.eventType || "Unclassified",
      }

      const conflicts = await findMeetingRoomConflicts(nextEvent)
      if (submissionToken !== eventSubmissionTokenRef.current) return
      if (conflicts.length) {
        const conflictText = conflicts
          .slice(0, 3)
          .map((event) => `${formatGoogleEventTime(event)} ${event.title}`)
          .join("\n")
        const proceed = window.confirm(
          `Meeting room booking conflict found:\n\n${conflictText}\n\nDo you still want to save this event?`
        )
        if (!proceed || submissionToken !== eventSubmissionTokenRef.current) return
      }

      const result = await mutateCalendar(
        wasEdit ? "update" : "create",
        [nextEvent],
        [],
        {},
        wasEdit ? { [nextEvent.id]: draftEventVersion } : {},
      )
      const committedEvent = normalizeStoredEvents(result.payload.events).find((event) => event.id === nextEvent.id) || nextEvent
      setEmailPrompt({
        event: committedEvent,
        eventVersion: normalizeEventVersions(result.eventVersions)[nextEvent.id] || "",
        action: wasEdit ? "updated" : "created",
        status: "idle",
        error: "",
      })
      if (submissionToken === eventSubmissionTokenRef.current) {
        draftEventIdRef.current = ""
        draftEventVersionRef.current = ""
        setDraftEventChangedElsewhere(false)
        setEventModalMode(null)
      }
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The event was not saved. Please try again.")
    } finally {
      if (submissionToken === eventSubmissionTokenRef.current) {
        eventSubmissionPendingRef.current = false
        setEventSubmissionPending(false)
      }
    }
  }

  async function confirmEventEmailSend() {
    if (!emailPrompt || emailPrompt.status === "sending") return
    setEmailPrompt((current) => current && { ...current, status: "sending", error: "" })

    try {
      await sendEventEmail(emailPrompt.event, emailPrompt.eventVersion, emailPrompt.action)
      setEmailPrompt((current) => current && { ...current, status: "sent", error: "" })
      window.setTimeout(() => setEmailPrompt(null), 900)
    } catch (error) {
      setEmailPrompt((current) => current && {
        ...current,
        status: "failed",
        error: error instanceof Error ? error.message : "Email notification failed.",
      })
    }
  }

  async function saveRecurrentEvents() {
    if (calendarMutationPendingRef.current) return
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

    const nextEvents = occurrenceDates.map((dateKey) => ({
      ...draftRecurrentEvent,
      id: `${draftRecurrentEvent.id}-${dateKey}`,
      title: draftRecurrentEvent.title.trim().toUpperCase() || "NEW EVENT",
      people: normalizePeople(draftRecurrentEvent.people),
      uncertainPeople: normalizePeople(draftRecurrentEvent.uncertainPeople || []),
      startDate: dateKey,
      endDate: dateKey,
      eventType: draftRecurrentEvent.eventType || "Unclassified",
    }))

    try {
      await mutateCalendar("create", nextEvents)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The recurrent events were not saved. Please try again.")
      return
    }
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
    setDraftPeopleVersion(settingVersions.people || "")
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

  async function savePeople() {
    if (calendarMutationPendingRef.current) return
    const nextPeople = normalizePeople(draftPeopleText.split(/\n|,/))
    try {
      await mutateCalendar(
        "people",
        [],
        [],
        { people: nextPeople },
        {},
        { people: draftPeopleVersion },
      )
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The people list was not saved. Please try again.")
      return
    }
    setPeople(nextPeople)
    setSelectedPeople((current) => current.filter((person) => nextPeople.includes(person)))
    setPeopleModalOpen(false)
  }

  function openEmailModal() {
    setDraftEmailRecipientsText(emailRecipientsText)
    setDraftEmailRecipientsVersion(settingVersions.emailRecipientsText || "")
    setToolsMenuOpen(false)
    setEmailModalOpen(true)
  }

  async function saveEmailRecipients() {
    if (calendarMutationPendingRef.current) return
    try {
      await mutateCalendar(
        "settings",
        [],
        [],
        { emailRecipientsText: draftEmailRecipientsText },
        {},
        { emailRecipientsText: draftEmailRecipientsVersion },
      )
      setEmailRecipientsText(draftEmailRecipientsText)
      setEmailModalOpen(false)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The email reminder list was not saved. Please try again.")
    }
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

      await persistImportedEvents(normalizeStoredEvents(payload.events))
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

      await persistImportedEvents(normalizeStoredEvents(payload.events))
      setHolidayImportStatus(`${nextYear} Hong Kong holidays added`)
    } catch {
      setHolidayImportStatus(`${nextYear} Hong Kong holiday import pending`)
    } finally {
      setHolidayImporting(false)
    }
  }

  async function recoverMissingEvents() {
    if (recoveringEvents || calendarMutationPendingRef.current) return
    if (!window.confirm("Restore missing future events found in audit history?")) return

    calendarMutationPendingRef.current = true
    calendarStateSequenceRef.current += 1
    setCalendarMutationPending(true)
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

      if (!applyCanonicalCalendarPayload(payload.payload, payload.eventVersions, payload.settingVersions)) {
        throw new Error("The recovery response did not include the canonical calendar.")
      }
      const restoredIds = normalizeStoredEvents(payload.restoredEvents).map((event) => event.id)
      if (restoredIds.length) void syncCanonicalGoogleCalendar(restoredIds)
      setRecoveryStatus(
        payload.restoredCount
          ? `Recovered ${payload.restoredCount} missing events`
          : "No missing future events found"
      )
    } catch (error) {
      setRecoveryStatus(error instanceof Error ? error.message : "Could not recover missing events.")
    } finally {
      calendarMutationPendingRef.current = false
      calendarStateSequenceRef.current += 1
      setCalendarMutationPending(false)
      setRecoveringEvents(false)
    }
  }

  async function deleteDraftEvent() {
    if (eventModalMode !== "edit") return
    if (calendarMutationPendingRef.current || eventSubmissionPendingRef.current) return
    if (!window.confirm("Are you sure you want to delete this event?")) return

    const nextDeletedRequiredSeedIds = requiredSeedEventIds.includes(draftEvent.id)
      ? Array.from(new Set([...deletedRequiredSeedIds, draftEvent.id]))
      : deletedRequiredSeedIds
    try {
      await mutateCalendar("delete", [], [draftEvent.id], {
        deletedRequiredSeedIds: nextDeletedRequiredSeedIds,
      }, { [draftEvent.id]: draftEventVersion })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "The event was not deleted. Please try again.")
      return
    }
    if (requiredSeedEventIds.includes(draftEvent.id)) {
      setDeletedRequiredSeedIds(nextDeletedRequiredSeedIds)
    }
    closeEventModal()
  }

  const eventActionPending = calendarMutationPending || eventSubmissionPending

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
                background: /fail|unavailable|outdated|changed|conflict|refresh required/i.test(saveStatus)
                  ? "var(--fc-admin-danger-bg)"
                  : "var(--fc-admin-panel-bg)",
                color: /fail|unavailable|outdated|changed|conflict|refresh required/i.test(saveStatus)
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
            {syncStatus !== "Sync ready" && (
              <span
                style={{
                  border: "1px solid var(--fc-admin-border-soft)",
                  borderRadius: "999px",
                  background: /pending|incomplete|failed/i.test(syncStatus)
                    ? "var(--fc-admin-danger-bg)"
                    : "var(--fc-admin-panel-bg)",
                  color: /pending|incomplete|failed/i.test(syncStatus)
                    ? "var(--fc-admin-danger-text)"
                    : "var(--fc-admin-muted)",
                  fontSize: "11px",
                  fontWeight: 800,
                  lineHeight: 1,
                  padding: "8px 10px",
                  whiteSpace: "nowrap",
                }}
              >
                {syncStatus}
              </span>
            )}
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
            {draftEventChangedElsewhere && (
              <div
                style={{
                  marginBottom: "12px",
                  border: "1px solid var(--fc-admin-danger-border)",
                  borderRadius: "12px",
                  background: "var(--fc-admin-danger-bg)",
                  color: "var(--fc-admin-danger-text)",
                  fontSize: "12px",
                  fontWeight: 900,
                  padding: "10px 11px",
                }}
              >
                This event changed in another tab. Your draft is preserved, but it cannot overwrite the newer record. Cancel and reopen the event before saving.
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
              <label style={{ color: "var(--fc-admin-link)", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                From
                <input
                  type="date"
                  disabled={eventActionPending}
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
                  disabled={eventActionPending}
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
                disabled={eventActionPending}
                onChange={(event) => setDraftEvent((current) => ({ ...current, title: event.target.value }))}
                style={{ ...inputStyle, textTransform: "uppercase" }}
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
                disabled={eventActionPending}
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
                    disabled={eventActionPending}
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
                  disabled={eventActionPending || draftEventChangedElsewhere}
                  style={{ ...dangerActionButtonStyle, opacity: eventActionPending || draftEventChangedElsewhere ? 0.65 : 1 }}
                >
                  Delete Event
                </button>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px" }}>
                <button
                  type="button"
                  onClick={closeEventModal}
                  disabled={eventActionPending}
                  style={{ ...buttonStyle, opacity: eventActionPending ? 0.65 : 1 }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveDraftEvent}
                  disabled={eventActionPending || draftEventChangedElsewhere}
                  style={{ ...primaryActionButtonStyle, opacity: eventActionPending || draftEventChangedElsewhere ? 0.65 : 1 }}
                >
                  {eventActionPending ? "Saving" : "Save"}
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
                onChange={(event) => setDraftRecurrentEvent((current) => ({ ...current, title: event.target.value }))}
                style={{ ...inputStyle, textTransform: "uppercase" }}
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
              <button
                type="button"
                onClick={saveRecurrentEvents}
                disabled={calendarMutationPending}
                style={{ ...primaryActionButtonStyle, opacity: calendarMutationPending ? 0.65 : 1 }}
              >
                {calendarMutationPending ? "Saving" : "Save"}
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
                {emailPrompt.error || "Could not send. Please check the email settings and try again."}
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
              <button
                type="button"
                onClick={savePeople}
                disabled={calendarMutationPending}
                style={{ ...buttonStyle, opacity: calendarMutationPending ? 0.65 : 1 }}
              >
                {calendarMutationPending ? "Saving" : "Save People"}
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
              value={draftEmailRecipientsText}
              onChange={(event) => setDraftEmailRecipientsText(event.target.value)}
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
                Cancel
              </button>
              <button
                type="button"
                onClick={saveEmailRecipients}
                disabled={calendarMutationPending}
                style={{ ...primaryActionButtonStyle, opacity: calendarMutationPending ? 0.65 : 1 }}
              >
                {calendarMutationPending ? "Saving" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
