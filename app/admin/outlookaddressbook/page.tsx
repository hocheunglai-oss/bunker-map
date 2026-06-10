"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { supabase } from "@/lib/supabase"
import { useSimpleAdminAuth } from "@/lib/useSimpleAdminAuth"
import { useIsMobile } from "@/lib/useIsMobile"

type SharedContact = {
  id: string
  source_book: string
  source_card: string | null
  display_name: string
  primary_email: string
  nickname: string | null
  first_name: string | null
  last_name: string | null
  vcard: string | null
  properties: Record<string, unknown> | null
}

type SharedGroup = {
  id: string
  source_book: string
  source_uid: string | null
  name: string
  nickname: string | null
  description: string | null
  member_count: number
}

type GroupMember = {
  group_id: string
  contact_id: string
  source_book: string
}

type SaveState = "idle" | "saving" | "saved" | "failed"
type ActiveView = "contacts" | "groups"
type ExchangeQueueAction =
  | "create_contact"
  | "update_contact"
  | "delete_contact"
  | "create_group"
  | "update_group"
  | "delete_group"
  | "update_group_members"
type ExchangeQueueEntityType = "contact" | "group" | "group_members"
type ExchangeSyncStatus = {
  webhookConfigured: boolean
  status: {
    status: "not_configured" | "queued" | "running" | "completed" | "failed"
    message: string
    requestedAt: string | null
    response?: unknown
  }
}

const INTERNAL_DOMAINS = ["cosulich.com.hk", "cosulich.com.sg"]
const EXCHANGE_SYNC_TIMEOUT_MS = 10 * 60 * 1000

const pageStyle: React.CSSProperties = {
  minHeight: "100vh",
  background: "var(--fc-admin-page-bg)",
  fontFamily: "var(--fc-admin-font)",
  color: "var(--fc-admin-panel-text)",
  padding: "18px",
}

const panelStyle: React.CSSProperties = {
  background: "var(--fc-admin-panel-bg)",
  border: "1px solid var(--fc-admin-border)",
  borderRadius: "18px",
  boxShadow: "0 12px 28px #00000010",
  overflow: "hidden",
}

const headerStyle: React.CSSProperties = {
  minHeight: "38px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "8px",
  padding: "10px 12px",
  borderBottom: "1px solid var(--fc-admin-border-soft)",
  background: "var(--fc-admin-panel-soft-bg)",
}

const titleStyle: React.CSSProperties = {
  minWidth: 0,
  color: "var(--fc-admin-heading)",
  fontSize: "12px",
  fontWeight: 900,
  textTransform: "uppercase",
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
  boxSizing: "border-box",
}

const fieldLabelStyle: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--fc-muted)",
  marginBottom: "5px",
  fontWeight: 800,
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function normalized(value: unknown) {
  return cleanText(value).toLowerCase()
}

function emailDomain(email: string) {
  return normalized(email).split("@").pop() || ""
}

function isInternalEmail(email: string) {
  return INTERNAL_DOMAINS.includes(emailDomain(email))
}

function exchangeAlias(value: string, fallback: string) {
  const base = cleanText(value || fallback)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 58)

  return base || fallback
}

function uniqueAlias(baseAlias: string, seenAliases: Set<string>) {
  let alias = baseAlias
  let index = 2
  while (seenAliases.has(alias)) {
    const suffix = `-${index}`
    alias = `${baseAlias.slice(0, 64 - suffix.length)}${suffix}`
    index += 1
  }
  seenAliases.add(alias)
  return alias
}

function csvEscape(value: unknown) {
  const text = String(value ?? "")
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`
  return text
}

function csvContent(rows: Record<string, unknown>[], headers: string[]) {
  return [headers.join(","), ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(","))].join("\n") + "\n"
}

function downloadText(filename: string, content: string, type = "text/csv;charset=utf-8") {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement("a")
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function newId(prefix: string) {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}-${crypto.randomUUID()}`
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function matchesSearch(values: unknown[], query: string) {
  const tokens = normalized(query).split(" ").filter(Boolean)
  if (tokens.length === 0) return true
  const haystack = normalized(values.join(" "))
  return tokens.every((token) => haystack.includes(token))
}

function contactExchangeSnapshot(contact: SharedContact) {
  const email = normalized(contact.primary_email)
  const displayName = cleanText(contact.display_name || email)
  return {
    SourceBook: cleanText(contact.source_book),
    SourceContactId: contact.id,
    DisplayName: displayName,
    FirstName: cleanText(contact.first_name),
    LastName: cleanText(contact.last_name),
    Alias: exchangeAlias(cleanText(contact.nickname || displayName || email.split("@")[0]), `contact-${contact.id}`),
    ExternalEmailAddress: email,
    Nickname: cleanText(contact.nickname),
  }
}

function groupExchangeSnapshot(group: SharedGroup) {
  const groupName = cleanText(group.name || group.nickname || group.source_uid)
  return {
    SourceBook: cleanText(group.source_book),
    SourceGroupId: group.id,
    GroupName: groupName,
    Alias: exchangeAlias(cleanText(group.nickname || groupName), `group-${group.id}`),
    Description: cleanText(group.description),
    MemberCount: Number(group.member_count || 0),
  }
}

function buildExportRows(contacts: SharedContact[], groups: SharedGroup[], members: GroupMember[]) {
  const seenEmails = new Set<string>()
  const seenContactAliases = new Set<string>()
  const contactRows: Record<string, unknown>[] = []
  const contactById = new Map<string, Record<string, unknown>>()

  for (const contact of contacts) {
    const email = normalized(contact.primary_email)
    if (!email || seenEmails.has(email)) continue
    const displayName = cleanText(contact.display_name || email)
    const row = {
      SourceBook: cleanText(contact.source_book),
      SourceContactId: contact.id,
      DisplayName: displayName,
      FirstName: cleanText(contact.first_name),
      LastName: cleanText(contact.last_name),
      Alias: uniqueAlias(exchangeAlias(cleanText(contact.nickname || displayName || email.split("@")[0]), `contact-${contactRows.length + 1}`), seenContactAliases),
      ExternalEmailAddress: email,
      Nickname: cleanText(contact.nickname),
    }
    if (!isInternalEmail(email)) contactRows.push(row)
    seenEmails.add(email)
    contactById.set(contact.id, row)
  }

  const seenGroupAliases = new Set<string>()
  const groupRows = groups
    .map((group, index) => ({
      SourceBook: cleanText(group.source_book),
      SourceGroupId: group.id,
      GroupName: cleanText(group.name || group.nickname || group.source_uid),
      Alias: uniqueAlias(exchangeAlias(cleanText(group.nickname || group.name), `group-${index + 1}`), seenGroupAliases),
      Description: cleanText(group.description),
      MemberCount: 0,
    }))
    .filter((group) => group.GroupName)

  const groupById = new Map(groupRows.map((group) => [String(group.SourceGroupId), group]))
  const memberRows: Record<string, unknown>[] = []
  const seenMembers = new Set<string>()

  for (const member of members) {
    const group = groupById.get(member.group_id)
    const contact = contactById.get(member.contact_id)
    if (!group || !contact) continue
    const key = `${group.Alias}\u0000${contact.ExternalEmailAddress}`
    if (seenMembers.has(key)) continue
    seenMembers.add(key)
    group.MemberCount = Number(group.MemberCount || 0) + 1
    memberRows.push({
      SourceBook: cleanText(member.source_book),
      GroupName: group.GroupName,
      GroupAlias: group.Alias,
      MemberDisplayName: contact.DisplayName,
      MemberEmail: contact.ExternalEmailAddress,
    })
  }

  return {
    contactRows,
    groupRows: groupRows.filter((group) => Number(group.MemberCount || 0) > 0),
    memberRows,
  }
}

function powerShellContent() {
  return `param(
  [string]$ContactsCsv = ".\\exchange-contacts.csv",
  [string]$GroupsCsv = ".\\exchange-groups.csv",
  [string]$MembersCsv = ".\\exchange-group-members.csv"
)

$ErrorActionPreference = "Stop"

Import-Module ExchangeOnlineManagement
Write-Host "Connect first if needed: Connect-ExchangeOnline -UserPrincipalName your-admin@yourdomain.com -Device"

Write-Host "Creating or checking mail contacts..."
Import-Csv $ContactsCsv | ForEach-Object {
  $email = $_.ExternalEmailAddress
  $alias = $_.Alias
  $existing = Get-MailContact -Filter "ExternalEmailAddress -eq '$email'" -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Exists contact:" $_.DisplayName "<$email>"
  } else {
    New-MailContact -Name $_.DisplayName -DisplayName $_.DisplayName -ExternalEmailAddress $email -Alias $alias | Out-Null
    Write-Host "Created contact:" $_.DisplayName "<$email>"
  }

  try {
    Set-MailContact -Identity $email -HiddenFromAddressListsEnabled $false -ErrorAction Stop
  } catch {
    Write-Warning ("Could not force address-list visibility for contact {0}: {1}" -f $email, $_.Exception.Message)
  }
}

Write-Host "Creating or checking distribution groups..."
Import-Csv $GroupsCsv | ForEach-Object {
  $alias = $_.Alias
  $existing = Get-DistributionGroup -Identity $alias -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Exists group:" $_.GroupName
  } else {
    New-DistributionGroup -Name $_.GroupName -Alias $alias -Notes $_.Description | Out-Null
    Write-Host "Created group:" $_.GroupName
  }

  try {
    Set-DistributionGroup -Identity $alias -HiddenFromAddressListsEnabled $false -ErrorAction Stop
  } catch {
    Write-Warning ("Could not force address-list visibility for group {0}: {1}" -f $alias, $_.Exception.Message)
  }
}

Write-Host "Adding group members..."
Import-Csv $MembersCsv | ForEach-Object {
  try {
    Add-DistributionGroupMember -Identity $_.GroupAlias -Member $_.MemberEmail -ErrorAction Stop
    Write-Host "Added" $_.MemberEmail "to" $_.GroupName
  } catch {
    if ($_.Exception.Message -match "already a member") {
      Write-Host "Already member:" $_.MemberEmail "in" $_.GroupName
    } else {
      Write-Warning ("Could not add {0} to {1}: {2}" -f $_.MemberEmail, $_.GroupName, $_.Exception.Message)
    }
  }
}

Write-Host ""
Write-Host "Verification sample:"
$sampleContact = Import-Csv $ContactsCsv | Select-Object -First 1
if ($sampleContact) {
  Get-MailContact -Identity $sampleContact.ExternalEmailAddress |
    Format-List DisplayName,ExternalEmailAddress,HiddenFromAddressListsEnabled
}
$sampleGroup = Import-Csv $GroupsCsv | Select-Object -First 1
if ($sampleGroup) {
  Get-DistributionGroup -Identity $sampleGroup.Alias |
    Format-List DisplayName,PrimarySmtpAddress,HiddenFromAddressListsEnabled,RecipientTypeDetails
  Write-Host "Group member count:"
  (Get-DistributionGroupMember -Identity $sampleGroup.Alias).Count
}

Write-Host "Done."
`
}

export default function OutlookAddressBookPage() {
  const router = useRouter()
  const isMobile = useIsMobile()
  const { loading: authLoading, authenticated, username, displayName } = useSimpleAdminAuth()
  const [contacts, setContacts] = useState<SharedContact[]>([])
  const [groups, setGroups] = useState<SharedGroup[]>([])
  const [members, setMembers] = useState<GroupMember[]>([])
  const [activeView, setActiveView] = useState<ActiveView>("contacts")
  const [selectedContactId, setSelectedContactId] = useState("")
  const [selectedGroupId, setSelectedGroupId] = useState("")
  const [contactSearch, setContactSearch] = useState("")
  const [groupSearch, setGroupSearch] = useState("")
  const [addMemberSearch, setAddMemberSearch] = useState("")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState<SaveState>("idle")
  const [message, setMessage] = useState("")
  const [exchangeSyncStatus, setExchangeSyncStatus] = useState<ExchangeSyncStatus | null>(null)
  const [exchangeSyncing, setExchangeSyncing] = useState(false)
  const [exchangeButtonLabel, setExchangeButtonLabel] = useState("Sync Exchange")
  const [exchangeSyncStartedAt, setExchangeSyncStartedAt] = useState<string | null>(null)
  const contactDraftsRef = useRef<Record<string, SharedContact>>({})
  const groupDraftsRef = useRef<Record<string, SharedGroup>>({})
  const contactSaveChainsRef = useRef<Record<string, Promise<void>>>({})
  const groupSaveChainsRef = useRef<Record<string, Promise<void>>>({})

  useEffect(() => {
    document.title = "Outlook Address Book - FC Uno"
  }, [])

  useEffect(() => {
    if (!authenticated) return
    void loadAll()
    void loadExchangeSyncStatus()
  }, [authenticated])

  useEffect(() => {
    if (!authenticated) return
    if (!exchangeSyncing) return
    const status = exchangeSyncStatus?.status.status
    if (status === "completed") {
      setExchangeSyncing(false)
      setExchangeButtonLabel("Syncing Completed")
      return
    }
    if (status === "failed") {
      setExchangeSyncing(false)
      setExchangeButtonLabel("Sync Exchange")
      setMessage(exchangeSyncStatus?.status.message || "Exchange sync failed.")
      return
    }
    if (status !== "queued" && status !== "running") return
    const requestedAt = exchangeSyncStatus?.status.requestedAt || exchangeSyncStartedAt
    const requestedAtMs = requestedAt ? Date.parse(requestedAt) : NaN
    if (Number.isFinite(requestedAtMs) && Date.now() - requestedAtMs > EXCHANGE_SYNC_TIMEOUT_MS) {
      setExchangeSyncing(false)
      setExchangeButtonLabel("Sync Exchange")
      setMessage("Exchange sync did not finish within 10 minutes. Check Azure Automation jobs for the exact error, then press Sync Exchange again.")
      return
    }
    const timer = window.setTimeout(() => {
      void loadExchangeSyncStatus()
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [authenticated, exchangeSyncStatus, exchangeSyncing, exchangeSyncStartedAt])

  const selectedContact = contacts.find((contact) => contact.id === selectedContactId) || null
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) || null

  const groupMemberIds = useMemo(
    () => new Set(members.filter((member) => member.group_id === selectedGroupId).map((member) => member.contact_id)),
    [members, selectedGroupId]
  )

  const selectedGroupMembers = useMemo(
    () =>
      contacts
        .filter((contact) => groupMemberIds.has(contact.id))
        .sort((a, b) => cleanText(a.display_name).localeCompare(cleanText(b.display_name))),
    [contacts, groupMemberIds]
  )

  const visibleContacts = useMemo(
    () =>
      contacts
        .filter((contact) => matchesSearch([contact.display_name, contact.primary_email, contact.nickname, contact.source_book], contactSearch))
        .slice(0, 500),
    [contacts, contactSearch]
  )

  const visibleGroups = useMemo(
    () =>
      groups
        .filter((group) => matchesSearch([group.name, group.nickname, group.source_book], groupSearch))
        .slice(0, 500),
    [groups, groupSearch]
  )

  const addableContacts = useMemo(
    () =>
      contacts
        .filter((contact) => !groupMemberIds.has(contact.id))
        .filter((contact) => matchesSearch([contact.display_name, contact.primary_email, contact.nickname, contact.source_book], addMemberSearch))
        .slice(0, 80),
    [addMemberSearch, contacts, groupMemberIds]
  )

  const exportRows = useMemo(() => buildExportRows(contacts, groups, members), [contacts, groups, members])
  const activeSearch = activeView === "contacts" ? contactSearch : groupSearch

  function markExchangeNeedsSync() {
    if (!exchangeSyncing) setExchangeButtonLabel("Sync Exchange")
    setExchangeSyncStartedAt(null)
  }

  async function loadExchangeSyncStatus() {
    try {
      const response = await fetch("/api/outlook-addressbook/exchange-sync", { cache: "no-store" })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || "Could not load Exchange sync status.")
      setExchangeSyncStatus(data)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not load Exchange sync status.")
    }
  }

  async function loadAll() {
    setLoading(true)
    setMessage("")
    try {
      const [contactRows, groupRows, memberRows] = await Promise.all([
        loadTable<SharedContact>("shared_addressbook_contacts", "display_name"),
        loadTable<SharedGroup>("shared_addressbook_groups", "name"),
        loadTable<GroupMember>("shared_addressbook_group_members", "source_book"),
      ])
      contactDraftsRef.current = {}
      groupDraftsRef.current = {}
      contactSaveChainsRef.current = {}
      groupSaveChainsRef.current = {}
      setContacts(contactRows)
      setGroups(groupRows)
      setMembers(memberRows)
      setSelectedContactId(contactRows[0]?.id || "")
      setSelectedGroupId(groupRows[0]?.id || "")
      setSaving("saved")
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to load Outlook address book.")
      setSaving("failed")
    } finally {
      setLoading(false)
    }
  }

  async function loadTable<T>(table: string, order: string) {
    const allRows: T[] = []
    const pageSize = 1000
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from(table)
        .select("*")
        .order(order, { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) throw error
      const batch = (data as T[]) || []
      allRows.push(...batch)
      if (batch.length < pageSize) break
      from += pageSize
    }
    return allRows
  }

  async function enqueueExchangeSyncChange(input: {
    action: ExchangeQueueAction
    entityType: ExchangeQueueEntityType
    entityId?: string | null
    entityEmail?: string | null
    entityAlias?: string | null
    displayName?: string | null
    payload?: Record<string, unknown>
  }) {
    const entityEmail = normalized(input.entityEmail)
    const entityAlias = normalized(input.entityAlias)
    const { error } = await supabase.from("outlook_exchange_sync_queue").insert({
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId || null,
      entity_email: entityEmail || null,
      entity_alias: entityAlias || null,
      display_name: cleanText(input.displayName) || null,
      payload: input.payload || {},
      requested_by: displayName || username || "Admin",
    })

    if (error) {
      setMessage(`Exchange sync queue was not updated: ${error.message}`)
    }
  }

  function queueEntitySave(chainsRef: { current: Record<string, Promise<void>> }, entityId: string, operation: () => Promise<void>) {
    const previous = chainsRef.current[entityId] || Promise.resolve()
    const chained = previous.catch(() => undefined).then(operation)
    let tracked: Promise<void>
    tracked = chained.finally(() => {
      if (chainsRef.current[entityId] === tracked) {
        delete chainsRef.current[entityId]
      }
    })
    chainsRef.current[entityId] = tracked
    return tracked
  }

  async function waitForPendingSaves() {
    while (true) {
      const pending = [...Object.values(contactSaveChainsRef.current), ...Object.values(groupSaveChainsRef.current)]
      if (pending.length === 0) return
      await Promise.all(pending)
    }
  }

  function latestContacts() {
    return contacts.map((contact) => contactDraftsRef.current[contact.id] || contact)
  }

  async function saveContact(partial: Partial<SharedContact>) {
    if (!selectedContact) return
    const nextContact = { ...(contactDraftsRef.current[selectedContact.id] || selectedContact), ...partial }
    contactDraftsRef.current[selectedContact.id] = nextContact
    setContacts((current) => current.map((contact) => (contact.id === nextContact.id ? nextContact : contact)))
    markExchangeNeedsSync()
    setSaving("saving")
    setMessage("")
    void queueEntitySave(contactSaveChainsRef, nextContact.id, async () => {
      const contactToSave = contactDraftsRef.current[nextContact.id] || nextContact
      const { error } = await supabase.from("shared_addressbook_contacts").upsert(contactToSave, { onConflict: "id" })
      if (error) {
        setSaving("failed")
        setMessage(error.message)
        throw error
      }
      const snapshot = contactExchangeSnapshot(contactToSave)
      await enqueueExchangeSyncChange({
        action: "update_contact",
        entityType: "contact",
        entityId: contactToSave.id,
        entityEmail: snapshot.ExternalEmailAddress,
        entityAlias: snapshot.Alias,
        displayName: snapshot.DisplayName,
        payload: { contact: snapshot },
      })
      setSaving("saved")
    }).catch(() => undefined)
  }

  async function saveGroup(partial: Partial<SharedGroup>) {
    if (!selectedGroup) return
    const nextGroup = {
      ...(groupDraftsRef.current[selectedGroup.id] || selectedGroup),
      ...partial,
      member_count: members.filter((member) => member.group_id === selectedGroup.id).length,
    }
    groupDraftsRef.current[selectedGroup.id] = nextGroup
    setGroups((current) => current.map((group) => (group.id === nextGroup.id ? nextGroup : group)))
    markExchangeNeedsSync()
    setSaving("saving")
    setMessage("")
    void queueEntitySave(groupSaveChainsRef, nextGroup.id, async () => {
      const groupToSave = groupDraftsRef.current[nextGroup.id] || nextGroup
      const { error } = await supabase.from("shared_addressbook_groups").upsert(groupToSave, { onConflict: "id" })
      if (error) {
        setSaving("failed")
        setMessage(error.message)
        throw error
      }
      const snapshot = groupExchangeSnapshot(groupToSave)
      await enqueueExchangeSyncChange({
        action: "update_group",
        entityType: "group",
        entityId: groupToSave.id,
        entityAlias: snapshot.Alias,
        displayName: snapshot.GroupName,
        payload: { group: snapshot },
      })
      setSaving("saved")
    }).catch(() => undefined)
  }

  async function createContact() {
    const id = newId("contact")
    const contact: SharedContact = {
      id,
      source_book: "FC-OUTLOOK",
      source_card: id,
      display_name: "NEW CONTACT",
      primary_email: "",
      nickname: null,
      first_name: null,
      last_name: null,
      vcard: null,
      properties: {},
    }
    markExchangeNeedsSync()
    setSaving("saving")
    const { error } = await supabase.from("shared_addressbook_contacts").insert(contact)
    if (error) {
      setSaving("failed")
      setMessage(error.message)
      return
    }
    contactDraftsRef.current[id] = contact
    const snapshot = contactExchangeSnapshot(contact)
    await enqueueExchangeSyncChange({
      action: "create_contact",
      entityType: "contact",
      entityId: contact.id,
      entityEmail: snapshot.ExternalEmailAddress,
      entityAlias: snapshot.Alias,
      displayName: snapshot.DisplayName,
      payload: { contact: snapshot },
    })
    setContacts((current) => [contact, ...current])
    setSelectedContactId(id)
    setSaving("saved")
  }

  async function createGroup() {
    const id = newId("group")
    const group: SharedGroup = {
      id,
      source_book: "FC-OUTLOOK",
      source_uid: id,
      name: "NEW GROUP",
      nickname: null,
      description: null,
      member_count: 0,
    }
    markExchangeNeedsSync()
    setSaving("saving")
    const { error } = await supabase.from("shared_addressbook_groups").insert(group)
    if (error) {
      setSaving("failed")
      setMessage(error.message)
      return
    }
    groupDraftsRef.current[id] = group
    const snapshot = groupExchangeSnapshot(group)
    await enqueueExchangeSyncChange({
      action: "create_group",
      entityType: "group",
      entityId: group.id,
      entityAlias: snapshot.Alias,
      displayName: snapshot.GroupName,
      payload: { group: snapshot },
    })
    setGroups((current) => [group, ...current])
    setSelectedGroupId(id)
    setSaving("saved")
  }

  function createSelected() {
    if (activeView === "contacts") {
      void createContact()
      return
    }
    void createGroup()
  }

  async function deleteContact() {
    if (!selectedContact) return
    if (!confirm(`Delete contact ${selectedContact.display_name}?`)) return
    const deletedContact = selectedContact
    const deletedSnapshot = contactExchangeSnapshot(deletedContact)
    const affectedGroupIds = Array.from(new Set(members.filter((member) => member.contact_id === deletedContact.id).map((member) => member.group_id)))
    markExchangeNeedsSync()
    setSaving("saving")
    await supabase.from("shared_addressbook_group_members").delete().eq("contact_id", deletedContact.id)
    const { error } = await supabase.from("shared_addressbook_contacts").delete().eq("id", deletedContact.id)
    if (error) {
      setSaving("failed")
      setMessage(error.message)
      return
    }
    await enqueueExchangeSyncChange({
      action: "delete_contact",
      entityType: "contact",
      entityId: deletedContact.id,
      entityEmail: deletedSnapshot.ExternalEmailAddress,
      entityAlias: deletedSnapshot.Alias,
      displayName: deletedSnapshot.DisplayName,
      payload: { contact: deletedSnapshot },
    })
    for (const groupId of affectedGroupIds) {
      const group = groups.find((item) => item.id === groupId)
      if (!group) continue
      const snapshot = groupExchangeSnapshot(group)
      await enqueueExchangeSyncChange({
        action: "update_group_members",
        entityType: "group_members",
        entityId: group.id,
        entityAlias: snapshot.Alias,
        displayName: snapshot.GroupName,
        payload: { group: snapshot, removedContact: deletedSnapshot },
      })
    }
    setMembers((current) => current.filter((member) => member.contact_id !== deletedContact.id))
    setContacts((current) => current.filter((contact) => contact.id !== deletedContact.id))
    setSelectedContactId(contacts.find((contact) => contact.id !== deletedContact.id)?.id || "")
    setSaving("saved")
  }

  async function deleteGroup() {
    if (!selectedGroup) return
    if (!confirm(`Delete group ${selectedGroup.name}?`)) return
    const deletedGroup = selectedGroup
    const deletedSnapshot = groupExchangeSnapshot(deletedGroup)
    markExchangeNeedsSync()
    setSaving("saving")
    await supabase.from("shared_addressbook_group_members").delete().eq("group_id", deletedGroup.id)
    const { error } = await supabase.from("shared_addressbook_groups").delete().eq("id", deletedGroup.id)
    if (error) {
      setSaving("failed")
      setMessage(error.message)
      return
    }
    await enqueueExchangeSyncChange({
      action: "delete_group",
      entityType: "group",
      entityId: deletedGroup.id,
      entityAlias: deletedSnapshot.Alias,
      displayName: deletedSnapshot.GroupName,
      payload: { group: deletedSnapshot },
    })
    setMembers((current) => current.filter((member) => member.group_id !== deletedGroup.id))
    setGroups((current) => current.filter((group) => group.id !== deletedGroup.id))
    setSelectedGroupId(groups.find((group) => group.id !== deletedGroup.id)?.id || "")
    setSaving("saved")
  }

  function deleteSelected() {
    if (activeView === "contacts") {
      if (!selectedContact) return
      void deleteContact()
      return
    }
    if (!selectedGroup) return
    void deleteGroup()
  }

  async function addMember(contact: SharedContact) {
    if (!selectedGroup) return
    const member = { group_id: selectedGroup.id, contact_id: contact.id, source_book: selectedGroup.source_book || contact.source_book || "FC-OUTLOOK" }
    markExchangeNeedsSync()
    setSaving("saving")
    const { error } = await supabase.from("shared_addressbook_group_members").upsert(member, { onConflict: "group_id,contact_id" })
    if (error) {
      setSaving("failed")
      setMessage(error.message)
      return
    }
    const snapshot = groupExchangeSnapshot(selectedGroup)
    await enqueueExchangeSyncChange({
      action: "update_group_members",
      entityType: "group_members",
      entityId: selectedGroup.id,
      entityAlias: snapshot.Alias,
      displayName: snapshot.GroupName,
      payload: { group: snapshot, addedContact: contactExchangeSnapshot(contact) },
    })
    setMembers((current) => (current.some((item) => item.group_id === member.group_id && item.contact_id === member.contact_id) ? current : [...current, member]))
    setSaving("saved")
  }

  async function removeMember(contactId: string) {
    if (!selectedGroup) return
    const removedContact = contacts.find((contact) => contact.id === contactId) || null
    markExchangeNeedsSync()
    setSaving("saving")
    const { error } = await supabase.from("shared_addressbook_group_members").delete().eq("group_id", selectedGroup.id).eq("contact_id", contactId)
    if (error) {
      setSaving("failed")
      setMessage(error.message)
      return
    }
    const snapshot = groupExchangeSnapshot(selectedGroup)
    await enqueueExchangeSyncChange({
      action: "update_group_members",
      entityType: "group_members",
      entityId: selectedGroup.id,
      entityAlias: snapshot.Alias,
      displayName: snapshot.GroupName,
      payload: {
        group: snapshot,
        removedContact: removedContact ? contactExchangeSnapshot(removedContact) : null,
      },
    })
    setMembers((current) => current.filter((member) => !(member.group_id === selectedGroup.id && member.contact_id === contactId)))
    setSaving("saved")
  }

  function downloadExchangeFiles() {
    downloadText("exchange-contacts.csv", csvContent(exportRows.contactRows, ["SourceBook", "SourceContactId", "DisplayName", "FirstName", "LastName", "Alias", "ExternalEmailAddress", "Nickname"]))
    downloadText("exchange-groups.csv", csvContent(exportRows.groupRows, ["SourceBook", "SourceGroupId", "GroupName", "Alias", "Description", "MemberCount"]))
    downloadText("exchange-group-members.csv", csvContent(exportRows.memberRows, ["SourceBook", "GroupName", "GroupAlias", "MemberDisplayName", "MemberEmail"]))
    downloadText("import-exchange-addressbook.ps1", powerShellContent(), "text/plain;charset=utf-8")
  }

  async function syncExchange() {
    const startedAt = new Date().toISOString()
    setExchangeSyncStartedAt(startedAt)
    setExchangeSyncing(true)
    setExchangeButtonLabel("Syncing")
    try {
      await waitForPendingSaves()
      const missingEmailExamples = latestContacts()
        .filter((contact) => cleanText(contact.display_name) && !cleanText(contact.primary_email))
        .slice(0, 3)
        .map((contact) => contact.display_name)
      if (missingEmailExamples.length > 0) {
        setMessage(`Some contacts have no email address, so Exchange cannot create them. Example: ${missingEmailExamples.join(", ")}`)
      } else {
        setMessage("")
      }
      const response = await fetch("/api/outlook-addressbook/exchange-sync", { method: "POST" })
      const data = await response.json()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${data.message || "Could not queue Exchange sync."}`)
      }
      setExchangeSyncStatus({ webhookConfigured: true, status: data })
      setExchangeSyncStartedAt(data.requestedAt || startedAt)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Could not queue Exchange sync."
      setExchangeSyncStatus({
        webhookConfigured: Boolean(exchangeSyncStatus?.webhookConfigured),
        status: {
          status: "failed",
          message: messageText,
          requestedAt: new Date().toISOString(),
        },
      })
      setMessage(messageText)
      setExchangeButtonLabel("Sync Exchange")
      setExchangeSyncing(false)
      setExchangeSyncStartedAt(null)
    } finally {
    }
  }

  if (authLoading || loading) return <p style={{ padding: "40px" }}>Loading...</p>

  if (!authenticated) {
    return (
      <div style={pageStyle}>
        <section style={{ ...panelStyle, padding: "24px", maxWidth: "560px", margin: "0 auto" }}>
          <h1 style={{ marginTop: 0 }}>Outlook Address Book</h1>
          <p>Please log in from the admin homepage first.</p>
          <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
            Back
          </button>
        </section>
      </div>
    )
  }

  return (
    <div style={pageStyle}>
      <header style={{ maxWidth: "1680px", margin: "0 auto 12px", display: "flex", alignItems: "end", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
        <div>
          <div style={{ color: "var(--fc-accent)", fontSize: "12px", fontWeight: 900, letterSpacing: "0.16em", textTransform: "uppercase" }}>Contact Tools</div>
          <h1 style={{ margin: "4px 0 0", color: "var(--fc-text)", fontSize: "28px", letterSpacing: 0 }}>OUTLOOK ADDRESS BOOK</h1>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button type="button" onClick={syncExchange} style={primaryButtonStyle} disabled={exchangeSyncing}>
            {exchangeButtonLabel}
          </button>
          <button type="button" onClick={() => router.push("/admin")} className="fc-admin-nav-button" style={buttonStyle}>
            Back
          </button>
        </div>
      </header>

      {message ? <div style={{ maxWidth: "1680px", margin: "0 auto 12px", color: "var(--fc-error)", fontWeight: 800 }}>{message}</div> : null}

      <div style={{ maxWidth: "1680px", margin: "0 auto", display: "grid", gridTemplateColumns: isMobile ? "1fr" : "minmax(340px, 1fr) minmax(0, 2fr)", gap: "10px", alignItems: "start" }}>
        <section style={panelStyle}>
          <div style={headerStyle}>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => setActiveView("contacts")}
                style={activeView === "contacts" ? primaryButtonStyle : buttonStyle}
              >
                Contacts
              </button>
              <button
                type="button"
                onClick={() => setActiveView("groups")}
                style={activeView === "groups" ? primaryButtonStyle : buttonStyle}
              >
                Groups
              </button>
            </div>
            <button type="button" onClick={createSelected} style={primaryButtonStyle}>New</button>
          </div>
          <div style={{ padding: "8px", display: "grid", gap: "8px" }}>
            <input
              value={activeSearch}
              onChange={(event) => activeView === "contacts" ? setContactSearch(event.target.value) : setGroupSearch(event.target.value)}
              onFocus={() => activeView === "contacts" ? setContactSearch("") : setGroupSearch("")}
              placeholder={activeView === "contacts" ? "Search contacts" : "Search groups"}
              style={inputStyle}
            />
          </div>
          <div style={{ maxHeight: isMobile ? "360px" : "calc(100vh - 250px)", overflow: "auto", padding: "6px" }}>
            {activeView === "contacts" ? visibleContacts.map((contact) => {
              const active = contact.id === selectedContactId
              return (
                <button
                  key={contact.id}
                  type="button"
                  onClick={() => setSelectedContactId(contact.id)}
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
                  <span style={{ display: "block", fontSize: "13px", fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contact.display_name || contact.primary_email}</span>
                </button>
              )
            }) : visibleGroups.map((group) => {
              const active = group.id === selectedGroupId
              const count = members.filter((member) => member.group_id === group.id).length
              return (
                <button
                  key={group.id}
                  type="button"
                  onClick={() => setSelectedGroupId(group.id)}
                  style={{
                    width: "100%",
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) auto",
                    gap: "8px",
                    alignItems: "center",
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
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "13px", fontWeight: 900 }}>{group.name}</span>
                  <span style={{ borderRadius: "999px", padding: "2px 7px", background: "var(--fc-count-bg)", color: "var(--fc-count-text)", fontSize: "11px", fontWeight: 900 }}>{count}</span>
                </button>
              )
            })}
          </div>
        </section>

        <main style={panelStyle}>
          <div style={headerStyle}>
            <div style={titleStyle}>{activeView === "contacts" ? "Contact Editor" : "Group Editor"}</div>
            <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
              <button type="button" onClick={deleteSelected} style={dangerButtonStyle} disabled={activeView === "contacts" ? !selectedContact : !selectedGroup}>Delete</button>
            </div>
          </div>
          <div style={{ display: "grid", gap: "12px", padding: "12px" }}>
            {activeView === "contacts" ? (
            <section style={{ display: "grid", gap: "10px", maxWidth: "760px" }}>
              <div style={titleStyle}>Contact Details</div>
              {selectedContact ? (
                <>
                  <label><div style={fieldLabelStyle}>Display Name</div><input value={selectedContact.display_name || ""} onChange={(event) => void saveContact({ display_name: event.target.value })} style={inputStyle} /></label>
                  <label><div style={fieldLabelStyle}>Email</div><input value={selectedContact.primary_email || ""} onChange={(event) => void saveContact({ primary_email: event.target.value })} style={inputStyle} /></label>
                  <label><div style={fieldLabelStyle}>Nickname</div><input value={selectedContact.nickname || ""} onChange={(event) => void saveContact({ nickname: event.target.value })} style={inputStyle} /></label>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" }}>
                    <label><div style={fieldLabelStyle}>First Name</div><input value={selectedContact.first_name || ""} onChange={(event) => void saveContact({ first_name: event.target.value })} style={inputStyle} /></label>
                    <label><div style={fieldLabelStyle}>Last Name</div><input value={selectedContact.last_name || ""} onChange={(event) => void saveContact({ last_name: event.target.value })} style={inputStyle} /></label>
                  </div>
                  <label><div style={fieldLabelStyle}>Source Book</div><input value={selectedContact.source_book || ""} onChange={(event) => void saveContact({ source_book: event.target.value })} style={inputStyle} /></label>
                </>
              ) : (
                <div style={{ color: "var(--fc-muted)" }}>Select or create a contact.</div>
              )}
            </section>
            ) : (
            <section style={{ display: "grid", gap: "10px" }}>
              <div style={titleStyle}>Group Details</div>
              {selectedGroup ? (
                <>
                  <label><div style={fieldLabelStyle}>Group Name</div><input value={selectedGroup.name || ""} onChange={(event) => void saveGroup({ name: event.target.value })} style={inputStyle} /></label>
                  <label><div style={fieldLabelStyle}>Nickname / Alias Seed</div><input value={selectedGroup.nickname || ""} onChange={(event) => void saveGroup({ nickname: event.target.value })} style={inputStyle} /></label>
                  <label><div style={fieldLabelStyle}>Description</div><input value={selectedGroup.description || ""} onChange={(event) => void saveGroup({ description: event.target.value })} style={inputStyle} /></label>
                  <label><div style={fieldLabelStyle}>Source Book</div><input value={selectedGroup.source_book || ""} onChange={(event) => void saveGroup({ source_book: event.target.value })} style={inputStyle} /></label>
                  <div style={{ border: "1px solid var(--fc-admin-border-soft)", borderRadius: "12px", padding: "10px", background: "var(--fc-admin-panel-soft-bg)", color: "var(--fc-admin-panel-text)" }}>
                    <div style={{ ...titleStyle, marginBottom: "8px" }}>Members</div>
                    <div style={{ display: "grid", gap: "6px", maxHeight: "180px", overflow: "auto" }}>
                      {selectedGroupMembers.map((contact) => (
                        <div key={contact.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: "8px", alignItems: "center", color: "var(--fc-admin-panel-text)", fontSize: "12px" }}>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{contact.display_name} · {contact.primary_email}</span>
                          <button type="button" onClick={() => void removeMember(contact.id)} style={dangerButtonStyle}>Remove</button>
                        </div>
                      ))}
                    </div>
                    <div style={{ marginTop: "10px", display: "grid", gap: "6px" }}>
                      <input value={addMemberSearch} onChange={(event) => setAddMemberSearch(event.target.value)} placeholder="Search contact to add" style={inputStyle} />
                      <div style={{ display: "grid", gap: "6px", maxHeight: "180px", overflow: "auto" }}>
                        {addableContacts.map((contact) => (
                          <button key={contact.id} type="button" onClick={() => void addMember(contact)} style={{ ...buttonStyle, textAlign: "left", borderRadius: "10px" }}>
                            {contact.display_name} · {contact.primary_email}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ color: "var(--fc-muted)" }}>Select or create a group.</div>
              )}
            </section>
            )}
          </div>
        </main>
      </div>
    </div>
  )
}
