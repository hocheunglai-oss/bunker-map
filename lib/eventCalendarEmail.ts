import { OfficeCalendarEvent } from "@/data/eventCalendar"

const TIME_ZONE = "Asia/Hong_Kong"

export function normalizeEmailList(value: unknown) {
  const raw = Array.isArray(value) ? value.join(",") : typeof value === "string" ? value : ""

  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((item) => {
          const trimmed = item.trim().toLowerCase()
          return trimmed.match(/<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/)?.[1] || trimmed
        })
        .filter((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    )
  )
}

function parseLocalDate(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return new Date(year, month - 1, day)
}

export function formatEventDate(value: string) {
  const date = parseLocalDate(value)
  const day = String(date.getDate()).padStart(2, "0")
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: TIME_ZONE }).format(date)
  const year = String(date.getFullYear()).slice(-2)
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: TIME_ZONE }).format(date)
  return `${day} ${month} ${year} (${weekday})`
}

export function formatEventRange(event: Pick<OfficeCalendarEvent, "startDate" | "endDate">) {
  if (event.startDate === event.endDate) return formatEventDate(event.startDate)
  return `${formatEventDate(event.startDate)} - ${formatEventDate(event.endDate)}`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function buildChangedEventEmail(event: OfficeCalendarEvent, action: "created" | "updated") {
  const actionText = action === "created" ? "New event added" : "Event updated"
  const people = event.people.length ? event.people.join(", ") : "No attendees selected"

  return {
    subject: `${actionText}: ${event.title}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
        <h2 style="margin:0 0 12px">${escapeHtml(actionText)}</h2>
        <p style="margin:0 0 8px"><strong>Date:</strong> ${escapeHtml(formatEventRange(event))}</p>
        <p style="margin:0 0 8px"><strong>Event:</strong> ${escapeHtml(event.title)}</p>
        <p style="margin:0 0 8px"><strong>People:</strong> ${escapeHtml(people)}</p>
        <p style="margin:0;color:#5f7384">Sent from FC Event Calendar.</p>
      </div>
    `,
  }
}

export function buildDailyReminderEmail(events: OfficeCalendarEvent[], dateText: string) {
  const rows = events.length
    ? events
        .map(
          (event) => `
            <tr>
              <td style="padding:8px;border-bottom:1px solid #e3edf5;white-space:nowrap">${escapeHtml(formatEventRange(event))}</td>
              <td style="padding:8px;border-bottom:1px solid #e3edf5">${escapeHtml(event.title)}</td>
              <td style="padding:8px;border-bottom:1px solid #e3edf5;white-space:nowrap">${escapeHtml(event.people.join(", ") || "-")}</td>
            </tr>
          `
        )
        .join("")
    : `<tr><td colspan="3" style="padding:10px;color:#5f7384">No events for today.</td></tr>`

  return {
    subject: `FC Event Calendar Reminder - ${formatEventDate(dateText)}`,
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
        <h2 style="margin:0 0 12px">Today&apos;s Events - ${escapeHtml(formatEventDate(dateText))}</h2>
        <table cellspacing="0" cellpadding="0" style="border-collapse:collapse;width:100%;font-size:13px">
          <thead>
            <tr>
              <th align="left" style="padding:8px;border-bottom:2px solid #bfd6e8">Date</th>
              <th align="left" style="padding:8px;border-bottom:2px solid #bfd6e8">Event</th>
              <th align="left" style="padding:8px;border-bottom:2px solid #bfd6e8">People</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:14px 0 0;color:#5f7384">Sent from FC Event Calendar.</p>
      </div>
    `,
  }
}

export async function sendCalendarEmail(input: {
  to: string[]
  subject: string
  html: string
}) {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured.")

  const from = process.env.EVENT_CALENDAR_EMAIL_FROM || "FC Event Calendar <calendar@fcuno.com>"
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  })

  if (!response.ok) {
    const message = await response.text()
    throw new Error(message || "Email send failed.")
  }

  return response.json()
}
