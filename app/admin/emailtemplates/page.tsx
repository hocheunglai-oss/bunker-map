"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"
import {
  clearAdminClientCache,
  fetchAdminClientJson,
  OUTLOOK_TEMPLATES_INDEX_CACHE_KEY,
  OUTLOOK_TEMPLATES_RECIPIENTS_CACHE_KEY,
  readAdminClientCache,
} from "@/lib/adminClientCache"

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
  recipientResolution: Record<string, unknown>
  updatedAt: string
  revision: number
  bodyLoaded?: boolean
  bodyLoading?: boolean
  bodyError?: string
}

type TemplateIndexItem = Pick<
  EmailTemplate,
  | "id"
  | "title"
  | "subject"
  | "folder"
  | "to"
  | "cc"
  | "bcc"
  | "isActive"
  | "updatedAt"
  | "revision"
> & {
  recipientResolution?: Record<string, unknown>
}

type TemplateIndexResponse = {
  templates: TemplateIndexItem[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
  revision: string
}

type RecipientsResponse = {
  contacts: AddressContact[]
  groups: AddressGroup[]
}

type SaveTemplateResponse = {
  id?: string
  template?: EmailTemplate
  templates?: EmailTemplate[]
  lastUpdatedAt?: string | null
  revision?: string
  code?: string
  message?: string
}

type TemplateLibraryResponse = {
  templates: EmailTemplate[]
  lastImportedAt: string | null
  lastUpdatedAt: string | null
  revision: string
}

type FolderNode = {
  name: string
  path: string
  depth: number
  children: FolderNode[]
  templates: EmailTemplate[]
  totalCount: number
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "failed" | "conflict"
type RecipientField = "to" | "cc" | "bcc"
type FolderDialogMode = "create" | "edit"
type RecipientTruthIssueStatus = "missing" | "ambiguous"

type RecipientTruthIssue = {
  field: RecipientField
  position: number
  literal: string
  status: RecipientTruthIssueStatus
}

type RecipientTruthStatus =
  | {
      kind: "unloaded" | "pending"
      issues: []
      total: 0
      resolved: 0
      external: 0
      missing: 0
      ambiguous: 0
      certifiedAt: ""
    }
  | {
      kind: "sendable" | "blocked"
      issues: RecipientTruthIssue[]
      total: number
      resolved: number
      external: number
      missing: number
      ambiguous: number
      certifiedAt: string
    }

class PendingTemplateSaveError extends Error {
  constructor() {
    super("One or more pending Outlook template changes require review.")
    this.name = "PendingTemplateSaveError"
  }
}

type AddressContact = {
  id: string
  display_name: string
  primary_email: string
  nickname: string | null
}

type AddressGroup = {
  id: string
  name: string
  nickname: string | null
  member_count: number
}

type RecipientOption = {
  id: string
  type: "contact" | "group"
  label: string
  detail: string
  value: string
}

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
  borderColor: "var(--fc-admin-button-border)",
  background: "var(--fc-admin-button-bg)",
  color: "var(--fc-admin-button-text)",
}

const manifestButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  textDecoration: "none",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
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

const pendingRecipientTruth: RecipientTruthStatus = {
  kind: "pending",
  issues: [],
  total: 0,
  resolved: 0,
  external: 0,
  missing: 0,
  ambiguous: 0,
  certifiedAt: "",
}

const unloadedRecipientTruth: RecipientTruthStatus = {
  ...pendingRecipientTruth,
  kind: "unloaded",
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

function expandFolderPathValue(
  folderPath: string,
  current: Record<string, boolean> = {},
) {
  const next: Record<string, boolean> = { ...current, "": true }
  let cursor = ""
  getFolderParts(folderPath).forEach((part) => {
    cursor = cursor ? `${cursor} / ${part}` : part
    next[cursor] = true
  })
  return next
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

function buildFolderTreeFromPaths(templates: EmailTemplate[], folderPaths: string[]) {
  const folderTemplates = [
    ...templates,
    ...folderPaths
      .filter((folder) => folder.trim())
      .map((folder) => ({ folder } as EmailTemplate)),
  ]

  return buildFolderTree(folderTemplates)
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

function formatContactRecipient(contact: AddressContact) {
  const name = (contact.display_name || contact.nickname || contact.primary_email || "").trim()
  const email = (contact.primary_email || "").trim()
  return name && name !== email ? `${name} <${email}>` : email
}

function formatGroupRecipient(group: AddressGroup) {
  const name = (group.name || group.nickname || "").trim()
  return name ? `${name} <${name}>` : ""
}

function splitRecipientText(value: string) {
  const text = String(value || "").replace(/\r?\n/g, " ")
  const parts: string[] = []
  let current = ""
  let inQuote = false
  let angleDepth = 0

  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (char === "\"" && text.charAt(index - 1) !== "\\") inQuote = !inQuote
    if (!inQuote && char === "<") angleDepth += 1
    if (!inQuote && char === ">" && angleDepth > 0) angleDepth -= 1
    if (!inQuote && angleDepth === 0 && (char === "," || char === ";")) {
      if (current.trim()) parts.push(current.trim())
      current = ""
      continue
    }
    current += char
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

function joinRecipients(values: string[]) {
  const seen = new Set<string>()
  const cleaned = values
    .map((value) => value.trim())
    .filter(Boolean)
    .filter((value) => {
      const key = value.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  return cleaned.join(", ")
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function readRecipientTruthCount(value: unknown) {
  const count = Number(value)
  return Number.isSafeInteger(count) && count >= 0 ? count : null
}

function getRecipientTruthStatus(value: unknown): RecipientTruthStatus {
  if (!isPlainRecord(value) || !isPlainRecord(value.refs) || !isPlainRecord(value.counts)) {
    return pendingRecipientTruth
  }

  const sourceFingerprint =
    typeof value.sourceFingerprint === "string"
      ? value.sourceFingerprint.trim().toLowerCase()
      : ""
  const certificationRunId =
    typeof value.certificationRunId === "string"
      ? value.certificationRunId.trim()
      : ""
  const certifiedAt = typeof value.certifiedAt === "string" ? value.certifiedAt : ""
  const resolvedAt = typeof value.resolvedAt === "string" ? value.resolvedAt : ""
  if (
    value.schema !== "fcuno.outlook-template-recipient-resolution/v1" ||
    (
      Object.prototype.hasOwnProperty.call(value, "reconciliationRequired") &&
      value.reconciliationRequired !== false
    ) ||
    !certificationRunId ||
    !/^[0-9a-f]{64}$/.test(sourceFingerprint) ||
    !Number.isFinite(Date.parse(certifiedAt)) ||
    !Number.isFinite(Date.parse(resolvedAt))
  ) {
    return pendingRecipientTruth
  }

  const total = readRecipientTruthCount(value.counts.total)
  const resolved = readRecipientTruthCount(value.counts.resolved)
  const external = readRecipientTruthCount(value.counts.external)
  const ambiguous = readRecipientTruthCount(value.counts.ambiguous)
  const missing = readRecipientTruthCount(value.counts.missing)
  if (
    total === null ||
    resolved === null ||
    external === null ||
    ambiguous === null ||
    missing === null
  ) {
    return pendingRecipientTruth
  }

  const observed = {
    resolved: 0,
    external: 0,
    ambiguous: 0,
    missing: 0,
  }
  const issues: RecipientTruthIssue[] = []
  let refCount = 0

  for (const field of ["to", "cc", "bcc"] as const) {
    const refsValue: unknown = value.refs[field]
    if (!Array.isArray(refsValue)) return pendingRecipientTruth
    const refs: unknown[] = refsValue

    for (let index = 0; index < refs.length; index += 1) {
      const ref: unknown = refs[index]
      if (!isPlainRecord(ref) || typeof ref.literal !== "string" || !ref.literal.trim()) {
        return pendingRecipientTruth
      }
      const status = ref.status
      if (
        status !== "resolved" &&
        status !== "external" &&
        status !== "ambiguous" &&
        status !== "missing"
      ) {
        return pendingRecipientTruth
      }

      observed[status] += 1
      refCount += 1
      if (status === "ambiguous" || status === "missing") {
        const storedPosition = Number(ref.position)
        issues.push({
          field,
          position:
            Number.isSafeInteger(storedPosition) && storedPosition >= 0
              ? storedPosition
              : index,
          literal: ref.literal,
          status,
        })
      }
    }
  }

  if (
    total !== refCount ||
    total !== resolved + external + ambiguous + missing ||
    observed.resolved !== resolved ||
    observed.external !== external ||
    observed.ambiguous !== ambiguous ||
    observed.missing !== missing
  ) {
    return pendingRecipientTruth
  }

  return {
    kind: issues.length > 0 ? "blocked" : "sendable",
    issues,
    total,
    resolved,
    external,
    ambiguous,
    missing,
    certifiedAt,
  }
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
    placeholders: [],
    recipientResolution: {},
    updatedAt: now,
    revision: 0,
    bodyLoaded: true,
    bodyLoading: false,
  }
}

function templateFromIndexItem(template: TemplateIndexItem): EmailTemplate {
  return {
    id: template.id,
    title: template.title || "",
    subject: template.subject || "",
    folder: template.folder || "Unfiled",
    sourcePath: "",
    from: "",
    to: template.to || "",
    cc: template.cc || "",
    bcc: template.bcc || "",
    bodyHtml: "",
    bodyText: "",
    tags: getFolderParts(template.folder || "Unfiled"),
    slug: template.id,
    isActive: template.isActive !== false,
    placeholders: [],
    recipientResolution: isPlainRecord(template.recipientResolution)
      ? template.recipientResolution
      : {},
    updatedAt: template.updatedAt || new Date().toISOString(),
    revision: Math.max(Number(template.revision || 0), 0),
    bodyLoaded: false,
    bodyLoading: false,
  }
}

function templateFromDetail(template: EmailTemplate): EmailTemplate {
  return {
    ...template,
    tags: Array.isArray(template.tags) ? template.tags : getFolderParts(template.folder || "Unfiled"),
    placeholders: Array.isArray(template.placeholders) ? template.placeholders : [],
    recipientResolution:
      template.recipientResolution &&
      typeof template.recipientResolution === "object" &&
      !Array.isArray(template.recipientResolution)
        ? template.recipientResolution
        : {},
    revision: Math.max(Number(template.revision || 0), 0),
    bodyLoaded: true,
    bodyLoading: false,
    bodyError: undefined,
  }
}

export default function EmailTemplatesAdminPage() {
  const isMobile = useIsMobile()
  const { loading, authenticated } = useSimpleAdminAuth()
  const [initialLibrary] = useState(() =>
    readAdminClientCache<TemplateIndexResponse>(OUTLOOK_TEMPLATES_INDEX_CACHE_KEY),
  )
  const initialTemplates = (initialLibrary?.templates || []).map(templateFromIndexItem)
  const initialTree = buildFolderTree(initialTemplates)
  const initialFolder = initialTree.index["Outgoing / Bunker"]
    ? "Outgoing / Bunker"
    : Object.keys(initialTree.index).find((folder) => folder) || ""
  const editorRef = useRef<HTMLDivElement | null>(null)
  const autosaveTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const dirtyVersionsRef = useRef<Map<string, number>>(new Map())
  const pendingTemplatesRef = useRef<Map<string, EmailTemplate>>(new Map())
  const failedSavesRef = useRef<Set<string>>(new Set())
  const queuedSavePromisesRef = useRef<Map<string, Promise<void>>>(new Map())
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const detailPromisesRef = useRef<Map<string, Promise<EmailTemplate>>>(new Map())
  const templatesRef = useRef<EmailTemplate[]>(initialTemplates)
  const libraryBusyRef = useRef(false)
  const [templates, setTemplates] = useState<EmailTemplate[]>(initialTemplates)
  const [selectedFolder, setSelectedFolder] = useState(initialFolder)
  const [selectedId, setSelectedId] = useState(
    initialTemplates.find((template) => folderContains(template, initialFolder))?.id ||
      initialTemplates[0]?.id ||
      "",
  )
  const [expandedFolders, setExpandedFolders] = useState<Record<string, boolean>>(() =>
    expandFolderPathValue(initialFolder, { "": true }),
  )
  const [folderPickerOpen, setFolderPickerOpen] = useState(false)
  const [customFolders, setCustomFolders] = useState<string[]>([])
  const [folderDialogOpen, setFolderDialogOpen] = useState(false)
  const [folderDialogMode, setFolderDialogMode] = useState<FolderDialogMode>("create")
  const [folderDialogTarget, setFolderDialogTarget] = useState("")
  const [folderNameDraft, setFolderNameDraft] = useState("")
  const [draggedTemplateId, setDraggedTemplateId] = useState("")
  const [dropTargetFolder, setDropTargetFolder] = useState("")
  const [contacts, setContacts] = useState<AddressContact[]>([])
  const [groups, setGroups] = useState<AddressGroup[]>([])
  const [recipientsLoading, setRecipientsLoading] = useState(false)
  const [recipientsLoaded, setRecipientsLoaded] = useState(false)
  const [recipientPickerField, setRecipientPickerField] = useState<RecipientField | null>(null)
  const [recipientSearch, setRecipientSearch] = useState("")
  const [search, setSearch] = useState("")
  const [message, setMessage] = useState("")
  const [conflictAlert, setConflictAlert] = useState<{
    templateId: string
    message: string
  } | null>(null)
  const [saveStates, setSaveStates] = useState<Record<string, SaveState>>({})
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [, setLastUpdatedAt] = useState<string | null>(
    initialLibrary?.lastUpdatedAt || null,
  )

  useEffect(() => {
    document.title = "Outlook Templates - FC Uno"
  }, [])

  useEffect(() => {
    templatesRef.current = templates
  }, [templates])

  useEffect(() => {
    const timers = autosaveTimersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  useEffect(() => {
    function warnBeforeLeaving(event: BeforeUnloadEvent) {
      if (pendingTemplatesRef.current.size === 0) return
      event.preventDefault()
      event.returnValue = ""
    }

    window.addEventListener("beforeunload", warnBeforeLeaving)
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving)
  }, [])

  const folderTree = useMemo(() => buildFolderTreeFromPaths(templates, customFolders), [customFolders, templates])

  const visibleTemplates = useMemo(() => {
    return templates.filter((template) => {
      if (search.trim()) return matchesLooseSearch(template, search)

      return folderContains(template, selectedFolder)
    })
  }, [search, selectedFolder, templates])

  const selectedTemplate = templates.find((template) => template.id === selectedId) || null
  const recipientTruthByTemplateId = useMemo(
    () =>
      new Map(
        templates.map((template) => [
          template.id,
          template.bodyLoaded
            ? getRecipientTruthStatus(template.recipientResolution)
            : unloadedRecipientTruth,
        ]),
      ),
    [templates],
  )
  const selectedRecipientTruth = selectedTemplate
    ? recipientTruthByTemplateId.get(selectedTemplate.id) ||
      unloadedRecipientTruth
    : unloadedRecipientTruth
  const selectedTemplateBodyLoaded = selectedTemplate?.bodyLoaded
  const selectedTemplateBodyHtml = selectedTemplate?.bodyHtml
  const saveState = libraryBusy
    ? "saving"
    : selectedId
      ? saveStates[selectedId] || (initialLibrary ? "saved" : "idle")
      : "idle"
  const displayedMessage = conflictAlert?.message || message

  const recipientOptions = useMemo<RecipientOption[]>(() => {
    const contactOptions = contacts
      .filter((contact) => contact.primary_email)
      .map((contact) => ({
        id: `contact-${contact.id}`,
        type: "contact" as const,
        label: contact.display_name || contact.nickname || contact.primary_email,
        detail: contact.primary_email,
        value: formatContactRecipient(contact),
      }))
    const groupOptions = groups
      .filter((group) => group.name && group.member_count > 0)
      .map((group) => ({
        id: `group-${group.id}`,
        type: "group" as const,
        label: group.name || group.nickname || "",
        detail: `${group.member_count || 0} members`,
        value: formatGroupRecipient(group),
      }))

    const tokens = normaliseSearchText(recipientSearch).split(" ").filter(Boolean)
    return [...groupOptions, ...contactOptions]
      .filter((option) => {
        if (tokens.length === 0) return true
        const haystack = normaliseSearchText([option.label, option.detail, option.value, option.type].join(" "))
        return tokens.every((token) => haystack.includes(token))
      })
      .slice(0, 250)
  }, [contacts, groups, recipientSearch])

  useEffect(() => {
    if (!authenticated) return

    async function loadTemplates() {
      try {
        const data = await fetchAdminClientJson<TemplateIndexResponse>(
          OUTLOOK_TEMPLATES_INDEX_CACHE_KEY,
          "/api/admin/email-templates?mode=index",
        )
        const serverTemplates = (data.templates || []).map(templateFromIndexItem)
        const pendingTemplates = pendingTemplatesRef.current
        const serverIds = new Set(serverTemplates.map((template) => template.id))
        const loadedTemplates = [
          ...serverTemplates.map(
            (template) => pendingTemplates.get(template.id) || template
          ),
          ...Array.from(pendingTemplates.values()).filter(
            (template) => !serverIds.has(template.id)
          ),
        ]
        const built = buildFolderTree(loadedTemplates)
        const preferredFolder = built.index["Outgoing / Bunker"]
          ? "Outgoing / Bunker"
          : Object.keys(built.index).find((folder) => folder) || ""

        templatesRef.current = loadedTemplates
        setTemplates(loadedTemplates)
        setSelectedFolder((current) => current || preferredFolder)
        setExpandedFolders((current) => expandFolderPath(preferredFolder, current))
        setSelectedId((current) =>
          loadedTemplates.some((template) => template.id === current)
            ? current
            : loadedTemplates.find((template) => folderContains(template, preferredFolder))?.id ||
                loadedTemplates[0]?.id ||
                ""
        )
        setLastUpdatedAt(data.lastUpdatedAt)
        setSaveStates((current) => ({
          ...Object.fromEntries(
            loadedTemplates.map((template) => [template.id, "saved" as const])
          ),
          ...current,
        }))
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to load templates.")
      }
    }

    loadTemplates()
  }, [authenticated])

  useEffect(() => {
    if (!authenticated || !selectedId) return
    const template = templates.find((item) => item.id === selectedId)
    if (!template || template.bodyLoaded || template.bodyLoading) return
    void loadTemplateDetail(selectedId).catch((error) => {
      setMessage(error instanceof Error ? error.message : "Failed to load template.")
    })
  }, [authenticated, selectedId, templates])

  useEffect(() => {
    if (!editorRef.current || !selectedId) return
    const nextEditorHtml = selectedTemplateBodyLoaded
      ? selectedTemplateBodyHtml || "<p></p>"
      : ""
    if (editorRef.current.innerHTML === nextEditorHtml) return
    editorRef.current.innerHTML = nextEditorHtml
  }, [selectedId, selectedTemplateBodyHtml, selectedTemplateBodyLoaded])

  function expandFolderPath(folderPath: string, current: Record<string, boolean> = {}) {
    return expandFolderPathValue(folderPath, current)
  }

  function setTemplateSaveState(templateId: string, state: SaveState) {
    setSaveStates((current) => ({ ...current, [templateId]: state }))
  }

  function setLibraryOperationBusy(busy: boolean) {
    libraryBusyRef.current = busy
    setLibraryBusy(busy)
  }

  function clearAutosaveTimer(templateId: string) {
    const timer = autosaveTimersRef.current.get(templateId)
    if (timer) clearTimeout(timer)
    autosaveTimersRef.current.delete(templateId)
  }

  function scheduleTemplateSave(templateId: string, delay = 850) {
    clearAutosaveTimer(templateId)
    const timer = setTimeout(() => {
      autosaveTimersRef.current.delete(templateId)
      void queueTemplateSave(templateId)
    }, delay)
    autosaveTimersRef.current.set(templateId, timer)
  }

  function markDirty(template: EmailTemplate) {
    clearAdminClientCache(OUTLOOK_TEMPLATES_INDEX_CACHE_KEY)
    const nextVersion = (dirtyVersionsRef.current.get(template.id) || 0) + 1
    dirtyVersionsRef.current.set(template.id, nextVersion)
    pendingTemplatesRef.current.set(template.id, template)
    failedSavesRef.current.delete(template.id)
    setConflictAlert((current) =>
      current?.templateId === template.id ? null : current
    )
    setTemplateSaveState(template.id, "dirty")
    scheduleTemplateSave(template.id)
  }

  async function loadTemplateDetail(templateId: string, force = false) {
    if (!templateId) throw new Error("Missing template id.")

    const currentTemplate = templatesRef.current.find((template) => template.id === templateId)
    if (!force && currentTemplate?.bodyLoaded) return currentTemplate

    const existingPromise = detailPromisesRef.current.get(templateId)
    if (existingPromise) return existingPromise

    setTemplates((current) => {
      const next = current.map((template) =>
        template.id === templateId
          ? { ...template, bodyLoading: true, bodyError: undefined }
          : template
      )
      templatesRef.current = next
      return next
    })

    const promise = fetch(`/api/admin/email-templates?id=${encodeURIComponent(templateId)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const data = (await response.json()) as SaveTemplateResponse
        if (!response.ok || !data.template) {
          throw new Error(data.message || "Failed to load template.")
        }
        const loadedTemplate = templateFromDetail(data.template)
        setTemplates((current) => {
          const next = current.map((template) =>
            template.id !== templateId
              ? template
              : loadedTemplate
          )
          templatesRef.current = next
          return next
        })
        return loadedTemplate
      })
      .catch((error) => {
        setTemplates((current) => {
          const next = current.map((template) =>
            template.id === templateId
              ? {
                  ...template,
                  bodyLoading: false,
                  bodyError: error instanceof Error ? error.message : "Failed to load template.",
                }
              : template
          )
          templatesRef.current = next
          return next
        })
        throw error
      })
      .finally(() => {
        detailPromisesRef.current.delete(templateId)
      })

    detailPromisesRef.current.set(templateId, promise)
    return promise
  }

  async function hydrateTemplateForSave(template: EmailTemplate) {
    if (template.bodyLoaded) return template
    const detail = await loadTemplateDetail(template.id)
    return {
      ...detail,
      folder: template.folder,
      tags: template.tags?.length ? template.tags : detail.tags,
      updatedAt: template.updatedAt,
      bodyHtml: detail.bodyHtml,
      bodyText: detail.bodyText,
      sourcePath: detail.sourcePath,
      from: detail.from,
      slug: detail.slug,
      bodyLoaded: true,
      bodyLoading: false,
      bodyError: undefined,
    }
  }

  async function loadRecipients() {
    if (recipientsLoaded || recipientsLoading) return
    setRecipientsLoading(true)
    try {
      const data = await fetchAdminClientJson<RecipientsResponse>(
        OUTLOOK_TEMPLATES_RECIPIENTS_CACHE_KEY,
        "/api/admin/email-templates?mode=recipients",
      )
      setContacts(data.contacts || [])
      setGroups(data.groups || [])
      setRecipientsLoaded(true)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Failed to load contacts and groups.")
    } finally {
      setRecipientsLoading(false)
    }
  }

  function updateSelectedTemplate(partial: Partial<EmailTemplate>) {
    if (libraryBusyRef.current) return
    if (!selectedTemplate) return
    if (!selectedTemplate.bodyLoaded) return
    const currentTemplate =
      pendingTemplatesRef.current.get(selectedTemplate.id) ||
      templatesRef.current.find((template) => template.id === selectedTemplate.id) ||
      selectedTemplate
    const updatedAt = new Date().toISOString()
    const recipientsChanged = (["to", "cc", "bcc"] as const).some(
      (field) =>
        Object.prototype.hasOwnProperty.call(partial, field) &&
        partial[field] !== currentTemplate[field]
    )
    const nextTemplate: EmailTemplate = {
      ...currentTemplate,
      ...partial,
      recipientResolution: recipientsChanged
        ? {}
        : currentTemplate.recipientResolution,
      updatedAt,
    }
    setTemplates((current) => {
      const next = current.map((template) =>
        template.id === selectedTemplate.id ? nextTemplate : template
      )
      templatesRef.current = next
      return next
    })
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

  async function reloadTemplateAfterConflict(templateId: string, conflictMessage: string) {
    clearAutosaveTimer(templateId)
    pendingTemplatesRef.current.delete(templateId)
    dirtyVersionsRef.current.delete(templateId)
    failedSavesRef.current.add(templateId)
    clearAdminClientCache(OUTLOOK_TEMPLATES_INDEX_CACHE_KEY)

    try {
      await loadTemplateDetail(templateId, true)
      setTemplateSaveState(templateId, "conflict")
      setConflictAlert({
        templateId,
        message: `${conflictMessage} Your unsaved changes were not written. The current server version has been reloaded.`,
      })
    } catch (error) {
      if (error instanceof Error && error.message === "Template not found.") {
        const nextTemplates = templatesRef.current.filter(
          (template) => template.id !== templateId
        )
        templatesRef.current = nextTemplates
        setTemplates(nextTemplates)
        setSaveStates((current) => {
          const next = { ...current }
          delete next[templateId]
          return next
        })
        setSelectedId((current) =>
          current === templateId
            ? nextTemplates[0]?.id || ""
            : current
        )
        setConflictAlert({
          templateId,
          message: `${conflictMessage} Your unsaved changes were not written because the server copy was deleted.`,
        })
        return
      }
      setTemplateSaveState(templateId, "failed")
      setConflictAlert({
        templateId,
        message: `${conflictMessage} Your unsaved changes were not written, and the current server version could not be reloaded.`,
      })
    }
  }

  async function savePendingTemplateNow(templateId: string) {
    const pendingTemplate = pendingTemplatesRef.current.get(templateId)
    if (!pendingTemplate) return false

    const version = dirtyVersionsRef.current.get(templateId) || 0
    setTemplateSaveState(templateId, "saving")
    setMessage("")

    try {
      const templateToSave = await hydrateTemplateForSave(pendingTemplate)
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save-template",
          template: templateToSave,
          expectedRevision: templateToSave.revision,
        }),
      })

      const data = (await response.json()) as SaveTemplateResponse
      if (response.status === 409 || data.code === "EMAIL_TEMPLATE_CONFLICT") {
        await reloadTemplateAfterConflict(
          templateId,
          data.message || "This Outlook template changed after you opened it.",
        )
        return false
      }
      if (!response.ok || !data.template) throw new Error(data.message || "Save failed.")

      const savedTemplate = templateFromDetail(data.template)
      const latestVersion = dirtyVersionsRef.current.get(templateId) || 0
      const latestPending = pendingTemplatesRef.current.get(templateId)
      if (latestPending && latestVersion !== version) {
        const recipientsChanged =
          latestPending.to !== savedTemplate.to ||
          latestPending.cc !== savedTemplate.cc ||
          latestPending.bcc !== savedTemplate.bcc
        const rebasedTemplate = {
          ...latestPending,
          recipientResolution: recipientsChanged
            ? {}
            : savedTemplate.recipientResolution,
          revision: savedTemplate.revision,
        }
        pendingTemplatesRef.current.set(templateId, rebasedTemplate)
        setTemplates((current) => {
          const next = current.map((item) =>
            item.id === templateId ? rebasedTemplate : item
          )
          templatesRef.current = next
          return next
        })
        setLastUpdatedAt(data.lastUpdatedAt || savedTemplate.updatedAt)
        setTemplateSaveState(templateId, "dirty")
        return true
      }

      pendingTemplatesRef.current.delete(templateId)
      dirtyVersionsRef.current.delete(templateId)
      failedSavesRef.current.delete(templateId)
      setTemplates((current) => {
        const next = current.map((item) =>
          item.id === savedTemplate.id ? { ...item, ...savedTemplate } : item
        )
        templatesRef.current = next
        return next
      })
      setLastUpdatedAt(data.lastUpdatedAt || savedTemplate.updatedAt || new Date().toISOString())
      setTemplateSaveState(templateId, "saved")
      return false
    } catch (error) {
      failedSavesRef.current.add(templateId)
      setTemplateSaveState(templateId, "failed")
      setMessage(error instanceof Error ? error.message : "Save failed.")
      return false
    }
  }

  function queueTemplateSave(templateId: string) {
    const existing = queuedSavePromisesRef.current.get(templateId)
    if (existing) return existing

    const queued = writeQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const needsResave = await savePendingTemplateNow(templateId)
        if (needsResave) scheduleTemplateSave(templateId, 0)
      })
      .finally(() => {
        queuedSavePromisesRef.current.delete(templateId)
      })

    queuedSavePromisesRef.current.set(templateId, queued)
    writeQueueRef.current = queued.catch(() => undefined)
    return queued
  }

  async function flushPendingSaves() {
    const pendingIds = Array.from(pendingTemplatesRef.current.keys())
    pendingIds.forEach(clearAutosaveTimer)
    await Promise.all(pendingIds.map((templateId) => queueTemplateSave(templateId)))
    await writeQueueRef.current

    const blockedIds = pendingIds.filter(
      (templateId) =>
        pendingTemplatesRef.current.has(templateId) ||
        failedSavesRef.current.has(templateId)
    )
    if (blockedIds.length > 0) {
      throw new PendingTemplateSaveError()
    }
  }

  function handleManualSave() {
    if (!selectedTemplate) return
    clearAutosaveTimer(selectedTemplate.id)
    void queueTemplateSave(selectedTemplate.id)
  }

  async function loadCanonicalLibrary() {
    const response = await fetch("/api/admin/email-templates", { cache: "no-store" })
    const data = (await response.json()) as TemplateLibraryResponse & { message?: string }
    if (!response.ok || !Array.isArray(data.templates) || !data.revision) {
      throw new Error(data.message || "Failed to load the current template library.")
    }
    return {
      ...data,
      templates: data.templates.map(templateFromDetail),
    }
  }

  function replaceTemplatesFromLibrary(library: TemplateLibraryResponse) {
    const loadedTemplates = library.templates.map(templateFromDetail)
    pendingTemplatesRef.current.clear()
    dirtyVersionsRef.current.clear()
    failedSavesRef.current.clear()
    setConflictAlert(null)
    autosaveTimersRef.current.forEach((timer) => clearTimeout(timer))
    autosaveTimersRef.current.clear()
    setTemplates(() => {
      templatesRef.current = loadedTemplates
      return loadedTemplates
    })
    setSaveStates(
      Object.fromEntries(loadedTemplates.map((template) => [template.id, "saved" as const])),
    )
    setLastUpdatedAt(library.lastUpdatedAt)
  }

  async function saveCanonicalLibrary(
    templatesToSave: EmailTemplate[],
    expectedLibraryRevision: string,
  ) {
    clearAdminClientCache(OUTLOOK_TEMPLATES_INDEX_CACHE_KEY)
    const response = await fetch("/api/admin/email-templates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save",
        templates: templatesToSave,
        expectedLibraryRevision,
      }),
    })
    const data = (await response.json()) as TemplateLibraryResponse & {
      code?: string
      message?: string
    }
    if (response.status === 409 || data.code === "EMAIL_TEMPLATE_CONFLICT") {
      const currentLibrary = await loadCanonicalLibrary()
      replaceTemplatesFromLibrary(currentLibrary)
      throw new Error(
        `${data.message || "The Outlook template library changed."} Your folder change was not written. The current server library has been reloaded.`,
      )
    }
    if (!response.ok || !Array.isArray(data.templates) || !data.revision) {
      throw new Error(data.message || "Failed to save the template library.")
    }
    return data
  }

  function handleCreateTemplate() {
    if (libraryBusyRef.current) return
    const folder = selectedFolder || "Custom"
    const template = createBlankTemplate(folder)
    const nextTemplates = [template, ...templatesRef.current]

    setTemplates(() => {
      templatesRef.current = nextTemplates
      return nextTemplates
    })
    setSelectedId(template.id)
    setSelectedFolder(folder)
    setExpandedFolders((current) => expandFolderPath(folder, current))
    markDirty(template)
  }

  function openCreateFolderDialog(parentPath = selectedFolder) {
    if (libraryBusyRef.current) return
    setFolderDialogMode("create")
    setFolderDialogTarget(parentPath || "")
    setFolderNameDraft("")
    setFolderDialogOpen(true)
  }

  function openEditFolderDialog(folderPath: string) {
    if (libraryBusyRef.current) return
    if (!folderPath) return
    const parts = getFolderParts(folderPath)
    setFolderDialogMode("edit")
    setFolderDialogTarget(folderPath)
    setFolderNameDraft(parts[parts.length - 1] || "")
    setFolderDialogOpen(true)
  }

  function closeFolderDialog() {
    setFolderDialogOpen(false)
    setFolderDialogTarget("")
    setFolderNameDraft("")
  }

  function createFolderFromDialog() {
    if (libraryBusyRef.current) return
    const name = folderNameDraft.trim()
    if (!name) return
    const folderPath = folderDialogTarget ? `${folderDialogTarget} / ${name}` : name
    setCustomFolders((current) => Array.from(new Set([...current, folderPath])).sort((a, b) => a.localeCompare(b)))
    setSelectedFolder(folderPath)
    setExpandedFolders((current) => expandFolderPath(folderPath, current))
    closeFolderDialog()
  }

  async function renameFolderFromDialog() {
    const nextName = folderNameDraft.trim()
    const oldPath = folderDialogTarget
    if (!oldPath || !nextName) return
    const parts = getFolderParts(oldPath)
    const parent = parts.slice(0, -1).join(" / ")
    const nextPath = parent ? `${parent} / ${nextName}` : nextName
    if (nextPath === oldPath) {
      closeFolderDialog()
      return
    }

    if (libraryBusyRef.current) return
    setLibraryOperationBusy(true)
    setMessage("")
    try {
      await flushPendingSaves()
      const currentLibrary = await loadCanonicalLibrary()
      const now = new Date().toISOString()
      const renamedTemplates = currentLibrary.templates.map((template) => {
        if (!folderContains(template, oldPath)) return template
        const suffix = template.folder === oldPath ? "" : template.folder.slice(oldPath.length)
        const folder = `${nextPath}${suffix}`
        return {
          ...template,
          folder,
          tags: getFolderParts(folder),
          updatedAt: now,
        }
      })
      const changed = renamedTemplates.some(
        (template, index) => template.folder !== currentLibrary.templates[index]?.folder,
      )

      if (changed) {
        const savedLibrary = await saveCanonicalLibrary(
          renamedTemplates,
          currentLibrary.revision,
        )
        replaceTemplatesFromLibrary(savedLibrary)
      }

      setCustomFolders((current) =>
        Array.from(
          new Set(
            current.map((folder) => {
              if (folder === oldPath) return nextPath
              if (folder.startsWith(`${oldPath} / `)) {
                return `${nextPath}${folder.slice(oldPath.length)}`
              }
              return folder
            })
          )
        ).sort((a, b) => a.localeCompare(b))
      )
      setSelectedFolder(nextPath)
      setExpandedFolders((current) => expandFolderPath(nextPath, current))
      closeFolderDialog()
    } catch (error) {
      if (!(error instanceof PendingTemplateSaveError)) {
        setMessage(error instanceof Error ? error.message : "Failed to rename folder.")
      }
    } finally {
      setLibraryOperationBusy(false)
    }
  }

  async function deleteFolderFromDialog() {
    const folderPath = folderDialogTarget
    if (!folderPath) return
    if (libraryBusyRef.current) return
    setLibraryOperationBusy(true)
    setMessage("")
    try {
      await flushPendingSaves()
      const currentLibrary = await loadCanonicalLibrary()
      const remainingTemplates = currentLibrary.templates.filter(
        (template) => !folderContains(template, folderPath)
      )
      const serverAffectedCount = currentLibrary.templates.length - remainingTemplates.length
      const confirmed = window.confirm(
        `Delete folder "${folderPath}"?\n\nThis will delete ${serverAffectedCount} current template${serverAffectedCount === 1 ? "" : "s"} in this folder and subfolders.`
      )
      if (!confirmed) return

      if (serverAffectedCount > 0) {
        const savedLibrary = await saveCanonicalLibrary(
          remainingTemplates,
          currentLibrary.revision,
        )
        replaceTemplatesFromLibrary(savedLibrary)
        setSelectedId(savedLibrary.templates[0]?.id || "")
      }

      setCustomFolders((current) =>
        current.filter(
          (folder) =>
            folder !== folderPath && !folder.startsWith(`${folderPath} / `)
        )
      )
      setSelectedFolder("")
      if (serverAffectedCount === 0) {
        setSelectedId(templatesRef.current[0]?.id || "")
      }
      closeFolderDialog()
    } catch (error) {
      if (!(error instanceof PendingTemplateSaveError)) {
        setMessage(error instanceof Error ? error.message : "Failed to delete folder.")
      }
    } finally {
      setLibraryOperationBusy(false)
    }
  }

  async function moveTemplateToFolder(templateId: string, folderPath: string) {
    if (libraryBusyRef.current) return
    const template = templatesRef.current.find((item) => item.id === templateId)
    const targetFolder = folderPath || "Custom"
    if (!template || template.folder === targetFolder) return
    const now = new Date().toISOString()
    const movedTemplate = {
      ...template,
      folder: targetFolder,
      tags: getFolderParts(targetFolder),
      updatedAt: now,
    }
    try {
      const templateToSave = await hydrateTemplateForSave(movedTemplate)
      if (libraryBusyRef.current) return
      setTemplates((current) => {
        const next = current.map((item) =>
          item.id === templateId ? templateToSave : item
        )
        templatesRef.current = next
        return next
      })
      setSelectedFolder(targetFolder)
      setSelectedId(templateId)
      setExpandedFolders((current) => expandFolderPath(targetFolder, current))
      markDirty(templateToSave)
    } catch (error) {
      setTemplateSaveState(templateId, "failed")
      setMessage(error instanceof Error ? error.message : "Failed to move template.")
    }
  }

  async function handleDeleteTemplate() {
    if (!selectedTemplate) return
    const templateId = selectedTemplate.id
    const confirmed = window.confirm(
      `Delete template "${selectedTemplate.title || "Untitled template"}"?\n\nThis cannot be undone from this page.`,
    )
    if (!confirmed) return

    if (libraryBusyRef.current) return
    setLibraryOperationBusy(true)
    setMessage("")
    try {
      await flushPendingSaves()
      const currentTemplate = templatesRef.current.find(
        (template) => template.id === templateId
      )
      if (!currentTemplate) throw new Error("Template not found.")

      clearAdminClientCache(OUTLOOK_TEMPLATES_INDEX_CACHE_KEY)
      const response = await fetch("/api/admin/email-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete-template",
          id: templateId,
          expectedRevision: currentTemplate.revision,
        }),
      })
      const data = (await response.json()) as SaveTemplateResponse
      if (response.status === 409 || data.code === "EMAIL_TEMPLATE_CONFLICT") {
        await reloadTemplateAfterConflict(
          templateId,
          data.message || "This Outlook template changed before it could be deleted.",
        )
        return
      }
      if (!response.ok) throw new Error(data.message || "Delete failed.")

      clearAutosaveTimer(templateId)
      pendingTemplatesRef.current.delete(templateId)
      dirtyVersionsRef.current.delete(templateId)
      failedSavesRef.current.delete(templateId)
      setConflictAlert((current) =>
        current?.templateId === templateId ? null : current
      )
      const nextTemplates = templatesRef.current.filter(
        (template) => template.id !== templateId
      )
      templatesRef.current = nextTemplates
      setTemplates(nextTemplates)
      setSaveStates((current) => {
        const next = { ...current }
        delete next[templateId]
        return next
      })
      setSelectedId((current) =>
        current === templateId ? nextTemplates[0]?.id || "" : current
      )
      setLastUpdatedAt(data.lastUpdatedAt || new Date().toISOString())
    } catch (error) {
      if (!(error instanceof PendingTemplateSaveError)) {
        failedSavesRef.current.add(templateId)
        setTemplateSaveState(templateId, "failed")
        setMessage(error instanceof Error ? error.message : "Delete failed.")
      }
    } finally {
      setLibraryOperationBusy(false)
    }
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

  function openRecipientPicker(field: RecipientField) {
    setRecipientPickerField(field)
    setRecipientSearch("")
    void loadRecipients()
  }

  function closeRecipientPicker() {
    setRecipientPickerField(null)
    setRecipientSearch("")
  }

  function addRecipient(option: RecipientOption) {
    if (!selectedTemplate || !recipientPickerField || !option.value) return
    const current = splitRecipientText(selectedTemplate[recipientPickerField])
    updateSelectedTemplate({
      [recipientPickerField]: joinRecipients([...current, option.value]),
    } as Pick<EmailTemplate, RecipientField>)
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
          data-admin-button-style="preserve"
          onClick={() => selectFolder(node.path)}
          onDoubleClick={() => openEditFolderDialog(node.path)}
          onDragOver={(event) => {
            event.preventDefault()
            if (draggedTemplateId) setDropTargetFolder(node.path)
          }}
          onDragLeave={() => {
            if (dropTargetFolder === node.path) setDropTargetFolder("")
          }}
          onDrop={(event) => {
            event.preventDefault()
            if (draggedTemplateId) void moveTemplateToFolder(draggedTemplateId, node.path)
            setDraggedTemplateId("")
            setDropTargetFolder("")
          }}
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
            background: dropTargetFolder === node.path ? "#d6ecff" : active ? "var(--fc-row-active-bg)" : "#ffffff",
            outline: dropTargetFolder === node.path ? "2px solid var(--fc-accent)" : "none",
            outlineOffset: "-2px",
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
          <span style={{ color: "var(--fc-muted)", fontSize: "11px", fontWeight: 800 }}> </span>
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
          data-admin-button-style="preserve"
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
          <p>Please log in from the admin homepage first.</p>
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
          justifyContent: "flex-end",
          gap: "12px",
          flexWrap: "wrap",
        }}
      >
        <a
          href="/api/outlook-addin/manifest"
          download="fratelli-cosulich-templates-manifest.xml"
          style={manifestButtonStyle}
        >
          DOWNLOAD OUTLOOK MANIFEST
        </a>
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
          </div>
          <div style={{ padding: "8px", display: "grid", gap: "8px" }}>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search templates"
              style={inputStyle}
            />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "7px" }}>
              <button type="button" onClick={() => openCreateFolderDialog(selectedFolder)} style={primaryButtonStyle} data-admin-button-style="preserve" disabled={libraryBusy}>
                New Folder
              </button>
              <button type="button" onClick={handleCreateTemplate} style={primaryButtonStyle} data-admin-button-style="preserve" disabled={libraryBusy}>
                New Template
              </button>
            </div>
          </div>
          <div style={{ maxHeight: isMobile ? "320px" : "calc(100vh - 170px)", overflow: "auto", padding: "6px" }}>
            {renderFolderNode(folderTree.root)}
          </div>
        </section>

        <section style={panelStyle}>
          <div style={sectionHeaderStyle}>
            <div style={sectionTitleStyle}>{search ? "Search Results" : selectedFolder || "All Templates"}</div>
          </div>
          <div style={{ maxHeight: isMobile ? "360px" : "calc(100vh - 88px)", overflow: "auto", padding: "6px" }}>
            {visibleTemplates.map((template) => {
              const active = template.id === selectedId
              return (
                <button
                  key={template.id}
                  type="button"
                  data-admin-button-style="preserve"
                  draggable={!libraryBusy}
                  onClick={() => setSelectedId(template.id)}
                  onDragStart={(event) => {
                    setDraggedTemplateId(template.id)
                    event.dataTransfer.effectAllowed = "move"
                    event.dataTransfer.setData("text/plain", template.id)
                  }}
                  onDragEnd={() => {
                    setDraggedTemplateId("")
                    setDropTargetFolder("")
                  }}
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
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "7px",
                    }}
                  >
                    <span style={{ minWidth: 0, fontSize: "13px", fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {template.title || "Untitled template"}
                    </span>
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
              <button
                type="button"
                onClick={handleManualSave}
                style={primaryButtonStyle}
                disabled={
                  !selectedTemplate ||
                  !selectedTemplate.bodyLoaded ||
                  saveState === "saving" ||
                  saveState === "conflict"
                }
              >
                {selectedTemplate && !selectedTemplate.bodyLoaded
                  ? "Loading"
                  : saveState === "saving"
                    ? "Saving"
                    : saveState === "dirty"
                      ? "Save Now"
                      : saveState === "failed"
                        ? "Retry Save"
                        : saveState === "conflict"
                          ? "Server Reloaded"
                          : "Saved"}
              </button>
              <button type="button" onClick={handleDeleteTemplate} style={dangerButtonStyle} disabled={!selectedTemplate || libraryBusy}>
                Delete
              </button>
            </div>
          </div>

          {displayedMessage ? (
            <div
              role="alert"
              style={{
                color: "var(--fc-error)",
                fontSize: "13px",
                padding: "10px 12px",
                borderBottom: "1px solid var(--fc-admin-border-soft)",
              }}
            >
              {displayedMessage}
            </div>
          ) : null}

          {selectedTemplate ? selectedTemplate.bodyLoaded ? (
            <div style={{ display: "grid", gap: "12px", padding: "12px" }}>
              {selectedRecipientTruth.kind === "blocked" ? (
                <div
                  role="alert"
                  style={{
                    display: "grid",
                    gap: "9px",
                    border: "1px solid var(--fc-admin-danger-border)",
                    borderRadius: "10px",
                    background: "var(--fc-admin-danger-bg)",
                    color: "var(--fc-admin-danger-text)",
                    padding: "11px 12px",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: "8px",
                      alignItems: "center",
                      flexWrap: "wrap",
                    }}
                  >
                    <strong style={{ fontSize: "11px", letterSpacing: "0.03em" }}>
                      OUTLOOK RECIPIENT TRUTH: BLOCKED
                    </strong>
                    <span style={{ fontSize: "11px", fontWeight: 900 }}>
                      {selectedRecipientTruth.missing} missing ·{" "}
                      {selectedRecipientTruth.ambiguous} ambiguous
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", lineHeight: 1.45 }}>
                    Outlook insertion is blocked for the exact stored recipient
                    literals below. FC Uno has not guessed or replaced them.
                  </div>
                  <ul
                    style={{
                      display: "grid",
                      gap: "6px",
                      listStyle: "none",
                      margin: 0,
                      padding: 0,
                    }}
                  >
                    {selectedRecipientTruth.issues.map((issue) => (
                      <li
                        key={`${issue.field}-${issue.position}`}
                        style={{
                          display: "grid",
                          gridTemplateColumns: "42px minmax(0, 1fr) auto",
                          gap: "8px",
                          alignItems: "start",
                          border: "1px solid var(--fc-admin-danger-border)",
                          borderRadius: "7px",
                          background: "var(--fc-admin-panel-bg)",
                          padding: "7px 8px",
                        }}
                      >
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 900,
                            textTransform: "uppercase",
                          }}
                        >
                          {issue.field}
                        </span>
                        <span
                          style={{
                            minWidth: 0,
                            color: "var(--fc-admin-panel-text)",
                            fontSize: "12px",
                            fontWeight: 800,
                            overflowWrap: "anywhere",
                            whiteSpace: "pre-wrap",
                          }}
                        >
                          {issue.literal}
                        </span>
                        <span
                          style={{
                            fontSize: "10px",
                            fontWeight: 900,
                            textTransform: "uppercase",
                          }}
                        >
                          {issue.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: "10px" }}>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Title</div>
                  <input
                    value={selectedTemplate.title}
                    onChange={(event) => updateSelectedTemplate({ title: event.target.value })}
                    style={inputStyle}
                    disabled={libraryBusy}
                  />
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Subject</div>
                  <input
                    value={selectedTemplate.subject}
                    onChange={(event) => updateSelectedTemplate({ subject: event.target.value })}
                    style={inputStyle}
                    disabled={libraryBusy}
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
                  <button type="button" onClick={() => openRecipientPicker("to")} style={{ ...inputStyle, height: "auto", minHeight: "38px", textAlign: "left", cursor: "pointer" }} disabled={libraryBusy}>
                    {selectedTemplate.to || "Select contacts or groups"}
                  </button>
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Cc</div>
                  <button type="button" onClick={() => openRecipientPicker("cc")} style={{ ...inputStyle, height: "auto", minHeight: "38px", textAlign: "left", cursor: "pointer" }} disabled={libraryBusy}>
                    {selectedTemplate.cc || "Select contacts or groups"}
                  </button>
                </label>
                <label>
                  <div style={{ fontSize: "12px", color: "var(--fc-muted)", marginBottom: "5px", fontWeight: 800 }}>Bcc</div>
                  <button type="button" onClick={() => openRecipientPicker("bcc")} style={{ ...inputStyle, height: "auto", minHeight: "38px", textAlign: "left", cursor: "pointer" }} disabled={libraryBusy}>
                    {selectedTemplate.bcc || "Select contacts or groups"}
                  </button>
                </label>
              </div>

              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: "10px",
                  alignItems: "center",
                  padding: "9px 10px",
                  border: "1px solid var(--fc-admin-border-soft)",
                  borderRadius: "7px",
                  background: "var(--fc-admin-panel-soft-bg)",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: "var(--fc-muted)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>Folder</div>
                  <div style={{ marginTop: "3px", color: "var(--fc-text)", fontSize: "13px", fontWeight: 800, overflowWrap: "anywhere" }}>
                    {selectedTemplate.folder || "Unfiled"}
                  </div>
                </div>
                <button type="button" onClick={() => setFolderPickerOpen(true)} style={buttonStyle} disabled={libraryBusy}>
                  Change folder
                </button>
              </div>

              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                <select onChange={(event) => runEditorCommand("fontName", event.target.value)} defaultValue="" style={buttonStyle} disabled={libraryBusy}>
                  <option value="" disabled>Font</option>
                  <option value="Roboto">Roboto</option>
                  <option value="Calibri">Calibri</option>
                  <option value="Times New Roman">Times</option>
                  <option value="Courier New">Courier</option>
                </select>
                <select onChange={(event) => runEditorCommand("fontSize", event.target.value)} defaultValue="" style={buttonStyle} disabled={libraryBusy}>
                  <option value="" disabled>Size</option>
                  <option value="2">Small</option>
                  <option value="3">Normal</option>
                  <option value="4">Large</option>
                  <option value="5">Extra Large</option>
                </select>
                <button type="button" onClick={() => runEditorCommand("bold")} style={buttonStyle} disabled={libraryBusy}>B</button>
                <button type="button" onClick={() => runEditorCommand("italic")} style={buttonStyle} disabled={libraryBusy}>I</button>
                <button type="button" onClick={() => runEditorCommand("underline")} style={buttonStyle} disabled={libraryBusy}>U</button>
                <button type="button" onClick={() => runEditorCommand("strikeThrough")} style={buttonStyle} disabled={libraryBusy}>S</button>
              </div>

              <div
                ref={editorRef}
                contentEditable={!libraryBusy}
                role="textbox"
                aria-label="Template email body"
                aria-multiline="true"
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
            <div style={{ display: "grid", gap: "12px", padding: "24px", color: "var(--fc-muted)" }}>
              <div style={{ color: "var(--fc-admin-heading)", fontSize: "16px", fontWeight: 900 }}>
                {selectedTemplate.title || "Untitled template"}
              </div>
              <div style={{ fontSize: "13px", lineHeight: 1.5 }}>
                {selectedTemplate.bodyError || "Loading template body..."}
              </div>
              {selectedTemplate.bodyError ? (
                <button
                  type="button"
                  style={primaryButtonStyle}
                  onClick={() => void loadTemplateDetail(selectedTemplate.id)}
                >
                  Retry
                </button>
              ) : null}
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
      {folderDialogOpen ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 45,
            display: "grid",
            placeItems: "center",
            padding: "18px",
            background: "#1d1d1f99",
          }}
        >
          <div style={{ ...panelStyle, width: "min(520px, 100%)" }}>
            <div style={sectionHeaderStyle}>
              <div style={sectionTitleStyle}>{folderDialogMode === "create" ? "New Folder" : "Folder"}</div>
              <button type="button" onClick={closeFolderDialog} style={buttonStyle}>Close</button>
            </div>
            <div style={{ display: "grid", gap: "12px", padding: "14px" }}>
              <div style={{ color: "var(--fc-muted)", fontSize: "12px", fontWeight: 800 }}>
                {folderDialogMode === "create"
                  ? `Parent: ${folderDialogTarget || "All templates"}`
                  : folderDialogTarget}
              </div>
              <input
                value={folderNameDraft}
                onChange={(event) => setFolderNameDraft(event.target.value)}
                placeholder="Folder name"
                autoFocus
                style={inputStyle}
                disabled={libraryBusy}
              />
              <div style={{ display: "flex", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
                {folderDialogMode === "edit" ? (
                  <button type="button" onClick={deleteFolderFromDialog} style={dangerButtonStyle} disabled={libraryBusy}>
                    Delete Folder
                  </button>
                ) : <span />}
                <button
                  type="button"
                  onClick={folderDialogMode === "create" ? createFolderFromDialog : renameFolderFromDialog}
                  style={primaryButtonStyle}
                  disabled={libraryBusy}
                >
                  {folderDialogMode === "create" ? "Create Folder" : "Rename Folder"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {recipientPickerField && selectedTemplate ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "grid",
            placeItems: "center",
            padding: "18px",
            background: "#1d1d1f99",
          }}
        >
          <div style={{ ...panelStyle, width: "min(820px, 100%)", maxHeight: "86vh", display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)" }}>
            <div style={sectionHeaderStyle}>
              <div style={sectionTitleStyle}>Select {recipientPickerField.toUpperCase()}</div>
              <button type="button" onClick={closeRecipientPicker} style={buttonStyle}>Done</button>
            </div>
            <div style={{ display: "grid", gap: "10px", padding: "12px", borderBottom: "1px solid var(--fc-admin-border-soft)" }}>
              <input
                value={recipientSearch}
                onChange={(event) => setRecipientSearch(event.target.value)}
                placeholder="Search contacts and groups"
                autoFocus
                style={inputStyle}
              />
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                {splitRecipientText(selectedTemplate[recipientPickerField]).length ? (
                  splitRecipientText(selectedTemplate[recipientPickerField]).map((recipient) => (
                    <button
                      key={recipient}
                      type="button"
                      data-admin-button-style="preserve"
                      onClick={() =>
                        updateSelectedTemplate({
                          [recipientPickerField]: joinRecipients(
                            splitRecipientText(selectedTemplate[recipientPickerField]).filter((item) => item !== recipient)
                          ),
                        } as Pick<EmailTemplate, RecipientField>)
                      }
                      style={{
                        ...buttonStyle,
                        borderRadius: "8px",
                        background: "var(--fc-admin-panel-soft-bg)",
                        maxWidth: "100%",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {recipient} x
                    </button>
                  ))
                ) : (
                  <span style={{ color: "var(--fc-muted)", fontSize: "12px", fontWeight: 800 }}>No recipients selected.</span>
                )}
              </div>
            </div>
            <div style={{ overflow: "auto", padding: "8px", display: "grid", gap: "5px" }}>
              {recipientsLoading ? (
                <div style={{ padding: "18px", color: "var(--fc-muted)", fontSize: "13px" }}>Loading contacts and groups...</div>
              ) : recipientOptions.length ? recipientOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  data-admin-button-style="preserve"
                  onClick={() => addRecipient(option)}
                  style={{
                    width: "100%",
                    minHeight: "40px",
                    display: "grid",
                    gridTemplateColumns: "76px minmax(0, 1fr) minmax(120px, 0.8fr)",
                    gap: "8px",
                    alignItems: "center",
                    border: "1px solid var(--fc-row-border)",
                    borderRadius: "7px",
                    background: "var(--fc-row-bg)",
                    color: "var(--fc-row-text)",
                    cursor: "pointer",
                    padding: "8px 10px",
                    textAlign: "left",
                  }}
                >
                  <span style={{ color: "var(--fc-accent)", fontSize: "11px", fontWeight: 900, textTransform: "uppercase" }}>{option.type}</span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px", fontWeight: 900 }}>
                    {option.label}
                  </span>
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--fc-muted)", fontSize: "12px", fontWeight: 800 }}>
                    {option.detail}
                  </span>
                </button>
              )) : (
                <div style={{ padding: "18px", color: "var(--fc-muted)", fontSize: "13px" }}>No matching contacts or groups.</div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
