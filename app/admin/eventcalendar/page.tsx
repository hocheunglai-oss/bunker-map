"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import {
  OfficeCalendarEvent,
  officeCalendarSeedEvents,
} from "@/data/eventCalendar"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"

type EventCategory = "Public Holiday" | "Leave or Travel" | "Meeting" | "Unclassified"
type ViewMode = "upcoming" | "past"
type ModalMode = "add" | "edit" | null
type ManagedEvent = OfficeCalendarEvent & {
  eventType?: EventCategory
  uncertainPeople?: string[]
}

const STORAGE_KEY = "bunker-map-office-calendar-events"
const PEOPLE_STORAGE_KEY = "bunker-map-office-calendar-people"
const EMAIL_RECIPIENTS_STORAGE_KEY = "bunker-map-office-calendar-email-recipients"
const CALENDAR_ID = "cosulich.uno@gmail.com"
const defaultPeople = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"]
const categories: Array<"All" | EventCategory> = [
  "All",
  "Public Holiday",
  "Leave or Travel",
  "Meeting",
  "Unclassified",
]

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
  height: "18px",
  padding: "1px 7px",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  fontSize: "11px",
  lineHeight: "16px",
  verticalAlign: "middle",
  boxSizing: "border-box",
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
  const year = String(date.getFullYear()).slice(-2)
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date)
  return `${day} ${month} ${year} (${weekday})`
}

function formatEventRange(event: ManagedEvent) {
  if (event.startDate === event.endDate) return formatDate(event.startDate)
  return `${formatDate(event.startDate)} - ${formatDate(event.endDate)}`
}

function normalizePeople(value: string[]) {
  return Array.from(new Set(value.map((item) => item.trim().toUpperCase()).filter(Boolean).filter((item) => item !== "??")))
}

function normalizeEmails(value: string) {
  return Array.from(
    new Set(
      value
        .split(/[\n,;]+/)
        .map((item) => item.trim().toLowerCase())
        .filter(Boolean)
    )
  )
}

function inferCategory(event: Pick<ManagedEvent, "title" | "eventType">): EventCategory {
  if (event.eventType) return event.eventType

  const title = event.title.toLowerCase()
  if (title.includes("public holiday") || title.includes("holiday attendance")) return "Public Holiday"
  if (title.includes("leave") || title.includes("trip") || title.includes("genoa") || title.includes("vietnam")) return "Leave or Travel"
  if (title.includes("lunch") || title.includes("dinner") || title.includes("visit") || title.includes("meeting") || title.includes("call")) return "Meeting"
  return "Unclassified"
}

function getCategoryStyle(category: EventCategory) {
  const styles: Record<EventCategory, { background: string; solid: string; border: string; color: string; glow: string }> = {
    "Public Holiday": {
      background: "rgba(255, 91, 91, 0.24)",
      solid: "linear-gradient(180deg, rgba(255, 91, 91, 0.9) 0%, rgba(177, 39, 56, 0.88) 100%)",
      border: "rgba(255, 105, 105, 0.62)",
      color: "#ffe3e3",
      glow: "rgba(255, 78, 78, 0.13)",
    },
    "Leave or Travel": {
      background: "rgba(255, 218, 97, 0.24)",
      solid: "linear-gradient(180deg, rgba(255, 218, 97, 0.94) 0%, rgba(190, 142, 22, 0.9) 100%)",
      border: "rgba(255, 218, 97, 0.62)",
      color: "#fff4bf",
      glow: "rgba(255, 218, 97, 0.13)",
    },
    Meeting: {
      background: "rgba(173, 126, 255, 0.22)",
      solid: "linear-gradient(180deg, rgba(164, 116, 255, 0.9) 0%, rgba(92, 62, 184, 0.88) 100%)",
      border: "rgba(181, 143, 255, 0.62)",
      color: "#eadfff",
      glow: "rgba(164, 116, 255, 0.12)",
    },
    Unclassified: {
      background: "rgba(210, 224, 236, 0.11)",
      solid: "linear-gradient(180deg, rgba(130, 151, 169, 0.78) 0%, rgba(72, 92, 109, 0.78) 100%)",
      border: "rgba(210, 224, 236, 0.26)",
      color: "#e1edf6",
      glow: "rgba(210, 224, 236, 0.06)",
    },
  }
  return styles[category]
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
    eventType: event.eventType || inferCategory(event),
  }))
}

function isPastEvent(event: ManagedEvent, todayKey: string) {
  return event.endDate < todayKey
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

function mergeImportedEvents(current: ManagedEvent[], imported: ManagedEvent[]) {
  const seen = new Set(current.map((event) => `${event.startDate}|${event.endDate}|${event.title.toUpperCase()}`))
  const nextEvents = [...current]

  for (const event of imported) {
    const key = `${event.startDate}|${event.endDate}|${event.title.toUpperCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    nextEvents.push(event)
  }

  return nextEvents
}

export default function EventCalendarPage() {
  const router = useRouter()
  const { loading, authenticated } = useSimpleAdminAuth()
  const todayKey = toDateKey(new Date())
  const [events, setEvents] = useState<ManagedEvent[]>(() => normalizeStoredEvents(officeCalendarSeedEvents))
  const [people, setPeople] = useState(defaultPeople)
  const [selectedCategory, setSelectedCategory] = useState<"All" | EventCategory>("All")
  const [selectedPeople, setSelectedPeople] = useState<string[]>([])
  const [viewMode, setViewMode] = useState<ViewMode>("upcoming")
  const [eventModalMode, setEventModalMode] = useState<ModalMode>(null)
  const [peopleModalOpen, setPeopleModalOpen] = useState(false)
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false)
  const [draftEvent, setDraftEvent] = useState<ManagedEvent>(() => buildBlankEvent(todayKey))
  const [draftPeopleText, setDraftPeopleText] = useState(defaultPeople.join("\n"))
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [emailRecipientsText, setEmailRecipientsText] = useState("")
  const [syncStatus, setSyncStatus] = useState("Sync ready")
  const [holidayImportStatus, setHolidayImportStatus] = useState("")
  const loadedRef = useRef(false)
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY)
      const storedPeople = window.localStorage.getItem(PEOPLE_STORAGE_KEY)
      const storedEmailRecipients = window.localStorage.getItem(EMAIL_RECIPIENTS_STORAGE_KEY)
      if (stored) setEvents(normalizeStoredEvents(JSON.parse(stored)))
      if (storedPeople) setPeople(normalizePeople(JSON.parse(storedPeople)))
      if (storedEmailRecipients) setEmailRecipientsText(storedEmailRecipients)
    } catch {
      setEvents(normalizeStoredEvents(officeCalendarSeedEvents))
      setPeople(defaultPeople)
    } finally {
      loadedRef.current = true
    }
  }, [])

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(events))
  }, [events])

  useEffect(() => {
    window.localStorage.setItem(PEOPLE_STORAGE_KEY, JSON.stringify(people))
  }, [people])

  useEffect(() => {
    window.localStorage.setItem(EMAIL_RECIPIENTS_STORAGE_KEY, emailRecipientsText)
  }, [emailRecipientsText])

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
      setSyncStatus("Syncing Google")

      try {
        const response = await fetch("/api/event-calendar/google-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ calendarId: CALENDAR_ID, events }),
        })
        const payload = await response.json()

        if (!response.ok) {
          setSyncStatus(payload.message || "Google sync pending")
          return
        }

        setSyncStatus(`Synced ${payload.updated + payload.inserted} events`)
      } catch {
        setSyncStatus("Google sync pending")
      }
    }, 1200)

    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current)
    }
  }, [authenticated, events])

  async function sendEventEmail(event: ManagedEvent, action: "created" | "updated") {
    const recipients = normalizeEmails(emailRecipientsText)
    if (!recipients.length) return

    try {
      await fetch("/api/event-calendar/email-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, event, recipients }),
      })
    } catch {
      // Email is secondary to saving the calendar edit.
    }
  }

  const visibleEvents = useMemo(() => {
    return events
      .filter((event) => (viewMode === "past" ? isPastEvent(event, todayKey) : !isPastEvent(event, todayKey)))
      .filter((event) => selectedCategory === "All" || inferCategory(event) === selectedCategory)
      .sort(
        (a, b) =>
          a.startDate.localeCompare(b.startDate) ||
          (a.sourceRow || Number.MAX_SAFE_INTEGER) - (b.sourceRow || Number.MAX_SAFE_INTEGER) ||
          a.title.localeCompare(b.title)
      )
  }, [events, selectedCategory, todayKey, viewMode])

  function openAddModal() {
    setDraftEvent(buildBlankEvent(todayKey))
    setEventModalMode("add")
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

  function saveDraftEvent() {
    const nextEvent: ManagedEvent = {
      ...draftEvent,
      title: draftEvent.title.trim() || "NEW EVENT",
      people: normalizePeople(draftEvent.people),
      uncertainPeople: normalizePeople(draftEvent.uncertainPeople || []),
      endDate: draftEvent.endDate >= draftEvent.startDate ? draftEvent.endDate : draftEvent.startDate,
      eventType: draftEvent.eventType || "Unclassified",
    }

    setEvents((current) => {
      if (eventModalMode === "edit") {
        return current.map((event) => (event.id === nextEvent.id ? nextEvent : event))
      }
      return [nextEvent, ...current]
    })
    void sendEventEmail(nextEvent, eventModalMode === "edit" ? "updated" : "created")
    setEventModalMode(null)
  }

  function togglePersonFilter(person: string) {
    setSelectedPeople((current) =>
      current.includes(person) ? current.filter((item) => item !== person) : [...current, person]
    )
  }

  function cycleAttendance(eventId: string, person: string) {
    setEvents((current) =>
      current.map((event) => {
        if (event.id !== eventId) return event
        const attending = new Set(normalizePeople(event.people))
        const uncertain = new Set(normalizePeople(event.uncertainPeople || []))

        if (!attending.has(person) && !uncertain.has(person)) {
          attending.add(person)
        } else if (attending.has(person)) {
          attending.delete(person)
          uncertain.add(person)
        } else {
          uncertain.delete(person)
        }

        return {
          ...event,
          people: Array.from(attending),
          uncertainPeople: Array.from(uncertain),
        }
      })
    )
  }

  function openPeopleModal() {
    setDraftPeopleText(people.join("\n"))
    setToolsMenuOpen(false)
    setPeopleModalOpen(true)
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

  function deleteDraftEvent() {
    if (eventModalMode !== "edit") return
    setEvents((current) => current.filter((event) => event.id !== draftEvent.id))
    setEventModalMode(null)
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={{ ...pageStyle, display: "grid", placeItems: "center" }}>
        <div style={modalStyle}>
          <h1 style={{ margin: "0 0 12px", fontSize: "24px", color: "#edf7ff" }}>Event Calendar</h1>
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
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "end",
            gap: "14px",
            flexWrap: "wrap",
            marginBottom: "12px",
          }}
        >
          <div>
            <div
              style={{
                color: "#8fd7ff",
                fontSize: "12px",
                fontWeight: 800,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
              }}
            >
              Office Tools
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", marginTop: "6px" }}>
              <div style={{ position: "relative" }}>
                <button
                  type="button"
                  onClick={() => setToolsMenuOpen((current) => !current)}
                  aria-label="Event calendar menu"
                  style={{
                    ...buttonStyle,
                    width: "36px",
                    height: "36px",
                    padding: 0,
                    display: "inline-grid",
                    placeItems: "center",
                  }}
                >
                  <span style={{ display: "grid", gap: "4px", width: "16px" }} aria-hidden="true">
                    <span style={{ height: "2px", borderRadius: "999px", background: "currentColor" }} />
                    <span style={{ height: "2px", borderRadius: "999px", background: "currentColor" }} />
                    <span style={{ height: "2px", borderRadius: "999px", background: "currentColor" }} />
                  </span>
                </button>
                {toolsMenuOpen && (
                  <div
                    style={{
                      position: "absolute",
                      top: "42px",
                      left: 0,
                      zIndex: 30,
                      minWidth: "178px",
                      padding: "7px",
                      border: "1px solid rgba(210,236,255,0.18)",
                      borderRadius: "14px",
                      background: "linear-gradient(180deg, rgba(10, 35, 60, 0.98) 0%, rgba(6, 24, 42, 0.98) 100%)",
                      boxShadow: "0 18px 48px rgba(0,0,0,0.28)",
                    }}
                  >
                    <button
                      type="button"
                      onClick={openEmailModal}
                      style={{ ...buttonStyle, width: "100%", justifyContent: "flex-start", marginBottom: "6px" }}
                    >
                      Edit Email List
                    </button>
                    <button
                      type="button"
                      onClick={openPeopleModal}
                      style={{ ...buttonStyle, width: "100%", justifyContent: "flex-start" }}
                    >
                      Edit People List
                    </button>
                  </div>
                )}
              </div>
              <h1 style={{ margin: 0, fontSize: "34px", lineHeight: 1, color: "#edf7ff" }}>
                Event Calendar
              </h1>
              {(["upcoming", "past"] as ViewMode[]).map((mode) => {
                const active = viewMode === mode
                return (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setViewMode(mode)}
                    style={{
                      ...buttonStyle,
                      background: active
                        ? "linear-gradient(180deg, rgba(73, 219, 165, 0.32) 0%, rgba(20, 130, 93, 0.16) 100%)"
                        : buttonStyle.background,
                      color: active ? "#eafff4" : buttonStyle.color,
                      borderColor: active ? "rgba(73, 219, 165, 0.34)" : "rgba(210,236,255,0.16)",
                      padding: "7px 11px",
                    }}
                  >
                    {mode === "upcoming" ? "Upcoming Events" : "Past Events"}
                  </button>
                )
              })}
              <button
                type="button"
                onClick={openAddModal}
                aria-label="Add event"
                style={{ ...buttonStyle, width: "34px", height: "34px", padding: 0, fontSize: "22px" }}
              >
                +
              </button>
            </div>
          </div>
        </header>

        <div style={{ display: "grid", gap: "10px", marginBottom: "12px" }}>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {categories.map((category) => {
              const style = category === "All" ? null : getCategoryStyle(category)
              const active = selectedCategory === category
              return (
                <button
                  key={category}
                  type="button"
                  onClick={() => setSelectedCategory(category)}
                  style={{
                    border: `1px solid ${style?.border || "rgba(210,236,255,0.22)"}`,
                    borderRadius: "999px",
                    background: style?.solid || "linear-gradient(180deg, rgba(143, 215, 255, 0.5) 0%, rgba(42, 94, 132, 0.5) 100%)",
                    boxShadow: active
                      ? "0 0 0 2px rgba(255,255,255,0.2), 0 12px 26px rgba(0,0,0,0.18)"
                      : "inset 0 1px 0 rgba(255,255,255,0.1)",
                    color: "#ffffff",
                    cursor: "pointer",
                    fontSize: "11px",
                    fontWeight: 900,
                    opacity: active ? 1 : 0.72,
                    padding: "7px 10px",
                  }}
                >
                  {category}
                </button>
              )
            })}
          </div>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            {people.map((person) => {
              const active = selectedPeople.includes(person)
              return (
                <button
                  key={person}
                  type="button"
                  onClick={() => togglePersonFilter(person)}
                  style={{
                    minWidth: "34px",
                    border: active ? "1px solid rgba(143, 215, 255, 0.62)" : "1px solid rgba(5, 16, 28, 0.7)",
                    borderRadius: "999px",
                    background: active ? "rgba(143, 215, 255, 0.28)" : "rgba(2, 10, 18, 0.76)",
                    color: active ? "#edf7ff" : "#9fb3c5",
                    cursor: "pointer",
                    fontSize: "11px",
                    fontWeight: 900,
                    padding: "5px 9px",
                  }}
                >
                  {person}
                </button>
              )
            })}
          </div>
        </div>

        <div style={panelStyle}>
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={{ ...thStyle, width: "210px" }}>
                  Date
                </th>
                <th style={thStyle}>
                  Event
                </th>
                {people.map((person) => (
                  <th key={person} style={{ ...thStyle, width: "52px", textAlign: "center" }}>
                    {person}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((event) => {
                const category = inferCategory(event)
                const categoryStyle = getCategoryStyle(category)
                const rowHighlighted =
                  selectedPeople.length > 0 && selectedPeople.some((person) => event.people.includes(person))

                return (
                  <tr
                    key={event.id}
                    style={{
                      background: `linear-gradient(90deg, ${categoryStyle.glow} 0%, ${categoryStyle.background} 100%)`,
                      opacity: selectedPeople.length && !rowHighlighted ? 0.46 : 1,
                    }}
                  >
                    <td
                      onDoubleClick={() => openEditModal(event)}
                      style={{
                        ...tdStyle,
                        color: categoryStyle.color,
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                        borderLeft: `4px solid ${categoryStyle.border}`,
                      }}
                    >
                      {formatEventRange(event)}
                    </td>
                    <td
                      onDoubleClick={() => openEditModal(event)}
                      style={{ ...tdStyle, color: "#edf7ff", fontWeight: 900 }}
                    >
                      {event.title}
                    </td>
                    {people.map((person) => {
                      const attending = event.people.includes(person)
                      const uncertain = (event.uncertainPeople || []).includes(person)
                      const highlighted = selectedPeople.includes(person)
                      return (
                        <td key={person} style={{ ...tdStyle, textAlign: "center" }}>
                          <button
                            type="button"
                            onClick={() => cycleAttendance(event.id, person)}
                            style={{
                              width: "36px",
                              border: highlighted
                                ? "1px solid rgba(143, 215, 255, 0.76)"
                                : uncertain || attending
                                  ? "1px solid rgba(255,255,255,0.16)"
                                  : "1px solid transparent",
                              borderRadius: "999px",
                              background: attending
                                ? "rgba(143, 215, 255, 0.2)"
                                : uncertain
                                  ? "rgba(255, 218, 97, 0.18)"
                                  : "transparent",
                              color: attending ? "#d9eeff" : uncertain ? "#ffe895" : "rgba(31, 45, 58, 0.58)",
                              cursor: "pointer",
                              fontSize: "10px",
                              fontWeight: attending || uncertain ? 900 : 700,
                              lineHeight: "12px",
                              padding: "2px 0",
                            }}
                          >
                            {uncertain ? "??" : person}
                          </button>
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

      {eventModalMode && (
        <div style={modalBackdropStyle}>
          <div style={modalStyle}>
            <h2 style={{ margin: "0 0 14px", fontSize: "24px" }}>
              {eventModalMode === "add" ? "New Event" : "Edit Event"}
            </h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "10px" }}>
              <label style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                From
                <input
                  type="date"
                  value={draftEvent.startDate}
                  onChange={(event) =>
                    setDraftEvent((current) => ({
                      ...current,
                      startDate: event.target.value,
                      endDate: current.endDate || event.target.value,
                    }))
                  }
                  style={inputStyle}
                />
              </label>
              <label style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                To
                <input
                  type="date"
                  value={draftEvent.endDate}
                  onChange={(event) => setDraftEvent((current) => ({ ...current, endDate: event.target.value }))}
                  style={inputStyle}
                />
              </label>
            </div>
            <label style={{ display: "block", color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "10px" }}>
              Event
              <input
                value={draftEvent.title}
                onChange={(event) => setDraftEvent((current) => ({ ...current, title: event.target.value }))}
                style={inputStyle}
              />
            </label>
            <div style={{ marginBottom: "10px" }}>
              <div style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
                Event Type
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "7px" }}>
                {categories
                  .filter((category): category is EventCategory => category !== "All")
                  .map((category) => {
                    const active = (draftEvent.eventType || "Unclassified") === category
                    const categoryStyle = getCategoryStyle(category)

                    return (
                      <button
                        key={category}
                        type="button"
                        onClick={() => setDraftEvent((current) => ({ ...current, eventType: category }))}
                        style={{
                          border: `1px solid ${active ? categoryStyle.border : "rgba(210,236,255,0.16)"}`,
                          borderRadius: "999px",
                          background: active ? categoryStyle.background : "rgba(2, 10, 18, 0.64)",
                          color: active ? categoryStyle.color : "#8fa9bf",
                          cursor: "pointer",
                          fontSize: "11px",
                          fontWeight: 900,
                          padding: "8px 11px",
                        }}
                      >
                        {category}
                      </button>
                    )
                  })}
              </div>
            </div>
            <div style={{ color: "#8fd7ff", fontSize: "11px", fontWeight: 900, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: "8px" }}>
              Attending
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "7px", marginBottom: "16px" }}>
              {people.map((person) => {
                const attending = draftEvent.people.includes(person)
                return (
                  <button
                    key={person}
                    type="button"
                    onClick={() =>
                      setDraftEvent((current) => ({
                        ...current,
                        people: attending
                          ? current.people.filter((item) => item !== person)
                          : [...current.people, person],
                        uncertainPeople: (current.uncertainPeople || []).filter((item) => item !== person),
                      }))
                    }
                    style={{
                      ...buttonStyle,
                      background: attending ? "rgba(143, 215, 255, 0.24)" : "rgba(2, 10, 18, 0.64)",
                      color: attending ? "#edf7ff" : "#8fa9bf",
                      minWidth: "42px",
                    }}
                  >
                    {person}
                  </button>
                )
              })}
            </div>
            <div style={{ display: "flex", justifyContent: eventModalMode === "edit" ? "space-between" : "flex-end", gap: "9px" }}>
              {eventModalMode === "edit" && (
                <button
                  type="button"
                  onClick={deleteDraftEvent}
                  style={{
                    ...buttonStyle,
                    borderColor: "rgba(255, 105, 105, 0.48)",
                    background: "linear-gradient(180deg, rgba(255, 91, 91, 0.26) 0%, rgba(177, 39, 56, 0.16) 100%)",
                    color: "#ffd6d6",
                  }}
                >
                  Delete Event
                </button>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "9px" }}>
                <button type="button" onClick={() => setEventModalMode(null)} style={buttonStyle}>
                  Cancel
                </button>
                <button type="button" onClick={saveDraftEvent} style={buttonStyle}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {peopleModalOpen && (
        <div style={modalBackdropStyle}>
          <div style={{ ...modalStyle, width: "min(460px, 100%)" }}>
            <h2 style={{ margin: "0 0 10px", fontSize: "24px" }}>People Columns</h2>
            <p style={{ margin: "0 0 12px", color: "#a9c4dc", fontSize: "13px", fontWeight: 700 }}>
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
            <p style={{ margin: "0 0 12px", color: "#a9c4dc", fontSize: "13px", fontWeight: 700 }}>
              One email per line. New and edited events will be emailed to this list from the configured fcuno.com sender.
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
