"use client"

import { useEffect, useMemo, useRef, useState } from "react"
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
  updatedAt: string
}

type TemplateLibraryResponse = {
  templates: EmailTemplate[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
}

type SaveTemplateResponse = {
  id?: string
  template?: EmailTemplate
  lastUpdatedAt?: string | null
  message?: string
}

type FolderNode = {
  name: string
  path: string
  depth: number
  children: FolderNode[]
  templates: EmailTemplate[]
  totalCount: number
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed"

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  color: "var(--fc-admin-panel-text)",
  fontFamily: "var(--fc-admin-font)",
  padding: "18px",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "34px",
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

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-success-border)",
  background: "var(--fc-admin-success-bg)",
  color: "var(--fc-admin-success-text)",
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "var(--fc-admin-danger-border)",
  background: "var(--fc-admin-danger-bg)",
  color: "var(--fc-admin-danger-text)",
}

const panelStyle: React.CSSProperties = {
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  background: "var(--fc-admin-panel-bg)",
  boxShadow: "0 12px 28px #00000010",
  overflow: "hidden",
}

const sectionHeaderStyle: React.CSSProperties = {
  minHeight: "38px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
}

const sectionTitleStyle: React.CSSProperties = {
  minWidth: 0,
  color: "var(--fc-admin-heading)",
  fontSize: "12px",
  fontWeight: 900,
  textTransform: "uppercase",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "34px",
  border: "1px solid var(--fc-input-border)",
  borderRadius: "12px",
  background: "var(--fc-tool-input-bg)",
  color: "var(--fc-tool-input-text)",
  fontSize: "13px",
  outline: "none",
  padding: "0 10px",
}

function createFolderNode(name: string, folderPath: string, depth: number): FolderNode {
  return {
    name,
    path: folderPath,
    depth,
    children: [],
    templates: [],
    totalCount: 0,
  }
}

function getFolderParts(folder: string) {
  return (folder || "Unfiled")
    .split(" / ")
    .map((part) => part.trim())
    .filter(Boolean)
}

function buildFolderTree(templates: EmailTemplate[]) {
  const root = createFolderNode("All templates", "", 0)
  const index: Record<string, FolderNode> = { "": root }

  templates.forEach((template) => {
    let node = root
    getFolderParts(template.folder).forEach((part, partIndex) => {
      const nextPath = node.path ? `${node.path} / ${part}` : part
      if (!index[nextPath]) {
        index[nextPath] = createFolderNode(part, nextPath, partIndex + 1)
        node.children.push(index[nextPath])
      }
      node = index[nextPath]
    })
    node.templates.push(template)
  })

  function sortAndCount(node: FolderNode): number {
    node.children.sort((a, b) => a.name.localeCompare(b.name))
    node.templates.sort((a, b) => a.title.localeCompare(b.title))
    node.totalCount =
      node.templates.length + node.children.reduce((sum, child) => sum + sortAndCount(child), 0)
    return node.totalCount
  }

  sortAndCount(root)
  return { root, index }
}

function folderContains(template: EmailTemplate, folder: string) {
  if (!folder) return true
  return template.folder === folder || template.folder.startsWith(`${folder} / `)
}

function normaliseSearchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function matchesLooseSearch(template: EmailTemplate, query: string) {
  const tokens = normaliseSearchText(query).split(" ").filter(Boolean)
  if (tokens.length === 0) return true

  const haystack = normaliseSearchText(
    [
      template.title,
      template.subject,
      template.folder,
      template.bodyText,
      template.to,
      template.cc,
      template.bcc,
    ].join(" ")
  )

  return tokens.every((token) => haystack.includes(token))
}

function htmlToText(html: string) {
  if (typeof document === "undefined") return ""
  const div = document.createElement("div")
  div.innerHTML = html
  return (div.textContent || "").trim()
}

function createBlankTemplate(folder: string): EmailTemplate {
  const now = new Date().toISOString()
  const id = `manual-${Date.now()}`
  const safeFolder = folder || "Custom"

  return {
    id,
    title: "New template",
    subject: "",
    folder: safeFolder,
    sourcePath: "",
    from: "",
    to: "",
    cc: "",
    bcc: "",
    bodyHtml: "<p></p>",
    bodyText: "",
    tags: getFolderParts(safeFolder),
    slug: id,
    isActive: true,
    updatedAt: now,
  }
}

export default function EmailTemplatesAdminPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { loading, authenticated } = useSimpleAdminAuth()
  const editorRef = useRef<HTMLDivElement | null>(null)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dirtyVersionRef = useRef(0)
  const pendingTemplateRef = useRef<EmailTemplate | null>(null)
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [selectedFolder, setSelectedFolder] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({ "": true })
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [search, setSearch] = useState("")
  const [message, setMessage] = useState("")
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [saveRevision, setSaveRevision] = useState(0)
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    document.title = "Email Templates - FC Uno"
  }, [])

  const folderTree = useMemo(() => buildFolderTree(templates), [templates])
  const folderCount = Math.max(Object.keys(folderTree.index).length - 1, 0)

  const visibleTemplates = useMemo(() => {
    return templates.filter((template) => {
      if (search.trim()) return matchesLooseSearch(template, search)

      return folderContains(template, selectedFolder)
    })
  }, [search, selectedFolder, templates])

  const selectedTemplate = templates.find((template) => template.id === selectedId) || null

  useEffect(() => {
    if (!authenticated) return

    async function loadTemplates() {
      try {
        const response = await fetch("/api/admin/email-templates", { cache: "no-store" })
        if (!response.ok) throw new Error("Failed to load templates.")

        const data = (await response.json()) as TemplateLibraryResponse
        const loadedTemplates = data.templates || []
        const built = buildFolderTree(loadedTemplates)
        const preferredFolder = built.index["Outgoing / Bunker"]
          ? "Outgoing / Bunker"
          : Object.keys(built.index).find((folder) => folder) || ""

        setTemplates(loadedTemplates)
        setSelectedFolder(preferredFolder)
        setExpandedFolders((current) => expandFolderPath(preferredFolder, current))
        setSelectedId(
          loadedTemplates.find((template) => folderContains(template, preferredFolder))?.id ||
            loadedTemplates[0]?.id ||
            ""
        )
        setLastUpdatedAt(data.lastUpdatedAt)
        setSaveState("saved")
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to load templates.")
      }
    }

    loadTemplates()
  }, [authenticated])

  useEffect(() => {
    if (!editorRef.current || !selectedTemplate) return
    editorRef.current.innerHTML = selectedTemplate.bodyHtml || "<p></p>"
  }, [selectedId])

  useEffect(() => {
    if (!authenticated) return
    if (saveState !== "dirty") return
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => {
      const template = pendingTemplateRef.current
      if (template) void saveTemplate(template, dirtyVersionRef.current)
    }, 850)

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    }
  }, [authenticated, saveRevision, saveState])

  function expandFolderPath(folderPath: string, current: Record<string, boolean> = {}) {
    const next: Record<string, boolean> = { ...current, "": true }
    let cursor = ""
    getFolderParts(folderPath).forEach((part) => {
      cursor = cursor ? `${cursor} / ${part}` : part
      next[cursor] = true
    })
    return next
  }

  function markDirty(template: EmailTemplate) {
    dirtyVersionRef.current += 1
    pendingTemplateRef.current = template
    setSaveState("dirty")
    setSaveRevision((current) => current + 1)
  }

  function updateSelectedTemplate(partial: Partial<EmailTemplate>) {
    if (!selectedTemplate) return
    const updatedAt = new Date().toISOString()
    const nextTemplate: EmailTemplate = {
      ...selectedTemplate,
      ...partial,
      updatedAt,
    }
    setTemplates((current) =>
      current.map((template) => (template.id === selectedTemplate.id ? nextTemplate : template))
    )
    setLastUpdatedAt(updatedAt)
    markDirty(nextTemplate)
  }

  function handleEditorInput() {
    if (!editorRef.current || !selectedTemplate) return
    const bodyHtml = editorRef.current.innerHTML
    const bodyText = htmlToText(bodyHtml)
    if (bodyHtml === selectedTemplate.bodyHtml && bodyText === selectedTemplate.bodyText) return
    updateSelectedTemplate({
      bodyHtml,
      bodyText,
    })
  }

  function runEditorCommand(command: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    handleEditorInput()
  }

  async function saveTemplate(template: EmailTemplate, version = dirtyVersionRef.current) {
    setSaveState("saving")
    setMessage("")

    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save-template", template }),
      })

      const data = (await response.json()) as SaveTemplateResponse
      if (!response.ok) throw new Error(data.message || "Save failed.")

      const savedTemplate = data.template || template
      if (dirtyVersionRef.current !== version) {
        setSaveState("dirty")
        setSaveRevision((current) => current + 1)
        return
      }

      pendingTemplateRef.current = null
      setTemplates((current) =>
        current.map((item) => (item.id === savedTemplate.id ? { ...item, ...savedTemplate } : item))
      )
      setLastUpdatedAt(data.lastUpdatedAt || savedTemplate.updatedAt || new Date().toISOString())
      setSaveState("saved")
    } catch (error) {
      setSaveState("failed")
      setMessage(error instanceof Error ? error.message : "Save failed.")
    }
  }

  function handleManualSave() {
    const template = pendingTemplateRef.current || selectedTemplate
    if (!template) return
    void saveTemplate(template, dirtyVersionRef.current)
  }

  async function deleteTemplate(templateId: string) {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    pendingTemplateRef.current = null
    dirtyVersionRef.current += 1
    setSaveState("saving")
    setMessage("")

    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete-template", id: templateId }),
      })

      const data = (await response.json()) as SaveTemplateResponse
      if (!response.ok) throw new Error(data.message || "Delete failed.")

      setLastUpdatedAt(data.lastUpdatedAt || new Date().toISOString())
      setSaveState("saved")
    } catch (error) {
      setSaveState("failed")
      setMessage(error instanceof Error ? error.message : "Delete failed.")
    }
  }

  function handleCreateTemplate() {
    const folder = selectedFolder || "Custom"
    const template = createBlankTemplate(folder)
    const nextTemplates = [template, ...templates]

    setTemplates(nextTemplates)
    setSelectedId(template.id)
    setSelectedFolder(folder)
    setExpandedFolders((current) => expandFolderPath(folder, current))
    markDirty(template)
  }

  function handleDeleteTemplate() {
    if (!selectedTemplate) return
    const deletedId = selectedTemplate.id
    const nextTemplates = templates.filter((template) => template.id !== selectedTemplate.id)
    setTemplates(nextTemplates)
    setSelectedId(nextTemplates[0]?.id || "")
    void deleteTemplate(deletedId)
  }

  function moveSelectedToFolder(folderPath: string) {
    if (!selectedTemplate) return
    updateSelectedTemplate({
      folder: folderPath || "Custom",
      tags: getFolderParts(folderPath || "Custom"),
    })
    setSelectedFolder(folderPath)
    setExpandedFolders((current) => expandFolderPath(folderPath, current))
    setFolderPickerOpen(false)
  }

  function selectFolder(folderPath: string) {
    setSearch("")
    setSelectedFolder(folderPath)
    setExpandedFolders((current) => expandFolderPath(folderPath, current))
    const firstTemplate = templates.find((template) => folderContains(template, folderPath))
    setSelectedId(firstTemplate?.id || "")
  }

  function renderFolderNode(node: FolderNode): React.ReactNode {
    const hasChildren = node.children.length > 0
    const active = selectedFolder === node.path && !search

    return (
      <div key={node.path || "root"}>
        <button
          type="button"
          onClick={() => selectFolder(node.path)}
          style={{
            width: "100%",
            minHeight: "30px",
            display: "grid",
            gridTemplateColumns: "18px minmax(0, 1fr) auto",
            alignItems: "center",
            gap: "4px",
            paddingLeft: `${Math.min(node.depth * 13, 65)}px`,
            border: 0,
            borderRadius: "6px",
            background: active ? "var(--fc-row-active-bg)" : "#ffffff",
            color: active ? "var(--fc-row-active-text)" : "var(--fc-text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            onClick={(event) => {
              event.stopPropagation()
              if (!hasChildren) return
              setExpandedFolders((current) => ({ ...current, [node.path]: !current[node.path] }))
            }}
            style={{ textAlign: "center", fontSize: "12px" }}
          >
            {hasChildren ? (expandedFolders[node.path] ? "v" : ">") : ""}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", fontWeight: 800 }}>
            {node.name}
          </span>
          <span
            style={{
              minWidth: "24px",
              borderRadius: "999px",
              padding: "2px 6px",
              background: active ? "var(--fc-row-bg)" : "var(--fc-count-bg)",
              color: active ? "var(--fc-row-active-text)" : "var(--fc-count-text)",
              fontSize: "11px",
              fontWeight: 800,
              textAlign: "center",
            }}
          >
            {node.totalCount}
          </span>
        </button>
        {hasChildren && expandedFolders[node.path] ? node.children.map(renderFolderNode) : null}
      </div>
    )
  }

  function renderFolderPickerNode(node: FolderNode): React.ReactNode {
    const hasChildren = node.children.length > 0
    const active = selectedTemplate?.folder === node.path

    return (
      <div key={`picker-${node.path || "root"}`}>
        <button
          type="button"
          onClick={() => moveSelectedToFolder(node.path)}
          style={{
            width: "100%",
            minHeight: "30px",
            display: "grid",
            gridTemplateColumns: "18px minmax(0, 1fr) auto",
            alignItems: "center",
            gap: "4px",
            paddingLeft: `${Math.min(node.depth * 13, 65)}px`,
            border: 0,
            borderRadius: "6px",
            background: active ? "var(--fc-row-active-bg)" : "#ffffff",
            color: active ? "var(--fc-row-active-text)" : "var(--fc-text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span
            onClick={(event) => {
              event.stopPropagation()
              if (!hasChildren) return
              setExpandedFolders((current) => ({ ...current, [node.path]: !current[node.path] }))
            }}
            style={{ textAlign: "center", fontSize: "12px" }}
          >
            {hasChildren ? (expandedFolders[node.path] ? "v" : ">") : ""}
          </span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "12px", fontWeight: 800 }}>
            {node.name}
          </span>
          <span style={{ color: "var(--fc-muted)", fontSize: "11px", fontWeight: 800 }}>{node.totalCount}</span>
        </button>
        {hasChildren && expandedFolders[node.path] ? node.children.map(renderFolderPickerNode) : null}
      </div>
    )
  }

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <div style={{ ...panelStyle, padding: "22px", maxWidth: "520px", margin: "0 auto" }}>
          <h1 style={{ marginTop: 0 }}>Email Templates</h1>
          <p>Please log in from the admin homepage first.</p>
          <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
            Back to Admin
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <header
        style={{
          maxWidth: "1560px",
          margin: "0 auto 12px",
          display: "flex",
          alignItems: "end",
          justifyContent: "space-between",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <div>
          <div style={{ color: "var(--fc-accent)", fontSize: "12px", fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>
            Contact Tools
          </div>
          <h1 style={{ margin: "4px 0 0", color: "var(--fc-text)", fontSize: "28px", letterSpacing: 0 }}>EMAIL TEMPLATES</h1>
        </div>
        <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
          Back To Admin
        </button>
      </header>
      <div
        style={{
          maxWidth: "1560px",
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: isMobile ? "1fr" : "280px 320px minmax(0, 1fr)",
          gap: "10px",
          alignItems: "start",
        }}
      >
        <section style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <div style={sectionTitleStyle}>Folders</div>
            <span style={{ color: "var(--fc-muted)", fontSize: "11px" }}>{folderCount} folders</span>
          </div>
          <div style={{ padding: "8px", display: "grid", gap: "8px" }}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search templates"
              style={inputStyle}
            />
            <button type="button" onClick={handleCreateTemplate} style={primaryButtonStyle}>
              New in selected folder
            </button>
          </div>
          <div style={{ maxHeight: isMobile ? "320px" : "calc(100vh - 170px)", overflow: "auto", padding: "6px" }}>
            {renderFolderNode(folderTree.root)}
          </div>
        </section>

        <section style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <div style={sectionTitleStyle}>{search ? "Search Results" : selectedFolder || "All Templates"}</div>
            <span style={{ color: "var(--fc-muted)", fontSize: "11px" }}>{visibleTemplates.length}</span>
          </div>
          <div style={{ maxHeight: isMobile ? "360px" : "calc(100vh - 88px)", overflow: "auto", padding: "6px" }}>
            {visibleTemplates.map((template) => {
              const active = template.id === selectedId
              return (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => setSelectedId(template.id)}
                  style={{
                    width: "100%",
                    display: "block",
                    marginBottom: "6px",
                    padding: "10px",
                    border: active ? "1px solid var(--fc-accent)" : "1px solid var(--fc-row-border)",
                    borderRadius: "7px",
                    background: active ? "var(--fc-row-active-bg)" : "var(--fc-row-bg)",
                    color: active ? "var(--fc-row-active-text)" : "var(--fc-row-text)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ display: "block", fontSize: "13px", fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {template.title || "Untitled template"}
                  </span>
                </button>
              )
            })}
          </div>
        </section>

        <main style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <div style={sectionTitleStyle}>Template Editor</div>
            <div style={{ display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ color: saveState === "failed" ? "var(--fc-error)" : "var(--fc-muted)", fontSize: "11px", fontWeight: 800 }}>
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                    ? "Saved"
                    : saveState === "dirty"
                      ? "Unsaved changes"
                      : saveState === "failed"
                        ? "Save failed"
                        : lastUpdatedAt
                          ? "Saved"
                          : "Saved"}
              </span>
              <button
                type="button"
                onClick={handleManualSave}
                style={primaryButtonStyle}
                disabled={!selectedTemplate || saveState === "saving"}
              >
                {saveState === "saving" ? "Saving" : saveState === "dirty" ? "Save Now" : saveState === "failed" ? "Retry Save" : "Saved"}
              </button>
              <button type="button" onClick={handleDeleteTemplate} style={dangerButtonStyle} disabled={!selectedTemplate}>
                Delete
              </button>
            </div>
          </div>

          {selectedTemplate ? (
            <div style={{ display: "grid", gap: "12px", padding: "12px" }}>
              {message ? <div style={{ color: "var(--fc-error)", fontSize: "13px" }}>{message}</div> : null}

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px" }}>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Title</div>
                  <input
                    value={selectedTemplate.title}
                    onChange={(event) => updateSelectedTemplate({ title: event.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Subject</div>
                  <input
                    value={selectedTemplate.subject}
                    onChange={(event) => updateSelectedTemplate({ subject: event.target.value })}
                    style={inputStyle}
                  />
                </label>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: isMobile ? "1fr" : "repeat(3, minmax(0, 1fr))",
                  gap: "10px",
                }}
              >
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>To</div>
                  <input value={selectedTemplate.to} onChange={(event) => updateSelectedTemplate({ to: event.target.value })} style={inputStyle} />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Cc</div>
                  <input value={selectedTemplate.cc} onChange={(event) => updateSelectedTemplate({ cc: event.target.value })} style={inputStyle} />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Bcc</div>
                  <input value={selectedTemplate.bcc} onChange={(event) => updateSelectedTemplate({ bcc: event.target.value })} style={inputStyle} />
                </label>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "10px",
                  alignItems: "center",
                  padding: "9px 10px",
                  border: "1px solid var(--fc-border-soft)",
                  borderRadius: "7px",
                  background: "var(--fc-panel-soft)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--fc-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Folder</div>
                  <div style={{ marginTop: "3px", color: "var(--fc-text)", fontSize: "13px", fontWeight: 800, overflowWrap: "anywhere" }}>
                    {selectedTemplate.folder || "Unfiled"}
                  </div>
                </div>
                <button type="button" onClick={() => setFolderPickerOpen(true)} style={buttonStyle}>
                  Change folder
                </button>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                <select onChange={(event) => runEditorCommand("fontName", event.target.value)} defaultValue="" style={buttonStyle}>
                  <option value="" disabled>Font</option>
                  <option value="Roboto">Roboto</option>
                  <option value="Calibri">Calibri</option>
                  <option value="Times New Roman">Times</option>
                  <option value="Courier New">Courier</option>
                </select>
                <select onChange={(event) => runEditorCommand("fontSize", event.target.value)} defaultValue="" style={buttonStyle}>
                  <option value="" disabled>Size</option>
                  <option value="2">Small</option>
                  <option value="3">Normal</option>
                  <option value="4">Large</option>
                  <option value="5">Extra Large</option>
                </select>
                <button type="button" onClick={() => runEditorCommand("bold")} style={buttonStyle}>B</button>
                <button type="button" onClick={() => runEditorCommand("italic")} style={buttonStyle}>I</button>
                <button type="button" onClick={() => runEditorCommand("underline")} style={buttonStyle}>U</button>
                <button type="button" onClick={() => runEditorCommand("strikeThrough")} style={buttonStyle}>S</button>
              </div>

              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={handleEditorInput}
                onBlur={handleEditorInput}
                onPaste={() => window.setTimeout(handleEditorInput, 0)}
                onDrop={() => window.setTimeout(handleEditorInput, 0)}
                style={{
                  minHeight: "420px",
                  maxHeight: isMobile ? "none" : "calc(100vh - 360px)",
                  overflow: "auto",
                  padding: "16px",
                  border: "1px solid var(--fc-input-border)",
                  borderRadius: "8px",
                  background: "var(--fc-editor-bg)",
                  color: "var(--fc-editor-text)",
                  fontSize: "14px",
                  lineHeight: 1.55,
                  outline: "none",
                }}
              />
            </div>
          ) : (
            <div style={{ padding: "24px", color: "var(--fc-muted)" }}>Select or create a template.</div>
          )}
        </main>
      </div>
      {folderPickerOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 40,
            display: "grid",
            placeItems: "center",
            padding: "18px",
            background: "#1d1d1f",
          }}
        >
          <div style={{ ...panelStyle, width: "min(560px, 100%)", maxHeight: "82vh", display: "grid" }}>
            <div style={sectionHeaderStyle}>
              <div style={sectionTitleStyle}>Select Folder</div>
              <button type="button" onClick={() => setFolderPickerOpen(false)} style={buttonStyle}>Close</button>
            </div>
            <div style={{ padding: "8px", overflow: "auto" }}>{renderFolderPickerNode(folderTree.root)}</div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
