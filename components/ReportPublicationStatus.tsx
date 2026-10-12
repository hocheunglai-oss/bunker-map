"use client"

import type { useReportPublication } from "@/lib/useReportPublication"

type Publication = ReturnType<typeof useReportPublication>
function price(value: unknown): string {
  if (value && typeof value === "object" && "today" in value) return price((value as { today: unknown }).today)
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "–"
}
export function ReportPublicationStatus({ title, publication, busy = false }: { title: string; publication: Publication; busy?: boolean }) {
  const preview = publication.baseline?.preview
  const rows: Array<Record<string, unknown>> = Array.isArray(preview?.rows) ? preview.rows
    : Array.isArray(preview?.sections) ? preview.sections.flatMap(section => section.rows || []) : []
  return <div style={{ fontSize: "12px", margin: "8px 0" }}>
    {publication.message && <p role={publication.status === "reload" ? "alert" : "status"}>{title}: {publication.message}</p>}
    {publication.loading && <p role="status">Loading saved {title} report…</p>}
    {publication.baseline?.publishedReportDamaged && <p role="alert">The published {title} report is damaged. Review the saved prices below, then publish to replace it. Nothing changes until you publish.</p>}
    <div style={{ display: "flex", alignItems: "start", gap: "12px", flexWrap: "wrap" }}>
      <button type="button" disabled={busy || publication.publishing || publication.loading}
        onClick={() => { void publication.reload() }}>Reload saved {title} report</button>
      {preview && <details>
        <summary>Review saved {title} report · {String(preview.reportDate)}</summary>
        <table aria-label={`${title} saved report preview`}><thead><tr><th>Port</th><th>HSFO</th><th>VLSFO</th><th>MGO</th></tr></thead>
          <tbody>{rows.map((row, index) => <tr key={index}><td>{String(row.port || "")}</td>
            <td>{price(row.hsfo)}</td><td>{price(row.vlsfo)}</td><td>{price(row.mgo)}</td></tr>)}</tbody></table>
        {[preview.remark, preview.specialNotice].map((text, index) => typeof text === "string" && text && <p key={index} style={{ whiteSpace: "pre-wrap" }}>{text}</p>)}
      </details>}
    </div>
  </div>
}
