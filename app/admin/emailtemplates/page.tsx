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
  background: "#f3f6f8",
  color: "#172534",
  fontFamily: "Arial, Helvetica, sans-serif",
  padding: "14px",
}

const buttonStyle: React.CSSProperties = {
  minHeight: "34px",
  border: "1px solid #b9c9d6",
  borderRadius: "7px",
  background: "#ffffff",
  color: "#203246",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: 800,
  padding: "7px 10px",
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "#0e629f",
  background: "#0f6fac",
  color: "#ffffff",
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  borderColor: "#d5a4a4",
  color: "#8a2424",
}

const panelStyle: React.CSSProperties = {
  border: "1px solid #d7e2ea",
  borderRadius: "8px",
  background: "#ffffff",
  overflow: "hidden",
}

const sectionHeaderStyle: React.CSSProperties = {
  minHeight: "38px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  padding: "9px 10px",
  borderBottom: "1px solid #e4ebf1",
  background: "#fbfcfd",
}

const sectionTitleStyle: React.CSSProperties = {
  minWidth: 0,
  color: "#435565",
  fontSize: "12px",
  fontWeight: 900,
  textTransform: "uppercase",
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  minHeight: "34px",
  border: "1px solid #c4d0da",
  borderRadius: "7px",
  background: "#ffffff",
  color: "#172534",
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
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [selectedFolder, setSelectedFolder] = useState("")
  const [selectedId, setSelectedId] = useState("")
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>({ "": true })
  const [search, setSearch] = useState("")
  const [message, setMessage] = useState("")
  const [saveState, setSaveState] = useState<SaveState>("idle")
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null)

  useEffect(() => {
    document.title = "Email Templates - FC Uno"
  }, [])

  const folderTree = useMemo(() => buildFolderTree(templates), [templates])
  const folderCount = Math.max(Object.keys(folderTree.index).length - 1, 0)

  const visibleTemplates = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return templates.filter((template) => {
      if (keyword) {
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
      }

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
        setSaveState("idle")
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

  function expandFolderPath(folderPath: string, current: Record<string, boolean> = {}) {
    const next: Record<string, boolean> = { ...current, "": true }
    let cursor = ""
    getFolderParts(folderPath).forEach((part) => {
      cursor = cursor ? `${cursor} / ${part}` : part
      next[cursor] = true
    })
    return next
  }

  function markDirty() {
    setSaveState("dirty")
  }

  function updateSelectedTemplate(partial: Partial<EmailTemplate>) {
    if (!selectedTemplate) return
    const updatedAt = new Date().toISOString()
    setTemplates((current) =>
      current.map((template) =>
        template.id === selectedTemplate.id
          ? {
              ...template,
              ...partial,
              updatedAt,
            }
          : template
      )
    )
    setLastUpdatedAt(updatedAt)
    markDirty()
  }

  function handleEditorInput() {
    if (!editorRef.current || !selectedTemplate) return
    const bodyHtml = editorRef.current.innerHTML
    updateSelectedTemplate({
      bodyHtml,
      bodyText: htmlToText(bodyHtml),
    })
  }

  function runEditorCommand(command: string, value?: string) {
    editorRef.current?.focus()
    document.execCommand(command, false, value)
    handleEditorInput()
  }

  function createLink() {
    const url = window.prompt("Paste link URL")
    if (!url) return
    runEditorCommand("createLink", url)
  }

  async function saveTemplates(nextTemplates = templates) {
    setSaveState("saving")
    setMessage("")

    try {
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save", templates: nextTemplates }),
      })

      if (!response.ok) throw new Error("Save failed.")

      const data = (await response.json()) as TemplateLibraryResponse
      setLastUpdatedAt(data.lastUpdatedAt || new Date().toISOString())
      setSaveState("saved")
    } catch (error) {
      setSaveState("failed")
      setMessage(error instanceof Error ? error.message : "Save failed.")
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
    setSaveState("dirty")
  }

  function handleDeleteTemplate() {
    if (!selectedTemplate) return
    const nextTemplates = templates.filter((template) => template.id !== selectedTemplate.id)
    setTemplates(nextTemplates)
    setSelectedId(nextTemplates[0]?.id || "")
    setSaveState("dirty")
  }

  function moveSelectedToCurrentFolder() {
    if (!selectedTemplate || !selectedFolder) return
    updateSelectedTemplate({
      folder: selectedFolder,
      tags: getFolderParts(selectedFolder),
    })
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
            background: active ? "#dff0fb" : "transparent",
            color: active ? "#0c4774" : "#203246",
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
              background: active ? "#ffffff" : "#eef3f7",
              color: active ? "#0c4774" : "#586a7b",
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

  if (loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <div style={{ ...panelStyle, padding: "22px", maxWidth: "520px", margin: "0 auto" }}>
          <h1 style={{ marginTop: 0 }}>Email Templates</h1>
          <p>Please log in from the admin homepage first.</p>
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
          gridTemplateColumns: isMobile ? "1fr" : "280px 320px minmax(0, 1fr)",
          gap: "10px",
          alignItems: "start",
        }}
      >
        <section style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <div style={sectionTitleStyle}>Folders</div>
            <span style={{ color: "#687a88", fontSize: "11px" }}>{folderCount} folders</span>
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
            <span style={{ color: "#687a88", fontSize: "11px" }}>{visibleTemplates.length}</span>
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
                    display: "grid",
                    gap: "4px",
                    marginBottom: "6px",
                    padding: "10px",
                    border: active ? "1px solid #2c86c6" : "1px solid #e2e9ef",
                    borderRadius: "7px",
                    background: active ? "#eef7ff" : "#ffffff",
                    color: "#1b2d40",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ fontSize: "13px", fontWeight: 900, overflowWrap: "anywhere" }}>
                    {template.title || "Untitled template"}
                  </span>
                  <span style={{ fontSize: "12px", color: "#526679", overflowWrap: "anywhere" }}>
                    {template.subject || "No subject"}
                  </span>
                  <span style={{ fontSize: "11px", color: "#7c8b98", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {template.folder || "Unfiled"}
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
              <span style={{ color: saveState === "failed" ? "#a12a2a" : "#687a88", fontSize: "11px", fontWeight: 800 }}>
                {saveState === "saving"
                  ? "Saving..."
                  : saveState === "saved"
                    ? "Saved"
                    : saveState === "dirty"
                      ? "Unsaved"
                      : saveState === "failed"
                        ? "Save failed"
                        : lastUpdatedAt
                          ? `Saved ${new Date(lastUpdatedAt).toLocaleTimeString()}`
                          : ""}
              </span>
              <button type="button" onClick={() => saveTemplates()} style={primaryButtonStyle} disabled={!selectedTemplate || saveState === "saving"}>
                Save template
              </button>
              <button type="button" onClick={handleDeleteTemplate} style={dangerButtonStyle} disabled={!selectedTemplate}>
                Delete
              </button>
            </div>
          </div>

          {selectedTemplate ? (
            <div style={{ display: "grid", gap: "12px", padding: "12px" }}>
              {message ? <div style={{ color: "#a12a2a", fontSize: "13px" }}>{message}</div> : null}

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px" }}>
                <label>
                  <div style={{ fontSize: "12px", color: "#526679", marginBottom: "5px", fontWeight: 800 }}>Title</div>
                  <input
                    value={selectedTemplate.title}
                    onChange={(event) => updateSelectedTemplate({ title: event.target.value })}
                    style={inputStyle}
                  />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "#526679", marginBottom: "5px", fontWeight: 800 }}>Subject</div>
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
                  <div style={{ fontSize: "12px", color: "#526679", marginBottom: "5px", fontWeight: 800 }}>To</div>
                  <input value={selectedTemplate.to} onChange={(event) => updateSelectedTemplate({ to: event.target.value })} style={inputStyle} />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "#526679", marginBottom: "5px", fontWeight: 800 }}>Cc</div>
                  <input value={selectedTemplate.cc} onChange={(event) => updateSelectedTemplate({ cc: event.target.value })} style={inputStyle} />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "#526679", marginBottom: "5px", fontWeight: 800 }}>Bcc</div>
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
                  border: "1px solid #dce6ee",
                  borderRadius: "7px",
                  background: "#fbfcfd",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "#526679", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Folder</div>
                  <div style={{ marginTop: "3px", color: "#172534", fontSize: "13px", fontWeight: 800, overflowWrap: "anywhere" }}>
                    {selectedTemplate.folder || "Unfiled"}
                  </div>
                </div>
                <button type="button" onClick={moveSelectedToCurrentFolder} style={buttonStyle} disabled={!selectedFolder}>
                  Move to selected folder
                </button>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                <button type="button" onClick={() => runEditorCommand("bold")} style={buttonStyle}>B</button>
                <button type="button" onClick={() => runEditorCommand("italic")} style={buttonStyle}>I</button>
                <button type="button" onClick={() => runEditorCommand("underline")} style={buttonStyle}>U</button>
                <button type="button" onClick={() => runEditorCommand("insertUnorderedList")} style={buttonStyle}>Bullets</button>
                <button type="button" onClick={() => runEditorCommand("insertOrderedList")} style={buttonStyle}>Numbered</button>
                <button type="button" onClick={() => runEditorCommand("formatBlock", "blockquote")} style={buttonStyle}>Quote</button>
                <button type="button" onClick={createLink} style={buttonStyle}>Link</button>
                <button type="button" onClick={() => runEditorCommand("removeFormat")} style={buttonStyle}>Clear</button>
              </div>

              <div
                ref={editorRef}
                contentEditable
                suppressContentEditableWarning
                onInput={handleEditorInput}
                style={{
                  minHeight: "420px",
                  maxHeight: isMobile ? "none" : "calc(100vh - 360px)",
                  overflow: "auto",
                  padding: "16px",
                  border: "1px solid #cbd8e2",
                  borderRadius: "8px",
                  background: "#ffffff",
                  color: "#172534",
                  fontSize: "14px",
                  lineHeight: 1.55,
                  outline: "none",
                }}
              />
            </div>
          ) : (
            <div style={{ padding: "24px", color: "#617487" }}>Select or create a template.</div>
          )}
        </main>
      </div>
    </div>
  )
}
