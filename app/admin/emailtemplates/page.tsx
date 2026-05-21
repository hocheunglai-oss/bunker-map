"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type EmailTemplate = {
  id: string
  title: string
  subject: string
  folder: string
  sourcePath: string
  from: string
  to: string
  cc: string
  bcc: string
  bodyHtml: string
  bodyText: string
  tags: string[]
  slug: string
  isActive: boolean
  placeholders: string[]
  updatedAt: string
}

type TemplateLibraryResponse = {
  templates: EmailTemplate[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "linear-gradient(180deg, #0a2c4c 0%, #06213b 32%, #041629 100%)",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#edf7ff",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  background: "linear-gradient(180deg, rgba(14, 43, 70, 0.88) 0%, rgba(7, 26, 44, 0.86) 100%)",
  border: "1px solid rgba(210, 236, 255, 0.14)",
  borderRadius: "18px",
  boxShadow: "0 20px 44px rgba(0, 0, 0, 0.18), inset 0 1px 0 rgba(255,255,255,0.05)",
}

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "999px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.1) 100%)",
  color: "#d7e8ff",
  fontSize: "12px",
  fontWeight: 700,
  cursor: "pointer",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "12px 14px",
  borderRadius: "14px",
  border: "1px solid rgba(210,236,255,0.16)",
  background: "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
  color: "#edf7ff",
  fontSize: "14px",
  outline: "none",
  boxSizing: "border-box",
}

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  minHeight: "120px",
  resize: "vertical",
  fontFamily: "Arial, Helvetica, sans-serif",
}

function createBlankTemplate(): EmailTemplate {
  const now = new Date().toISOString()

  return {
    id: `manual-${Date.now()}`,
    title: "New template",
    subject: "",
    folder: "Custom",
    sourcePath: "",
    from: "",
    to: "",
    cc: "",
    bcc: "",
    bodyHtml: "<p></p>",
    bodyText: "",
    tags: ["Custom"],
    slug: `manual-${Date.now()}`,
    isActive: true,
    placeholders: [],
    updatedAt: now,
  }
}

export default function EmailTemplatesAdminPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { loading, authenticated } = useSimpleAdminAuth()
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [selectedId, setSelectedId] = useState<string>("")
  const [search, setSearch] = useState("")
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [lastImportedAt, setLastImportedAt] = useState<string | null>(null)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)

  const filteredTemplates = useMemo(() => {
    const keyword = search.trim().toLowerCase()

    return templates.filter((template) => {
      if (!keyword) return true

      return [
        template.title,
        template.subject,
        template.folder,
        template.bodyText,
        template.to,
        template.cc,
        template.bcc,
      ]
        .join(" ")
        .toLowerCase()
        .includes(keyword)
    })
  }, [search, templates])

  const selectedTemplate =
    filteredTemplates.find((template) => template.id === selectedId) ||
    templates.find((template) => template.id === selectedId) ||
    null

  useEffect(() => {
    if (!authenticated) return

    async function loadTemplates() {
      try {
        const response = await fetch("/api/admin/email-templates", {
          cache: "no-store",
        })

        if (!response.ok) {
          throw new Error("Failed to load templates.")
        }

        const data = (await response.json()) as TemplateLibraryResponse
        setTemplates(data.templates || [])
        setLastImportedAt(data.lastImportedAt)
        setLastUpdatedAt(data.lastUpdatedAt)
        setSelectedId((current) => current || data.templates?.[0]?.id || "")
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to load templates.")
      }
    }

    loadTemplates()
  }, [authenticated])

  function updateTemplate(nextPartial: Partial<EmailTemplate>) {
    if (!selectedTemplate) return

    const nextUpdatedAt = new Date().toISOString()

    setTemplates((current) =>
      current.map((template) =>
        template.id === selectedTemplate.id
          ? {
              ...template,
              ...nextPartial,
              updatedAt: nextUpdatedAt,
            }
          : template
      )
    )
    setLastUpdatedAt(nextUpdatedAt)
  }

  async function handleImport() {
    setBusy(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "import" }),
      })

      if (!response.ok) {
        throw new Error("Import failed.")
      }

      const data = (await response.json()) as TemplateLibraryResponse
      setTemplates(data.templates || [])
      setLastImportedAt(data.lastImportedAt)
      setLastUpdatedAt(data.lastUpdatedAt)
      setSelectedId(data.templates?.[0]?.id || "")
      setMessage(`Imported ${data.templates.length} templates from Thunderbird.`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed.")
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    setBusy(true)
    setMessage("")

    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "save", templates }),
      })

      if (!response.ok) {
        throw new Error("Save failed.")
      }

      const data = (await response.json()) as TemplateLibraryResponse
      setLastUpdatedAt(data.lastUpdatedAt)
      setMessage("Templates saved to the website library.")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Save failed.")
    } finally {
      setBusy(false)
    }
  }

  function handleCreate() {
    const template = createBlankTemplate()
    setTemplates((current) => [template, ...current])
    setSelectedId(template.id)
    setLastUpdatedAt(template.updatedAt)
  }

  function handleDuplicate() {
    if (!selectedTemplate) return

    const duplicated: EmailTemplate = {
      ...selectedTemplate,
      id: `copy-${Date.now()}`,
      title: `${selectedTemplate.title} Copy`,
      updatedAt: new Date().toISOString(),
    }

    setTemplates((current) => [duplicated, ...current])
    setSelectedId(duplicated.id)
    setLastUpdatedAt(duplicated.updatedAt)
  }

  function handleDelete() {
    if (!selectedTemplate) return

    const nextTemplates = templates.filter((template) => template.id !== selectedTemplate.id)
    setTemplates(nextTemplates)
    setSelectedId(nextTemplates[0]?.id || "")
    setLastUpdatedAt(new Date().toISOString())
  }

  if (loading) {
    return <p style={{ padding: "40px" }}>Loading...</p>
  }

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <div style={{ ...panelStyle, padding: "24px", maxWidth: "520px", margin: "0 auto" }}>
          <h1 style={{ marginTop: 0 }}>Email Templates</h1>
          <p style={{ color: "#c9e7ff", lineHeight: 1.6 }}>
            Please log in from the admin homepage first, then come back here.
          </p>
          <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
            Back to Admin
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "340px minmax(0, 1fr)",
          gap: "18px",
          alignItems: "start",
        }}
      >
        <aside style={{ ...panelStyle, padding: "18px", position: isMobile ? "static" : "sticky", top: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: "10px", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
                Office Tools
              </div>
              <h1 style={{ margin: "6px 0 0", fontSize: "28px" }}>Email Templates</h1>
            </div>
            <button type="button" onClick={() => router.push("/admin")} style={buttonStyle}>
              Back
            </button>
          </div>

          <div style={{ display: "grid", gap: "10px", marginTop: "16px" }}>
            <button type="button" onClick={handleImport} style={buttonStyle} disabled={busy}>
              {busy ? "Working..." : "Import Thunderbird"}
            </button>
            <button type="button" onClick={handleSave} style={buttonStyle} disabled={busy}>
              Save Website Library
            </button>
            <button type="button" onClick={handleCreate} style={buttonStyle}>
              New Template
            </button>
          </div>

          <div style={{ marginTop: "16px" }}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search templates"
              style={inputStyle}
            />
          </div>

          <div style={{ marginTop: "16px", fontSize: "12px", color: "#bedfff", lineHeight: 1.6 }}>
            <div>{templates.length} templates in library</div>
            <div>Imported: {lastImportedAt ? new Date(lastImportedAt).toLocaleString() : "Not yet"}</div>
            <div>Saved: {lastUpdatedAt ? new Date(lastUpdatedAt).toLocaleString() : "Not yet"}</div>
          </div>

          {message ? (
            <p style={{ marginTop: "14px", fontSize: "13px", color: "#ffd89a", lineHeight: 1.5 }}>
              {message}
            </p>
          ) : null}

          <div style={{ display: "grid", gap: "10px", marginTop: "18px", maxHeight: isMobile ? "none" : "62vh", overflowY: "auto", paddingRight: "4px" }}>
            {filteredTemplates.map((template) => {
              const active = template.id === selectedId

              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setSelectedId(template.id)}
                  style={{
                    textAlign: "left",
                    padding: "12px",
                    borderRadius: "14px",
                    border: active ? "1px solid rgba(145, 215, 255, 0.42)" : "1px solid rgba(210,236,255,0.12)",
                    background: active
                      ? "linear-gradient(180deg, rgba(63, 137, 208, 0.28) 0%, rgba(15, 52, 92, 0.22) 100%)"
                      : "linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.05) 100%)",
                    color: "#edf7ff",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: "13px" }}>{template.title || "Untitled template"}</div>
                  <div style={{ fontSize: "11px", color: "#8fd7ff", marginTop: "4px" }}>{template.folder || "No folder"}</div>
                  <div style={{ fontSize: "12px", color: "#cde7ff", marginTop: "6px", opacity: 0.9 }}>
                    {template.subject || "No subject"}
                  </div>
                </button>
              )
            })}
          </div>
        </aside>

        <main style={{ ...panelStyle, padding: "18px" }}>
          {selectedTemplate ? (
            <div style={{ display: "grid", gap: "16px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <div>
                  <div style={{ fontSize: "12px", letterSpacing: "0.12em", textTransform: "uppercase", color: "#8fd7ff", fontWeight: 700 }}>
                    Template Editor
                  </div>
                  <div style={{ marginTop: "6px", color: "#c7e7ff", fontSize: "13px" }}>
                    Source: {selectedTemplate.sourcePath || "Website only"}
                  </div>
                </div>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  <button type="button" onClick={handleDuplicate} style={buttonStyle}>
                    Duplicate
                  </button>
                  <button type="button" onClick={handleDelete} style={buttonStyle}>
                    Delete
                  </button>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "14px" }}>
                <label>
                  <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>Title</div>
                  <input
                    value={selectedTemplate.title}
                    onChange={(event) => updateTemplate({ title: event.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>Folder</div>
                  <input
                    value={selectedTemplate.folder}
                    onChange={(event) =>
                      updateTemplate({
                        folder: event.target.value,
                        tags: event.target.value
                          .split("/")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                    style={inputStyle}
                  />
                </label>
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "10px", color: "#cde7ff", fontSize: "13px" }}>
                <input
                  id="template-active"
                  type="checkbox"
                  checked={selectedTemplate.isActive}
                  onChange={(event) => updateTemplate({ isActive: event.target.checked })}
                />
                <label htmlFor="template-active">Available in Outlook add-in</label>
              </div>

              <div
                style={{
                  padding: "14px",
                  borderRadius: "14px",
                  border: "1px solid rgba(210,236,255,0.12)",
                  background: "linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)",
                }}
              >
                <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "8px", fontWeight: 700 }}>
                  Optional Placeholders
                </div>
                <div style={{ fontSize: "13px", color: "#cde7ff", lineHeight: 1.6 }}>
                  {selectedTemplate.placeholders.length > 0
                    ? selectedTemplate.placeholders.map((token) => `{{${token}}}`).join(", ")
                    : "No placeholders detected in this template."}
                </div>
                <div style={{ fontSize: "12px", color: "#9ec8e6", marginTop: "8px", lineHeight: 1.6 }}>
                  Add tokens like `{"{{vessel_name}}"}`, `{"{{port}}"}` or `{"{{eta}}"}` in subject/body. In Outlook, users can ignore them and insert the raw template, or fill only the fields they want.
                </div>
              </div>

              <label>
                <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>Subject</div>
                <input
                  value={selectedTemplate.subject}
                  onChange={(event) => updateTemplate({ subject: event.target.value })}
                  style={inputStyle}
                />
              </label>

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: "14px" }}>
                <label>
                  <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>To</div>
                  <input
                    value={selectedTemplate.to}
                    onChange={(event) => updateTemplate({ to: event.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>Cc</div>
                  <input
                    value={selectedTemplate.cc}
                    onChange={(event) => updateTemplate({ cc: event.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>Bcc</div>
                  <input
                    value={selectedTemplate.bcc}
                    onChange={(event) => updateTemplate({ bcc: event.target.value })}
                    style={inputStyle}
                  />
                </label>
              </div>

              <label>
                <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>HTML Body</div>
                <textarea
                  value={selectedTemplate.bodyHtml}
                  onChange={(event) =>
                    updateTemplate({
                      bodyHtml: event.target.value,
                      bodyText: event.target.value
                        .replace(/<br\s*\/?>/gi, "\n")
                        .replace(/<\/p>/gi, "\n\n")
                        .replace(/<[^>]+>/g, "")
                        .trim(),
                    })
                  }
                  style={{ ...textareaStyle, minHeight: "320px", fontFamily: "Menlo, Monaco, Consolas, monospace" }}
                />
              </label>

              <label>
                <div style={{ fontSize: "12px", color: "#8fd7ff", marginBottom: "6px", fontWeight: 700 }}>Preview</div>
                <div
                  style={{
                    minHeight: "180px",
                    padding: "18px",
                    borderRadius: "16px",
                    border: "1px solid rgba(210,236,255,0.14)",
                    background: "rgba(255,255,255,0.97)",
                    color: "#10243a",
                    overflowX: "auto",
                  }}
                  dangerouslySetInnerHTML={{ __html: selectedTemplate.bodyHtml || "<p></p>" }}
                />
              </label>
            </div>
          ) : (
            <div style={{ color: "#c9e7ff" }}>Import or create a template to start editing.</div>
          )}
        </main>
      </div>
    </div>
  )
}
