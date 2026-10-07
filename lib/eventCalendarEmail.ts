import { OfficeCalendarEvent } from "@/data/eventCalendar"
import { normalizeEmailList, sendNoticeEmail } from "@/lib/emailNotice"
import { fcunoConnectionPolicy } from "@/config/fcunoConnections"

export { normalizeEmailList }

const EVENT_CALENDAR_URL = `${fcunoConnectionPolicy.vercel.productionOrigins[0]}/admin/eventcalendar`

function parseLocalDate(value: string) {
  return new Date(`${value}T12:00:00.000Z`)
}

export function formatEventDate(value: string) {
  const date = parseLocalDate(value)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const month = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" }).format(date)
  const year = String(date.getUTCFullYear()).slice(-2)
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(date)
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

export function buildChangedEventEmail(event: OfficeCalendarEvent) {
  const people = event.people.length ? event.people.join(", ") : "No attendees selected"

  return {
    subject: "***** Event Calendar Update",
    html: `
      <div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.45">
        <p style="margin:0 0 8px"><strong>Date:</strong> ${escapeHtml(formatEventRange(event))}</p>
        <p style="margin:0 0 8px"><strong>Event:</strong> ${escapeHtml(event.title)}</p>
        <p style="margin:0 0 8px"><strong>Who is attending:</strong> ${escapeHtml(people)}</p>
        <p style="margin:12px 0 0"><a href="${EVENT_CALENDAR_URL}" style="color:#0a73c9">${EVENT_CALENDAR_URL}</a></p>
      </div>
    `,
  }
}

export function buildChangedEventsEmail(events: OfficeCalendarEvent[], action: "created" | "updated") {
  if (events.length === 1) return buildChangedEventEmail(events[0])
  return {
    subject: "***** Event Calendar Update",
    html: `<div style="font-family:Arial,Helvetica,sans-serif;color:#10243a;line-height:1.5"><p>${events.length} calendar events were ${action}.</p><ul>${events.map((event) => `<li style="margin-bottom:8px"><strong>${escapeHtml(formatEventRange(event))}</strong><br />${escapeHtml(event.title)}<br />Attending: ${escapeHtml(event.people.join(", ") || "None selected")}</li>`).join("")}</ul><p><a href="${EVENT_CALENDAR_URL}">Open Event Calendar</a></p></div>`,
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
  cc?: string[]
  subject: string
  html: string
}) {
  return sendNoticeEmail(input)
}
