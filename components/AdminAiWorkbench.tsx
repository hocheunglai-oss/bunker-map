"use client"

import { useMemo, useState } from "react"

type CalendarDraft = {
  title: string
  startDate: string
  endDate: string
  people: string[]
  tags: string[]
  eventType: string
  confidence: number
  notes: string
}

type PhonebookCompanyDraft = {
  name: string
  otherName: string
  country: string
  phone: string
  address: string
  website: string
  email: string
  notes: string
  confidence: number
}

type PhonebookContactDraft = {
  fullName: string
  company: string
  title: string
  position: string
  department: string
  directLine: string
  mobileArea: string
  mobile1: string
  mobile2: string
  personalEmail: string
  generalEmail: string
  privateEmail: string
  notes: string
  confidence: number
}

type AiDraft = {
  summary: string
  calendarEvents: CalendarDraft[]
  phonebookCompanies: PhonebookCompanyDraft[]
  phonebookContacts: PhonebookContactDraft[]
  warnings: string[]
  provider?: string
  model?: string
}

type SelectionState = {
  calendarEvents: boolean[]
  phonebookCompanies: boolean[]
  phonebookContacts: boolean[]
}

function confidenceLabel(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`
}

function joinValues(values: string[]) {
  return values.filter(Boolean).join(", ") || "-"
}

function initialSelection(draft: AiDraft): SelectionState {
  return {
    calendarEvents: draft.calendarEvents.map(() => true),
    phonebookCompanies: draft.phonebookCompanies.map(() => true),
    phonebookContacts: draft.phonebookContacts.map(() => true),
  }
}

export function AdminAiWorkbench() {
  const [prompt, setPrompt] = useState("")
  const [draft, setDraft] = useState<AiDraft | null>(null)
  const [selection, setSelection] = useState<SelectionState>({
    calendarEvents: [],
    phonebookCompanies: [],
    phonebookContacts: [],
  })
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState(false)
  const [message, setMessage] = useState("")
  const [messageKind, setMessageKind] = useState<"info" | "error" | "success">("info")

  const selectedCount = useMemo(() => {
    return [
      ...selection.calendarEvents,
      ...selection.phonebookCompanies,
      ...selection.phonebookContacts,
    ].filter(Boolean).length
  }, [selection])

  async function generateDraft() {
    const value = prompt.trim()
    if (!value) {
      setMessageKind("error")
      setMessage("Enter something to process.")
      return
    }

    setLoading(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/ai-workbench", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "draft", prompt: value }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not generate draft.")

      const nextDraft = result as AiDraft
      setDraft(nextDraft)
      setSelection(initialSelection(nextDraft))
      setMessageKind("success")
      setMessage(
        [
          nextDraft.summary || "Draft ready.",
          nextDraft.provider || nextDraft.model
            ? `Provider: ${[nextDraft.provider, nextDraft.model].filter(Boolean).join(" / ")}.`
            : "",
        ].filter(Boolean).join(" "),
      )
    } catch (error) {
      setMessageKind("error")
      setMessage(error instanceof Error ? error.message : "Could not generate draft.")
    } finally {
      setLoading(false)
    }
  }

  async function applyDraft() {
    if (!draft || selectedCount === 0) return
    if (!window.confirm(`Apply ${selectedCount} selected draft item${selectedCount === 1 ? "" : "s"}?`)) {
      return
    }

    setApplying(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/ai-workbench", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "apply",
          calendarEvents: draft.calendarEvents.filter((_, index) => selection.calendarEvents[index]),
          phonebookCompanies: draft.phonebookCompanies.filter((_, index) => selection.phonebookCompanies[index]),
          phonebookContacts: draft.phonebookContacts.filter((_, index) => selection.phonebookContacts[index]),
        }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.message || "Could not apply draft.")

      const calendar = result.calendar || {}
      const phonebook = result.phonebook || {}
      const cardDav = phonebook.cardDav
      const syncText = cardDav?.message ? ` ${cardDav.message}` : ""
      setMessageKind(cardDav && !cardDav.ok ? "error" : "success")
      setMessage(
        `Applied. Calendar added ${calendar.inserted || 0}, skipped ${calendar.skipped || 0}. Phonebook created ${phonebook.contactsCreated || 0}, updated ${phonebook.contactsUpdated || 0}.${syncText}`,
      )
    } catch (error) {
      setMessageKind("error")
      setMessage(error instanceof Error ? error.message : "Could not apply draft.")
    } finally {
      setApplying(false)
    }
  }

  function toggleSelection(section: keyof SelectionState, index: number) {
    setSelection((current) => ({
      ...current,
      [section]: current[section].map((value, itemIndex) => (itemIndex === index ? !value : value)),
    }))
  }

  return (
    <section className="fc-admin-ai-workbench" aria-label="Admin AI workbench">
      <h2>What would you like to work on?</h2>
      <div className="fc-admin-ai-input-row">
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          className="fc-admin-ai-input"
          placeholder="Paste an event, meeting, contact, email signature, or phonebook update..."
          rows={4}
        />
        <button
          type="button"
          className="fc-admin-ai-primary-button"
          onClick={generateDraft}
          disabled={loading || applying}
        >
          {loading ? "Working..." : "Generate"}
        </button>
      </div>

      {message ? (
        <p className={`fc-admin-ai-message is-${messageKind}`}>{message}</p>
      ) : null}

      {draft ? (
        <div className="fc-admin-ai-results">
          {draft.warnings.length ? (
            <div className="fc-admin-ai-warning-list">
              {draft.warnings.map((warning) => (
                <span key={warning}>{warning}</span>
              ))}
            </div>
          ) : null}

          {draft.calendarEvents.length ? (
            <section className="fc-admin-ai-result-section">
              <div className="fc-admin-ai-result-heading">
                <h3>Event Calendar</h3>
                <a href="/admin/eventcalendar">Open</a>
              </div>
              <div className="fc-admin-ai-draft-list">
                {draft.calendarEvents.map((event, index) => (
                  <label className="fc-admin-ai-draft-row" key={`${event.startDate}-${event.title}-${index}`}>
                    <input
                      type="checkbox"
                      checked={selection.calendarEvents[index] || false}
                      onChange={() => toggleSelection("calendarEvents", index)}
                    />
                    <span>
                      <strong>{event.title}</strong>
                      <small>
                        {event.startDate === event.endDate ? event.startDate : `${event.startDate} to ${event.endDate}`}
                        {" | "}
                        {event.eventType}
                        {" | "}
                        People: {joinValues(event.people)}
                        {" | "}
                        {confidenceLabel(event.confidence)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          ) : null}

          {draft.phonebookCompanies.length || draft.phonebookContacts.length ? (
            <section className="fc-admin-ai-result-section">
              <div className="fc-admin-ai-result-heading">
                <h3>Phonebook</h3>
                <a href="/admin/phonebook">Open</a>
              </div>

              {draft.phonebookCompanies.length ? (
                <div className="fc-admin-ai-draft-list">
                  {draft.phonebookCompanies.map((company, index) => (
                    <label className="fc-admin-ai-draft-row" key={`${company.name}-${index}`}>
                      <input
                        type="checkbox"
                        checked={selection.phonebookCompanies[index] || false}
                        onChange={() => toggleSelection("phonebookCompanies", index)}
                      />
                      <span>
                        <strong>{company.name}</strong>
                        <small>
                          Company
                          {" | "}
                          {joinValues([company.country, company.phone, company.email])}
                          {" | "}
                          {confidenceLabel(company.confidence)}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}

              {draft.phonebookContacts.length ? (
                <div className="fc-admin-ai-draft-list">
                  {draft.phonebookContacts.map((contact, index) => (
                    <label className="fc-admin-ai-draft-row" key={`${contact.company}-${contact.fullName}-${index}`}>
                      <input
                        type="checkbox"
                        checked={selection.phonebookContacts[index] || false}
                        onChange={() => toggleSelection("phonebookContacts", index)}
                      />
                      <span>
                        <strong>{contact.fullName}</strong>
                        <small>
                          {contact.company}
                          {" | "}
                          {joinValues([contact.position, contact.mobile1, contact.personalEmail || contact.generalEmail])}
                          {" | "}
                          {confidenceLabel(contact.confidence)}
                        </small>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          <div className="fc-admin-ai-actions">
            <button
              type="button"
              className="fc-admin-ai-secondary-button"
              onClick={() => {
                setDraft(null)
                setSelection({ calendarEvents: [], phonebookCompanies: [], phonebookContacts: [] })
              }}
              disabled={applying}
            >
              Clear
            </button>
            <button
              type="button"
              className="fc-admin-ai-primary-button"
              onClick={applyDraft}
              disabled={applying || selectedCount === 0}
            >
              {applying ? "Applying..." : `Apply ${selectedCount}`}
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
