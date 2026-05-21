"use client"

import Script from "next/script"
import { useEffect, useMemo, useState } from "react"

type EmailTemplate = {
  id: string
  title: string
  subject: string
  folder: string
  bodyHtml: string
  bodyText: string
  tags: string[]
  placeholders: string[]
}

type FolderNode = {
  name: string
  path: string
  children: FolderNode[]
  templates: EmailTemplate[]
}

declare global {
  interface Window {
    Office?: any
  }
}

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  margin: 0,
  background: "#f5f9fc",
  fontFamily: "Arial, Helvetica, sans-serif",
  color: "#10243a",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: "10px",
  border: "1px solid #c3d7e8",
  background: "#ffffff",
  color: "#10243a",
  fontSize: "14px",
  boxSizing: "border-box",
}

const buttonStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "999px",
  border: "1px solid #0f4a7f",
  background: "#0f4a7f",
  color: "#ffffff",
  fontSize: "13px",
  fontWeight: 700,
  cursor: "pointer",
}

function buildFolderTree(templates: EmailTemplate[]) {
  const root: FolderNode = { name: "root", path: "", children: [], templates: [] }

  for (const template of templates) {
    const parts = (template.folder || "General")
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean)

    let node = root

    for (const part of parts) {
      const nextPath = node.path ? `${node.path} / ${part}` : part
      let child = node.children.find((entry) => entry.name === part && entry.path === nextPath)
      if (!child) {
        child = { name: part, path: nextPath, children: [], templates: [] }
        node.children.push(child)
      }
      node = child
    }

    node.templates.push(template)
  }

  function sortNode(node: FolderNode) {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.templates.sort((a, b) => a.title.localeCompare(b.title))
    node.children.forEach(sortNode)
    return node
  }

  return sortNode(root)
}

function renderFolderNode(
  node: FolderNode,
  selectedId: string,
  setSelectedId: (id: string) => void,
  depth = 0
): React.ReactNode {
  return (
    <div key={node.path || "root"} style={{ display: "grid", gap: "8px" }}>
      {node.path ? (
        <div
          style={{
            padding: "8px 12px",
            marginLeft: depth * 10,
            fontSize: "12px",
            color: "#40607c",
            fontWeight: 700,
            borderLeft: "2px solid #d7e6f2",
          }}
        >
          {node.name}
        </div>
      ) : null}

      {node.templates.map((template) => {
        const active = template.id === selectedId
        return (
          <button
            key={template.id}
            type="button"
            onClick={() => setSelectedId(template.id)}
            style={{
              textAlign: "left",
              marginLeft: (depth + (node.path ? 1 : 0)) * 10,
              padding: "12px",
              border: "1px solid #edf3f7",
              borderRadius: "10px",
              background: active ? "#eef7ff" : "#ffffff",
              cursor: "pointer",
            }}
          >
            <div style={{ fontSize: "13px", fontWeight: 700, color: "#16324a" }}>{template.title}</div>
            <div style={{ marginTop: "4px", fontSize: "12px", color: "#5c7893" }}>{template.subject || "No subject"}</div>
          </button>
        )
      })}

      {node.children.map((child) => renderFolderNode(child, selectedId, setSelectedId, depth + 1))}
    </div>
  )
}

export default function OutlookAddinTaskpanePage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [selectedId, setSelectedId] = useState("")
  const [search, setSearch] = useState("")
  const [message, setMessage] = useState("Loading templates...")
  const [officeReady, setOfficeReady] = useState(false)
  const [usePlaceholders, setUsePlaceholders] = useState(false)
  const [placeholderValues, setPlaceholderValues] = useState<Record<string, string>>({})

  useEffect(() => {
    async function loadTemplates() {
      try {
        const response = await fetch("/api/email-templates", { cache: "no-store" })
        if (!response.ok) throw new Error("Could not load shared templates.")
        const data = await response.json()
        setTemplates(Array.isArray(data.templates) ? data.templates : [])
        setSelectedId((data.templates?.[0]?.id as string) || "")
        setMessage("")
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not load shared templates.")
      }
    }

    loadTemplates()
  }, [])

  useEffect(() => {
    const office = window.Office
    if (!office?.onReady) return

    office.onReady(() => {
      setOfficeReady(true)
    })
  }, [])

  const filteredTemplates = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return templates.filter((template) => {
      if (!keyword) return true
      return [template.title, template.subject, template.folder, template.bodyText]
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
    setUsePlaceholders(false)
    setPlaceholderValues({})
  }, [selectedId])

  function applyPlaceholderValues(content: string) {
    if (!selectedTemplate || !usePlaceholders) return content

    return content.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (fullMatch, token) => {
      const value = placeholderValues[token]
      return value && value.trim().length > 0 ? value : fullMatch
    })
  }

  async function insertTemplate() {
    const office = window.Office
    const template = selectedTemplate

    if (!officeReady || !office?.context?.mailbox?.item || !template) {
      setMessage("Open this add-in while composing an Outlook email.")
      return
    }

    const item = office.context.mailbox.item
    setMessage("Inserting template...")

    const subject = applyPlaceholderValues(template.subject || "")
    const htmlBody = applyPlaceholderValues(template.bodyHtml || "")
    const textBody = applyPlaceholderValues(template.bodyText || "")

    item.subject.setAsync(subject, (subjectResult: any) => {
      if (subjectResult.status !== office.AsyncResultStatus.Succeeded) {
        setMessage(`Subject insert failed: ${subjectResult.error?.message || "Unknown error."}`)
        return
      }

      item.body.getTypeAsync((typeResult: any) => {
        if (typeResult.status !== office.AsyncResultStatus.Succeeded) {
          setMessage(`Body type check failed: ${typeResult.error?.message || "Unknown error."}`)
          return
        }

        const isHtml = typeResult.value === office.MailboxEnums.BodyType.Html
        const content = isHtml ? htmlBody : textBody
        const options = isHtml
          ? { coercionType: office.CoercionType.Html }
          : { coercionType: office.CoercionType.Text }

        item.body.setSelectedDataAsync(content, options, (bodyResult: any) => {
          if (bodyResult.status !== office.AsyncResultStatus.Succeeded) {
            setMessage(`Body insert failed: ${bodyResult.error?.message || "Unknown error."}`)
            return
          }

          setMessage(`Inserted "${template.title}".`)
        })
      })
    })
  }

  const folderTree = buildFolderTree(filteredTemplates)

  return (
    <div style={pageStyle}>
      <Script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js" strategy="beforeInteractive" />
      <div style={{ padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "14px" }}>
          <img src="/uno-transparent.png" alt="Fratelli Cosulich" style={{ width: 44, height: 44, objectFit: "contain" }} />
          <div>
            <div style={{ fontSize: "12px", color: "#5a7a98", textTransform: "uppercase", fontWeight: 700 }}>Shared Library</div>
            <h1 style={{ margin: "2px 0 0", fontSize: "20px" }}>Email Templates</h1>
          </div>
        </div>

        <div style={{ display: "grid", gap: "10px", marginBottom: "14px" }}>
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search templates" style={inputStyle} />
          <button type="button" onClick={insertTemplate} style={buttonStyle}>
            {usePlaceholders && selectedTemplate?.placeholders.length ? "Insert with chosen values" : "Insert into email"}
          </button>
          <a href="/admin/emailtemplates" target="_blank" rel="noreferrer" style={{ ...buttonStyle, textAlign: "center", textDecoration: "none" }}>
            Manage templates
          </a>
        </div>

        {message ? (
          <div style={{ marginBottom: "12px", fontSize: "13px", color: "#41627f", lineHeight: 1.5 }}>{message}</div>
        ) : null}

        <div style={{ display: "grid", gap: "12px", background: "#ffffff", border: "1px solid #d7e6f2", borderRadius: "12px", padding: "12px" }}>
          {renderFolderNode(folderTree, selectedId, setSelectedId)}
        </div>

        {selectedTemplate ? (
          <section style={{ marginTop: "16px", background: "#ffffff", border: "1px solid #d7e6f2", borderRadius: "12px", padding: "14px" }}>
            {selectedTemplate.placeholders.length > 0 ? (
              <div style={{ marginBottom: "16px", paddingBottom: "14px", borderBottom: "1px solid #edf3f7" }}>
                <label style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px", fontSize: "13px", color: "#35526d" }}>
                  <input
                    type="checkbox"
                    checked={usePlaceholders}
                    onChange={(event) => setUsePlaceholders(event.target.checked)}
                  />
                  Use optional placeholders
                </label>

                {usePlaceholders ? (
                  <div style={{ display: "grid", gap: "10px" }}>
                    {selectedTemplate.placeholders.map((token) => (
                      <label key={token}>
                        <div style={{ fontSize: "12px", color: "#5c7893", marginBottom: "4px", fontWeight: 700 }}>
                          {`{{${token}}}`}
                        </div>
                        <input
                          value={placeholderValues[token] || ""}
                          onChange={(event) =>
                            setPlaceholderValues((current) => ({
                              ...current,
                              [token]: event.target.value,
                            }))
                          }
                          placeholder="Leave blank to keep token unchanged"
                          style={inputStyle}
                        />
                      </label>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: "12px", color: "#5c7893", lineHeight: 1.5 }}>
                    This template includes optional placeholders. Leave this off to insert the original template exactly as saved.
                  </div>
                )}
              </div>
            ) : null}

            <div style={{ fontSize: "13px", color: "#40607c", fontWeight: 700, marginBottom: "8px" }}>Preview</div>
            <div style={{ fontSize: "13px", color: "#10243a", marginBottom: "8px" }}>
              <strong>Subject:</strong> {applyPlaceholderValues(selectedTemplate.subject || "(blank)")}
            </div>
            <div
              style={{ fontSize: "13px", lineHeight: 1.5, color: "#10243a" }}
              dangerouslySetInnerHTML={{ __html: applyPlaceholderValues(selectedTemplate.bodyHtml || "<p></p>") }}
            />
          </section>
        ) : null}
      </div>
    </div>
  )
}
