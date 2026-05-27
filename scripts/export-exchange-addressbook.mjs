import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const OUTPUT_DIR = path.join(process.cwd(), "exports", "exchange-addressbook")
const PILOT_OUTPUT_DIR = path.join(process.cwd(), "exports", "exchange-addressbook-pilot")
const CONTACTS_FILE = path.join(OUTPUT_DIR, "exchange-contacts.csv")
const GROUPS_FILE = path.join(OUTPUT_DIR, "exchange-groups.csv")
const MEMBERS_FILE = path.join(OUTPUT_DIR, "exchange-group-members.csv")
const POWERSHELL_FILE = path.join(OUTPUT_DIR, "import-exchange-addressbook.ps1")
const DEFAULT_INTERNAL_DOMAINS = ["cosulich.com.hk", "cosulich.com.sg"]

function loadDotEnvLocal() {
  const file = path.join(process.cwd(), ".env.local")
  if (!fs.existsSync(file)) return
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const equalIndex = trimmed.indexOf("=")
    if (equalIndex === -1) continue
    const key = trimmed.slice(0, equalIndex).trim()
    const rawValue = trimmed.slice(equalIndex + 1).trim()
    if (!key || process.env[key]) continue
    process.env[key] = rawValue.replace(/^["']|["']$/g, "")
  }
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing ${name}.`)
  return value
}

async function loadAll(supabase, table, orderColumn) {
  const rows = []
  const pageSize = 1000
  let from = 0

  while (true) {
    const query = supabase
      .from(table)
      .select("*")
      .range(from, from + pageSize - 1)

    if (orderColumn) query.order(orderColumn, { ascending: true })

    const { data, error } = await query
    if (error) throw new Error(`${table} load failed: ${error.message}`)

    rows.push(...(data || []))
    if (!data || data.length < pageSize) break
    from += pageSize
  }

  return rows
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
}

function exchangeAlias(value, fallback) {
  const base = cleanText(value || fallback)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 58)

  return base || fallback
}

function uniqueAlias(baseAlias, seenAliases) {
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

function internalDomains() {
  return String(process.env.EXCHANGE_INTERNAL_DOMAINS || DEFAULT_INTERNAL_DOMAINS.join(","))
    .split(",")
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

function emailDomain(email) {
  return cleanText(email).toLowerCase().split("@").pop() || ""
}

function csvEscape(value) {
  const text = String(value ?? "")
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`
  return text
}

function writeCsv(file, rows, headers) {
  const content = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(",")),
  ].join("\n")

  fs.writeFileSync(file, `${content}\n`, "utf8")
}

function firstNameFrom(contact) {
  return cleanText(contact.first_name)
}

function lastNameFrom(contact) {
  return cleanText(contact.last_name)
}

function displayNameFrom(contact) {
  return cleanText(contact.display_name || [contact.first_name, contact.last_name].filter(Boolean).join(" ") || contact.primary_email)
}

function buildContactRows(contacts) {
  const seenEmails = new Set()
  const seenAliases = new Set()
  const rows = []
  const contactById = new Map()
  const internalDomainSet = new Set(internalDomains())

  for (const contact of contacts) {
    const email = cleanText(contact.primary_email).toLowerCase()
    if (!email || seenEmails.has(email)) continue

    const displayName = displayNameFrom(contact)
    const aliasSeed = contact.nickname || displayName || email.split("@")[0]
    const alias = uniqueAlias(exchangeAlias(aliasSeed, `contact-${rows.length + 1}`), seenAliases)
    const row = {
      SourceBook: cleanText(contact.source_book),
      SourceContactId: contact.id,
      DisplayName: displayName,
      FirstName: firstNameFrom(contact),
      LastName: lastNameFrom(contact),
      Alias: alias,
      ExternalEmailAddress: email,
      Nickname: cleanText(contact.nickname),
    }

    if (!internalDomainSet.has(emailDomain(email))) rows.push(row)
    seenEmails.add(email)
    contactById.set(contact.id, row)
  }

  return { rows, contactById }
}

function buildGroupRows(groups) {
  const seenAliases = new Set()
  return groups
    .filter((group) => Number(group.member_count || 0) > 0)
    .map((group, index) => {
      const name = cleanText(group.name || group.nickname || group.source_uid)
      const aliasSeed = group.nickname || name
      return {
        SourceBook: cleanText(group.source_book),
        SourceGroupId: group.id,
        GroupName: name,
        Alias: uniqueAlias(exchangeAlias(aliasSeed, `group-${index + 1}`), seenAliases),
        Description: cleanText(group.description),
        MemberCount: Number(group.member_count || 0),
      }
    })
}

function buildMemberRows(groupRows, members, contactById) {
  const groupById = new Map(groupRows.map((group) => [group.SourceGroupId, group]))
  const seen = new Set()
  const rows = []

  for (const member of members) {
    const group = groupById.get(member.group_id)
    const contact = contactById.get(member.contact_id)
    if (!group || !contact) continue

    const key = `${group.Alias}\u0000${contact.ExternalEmailAddress}`
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      SourceBook: cleanText(member.source_book),
      GroupName: group.GroupName,
      GroupAlias: group.Alias,
      MemberDisplayName: contact.DisplayName,
      MemberEmail: contact.ExternalEmailAddress,
    })
  }

  return rows
}

function writePowerShell(file = POWERSHELL_FILE) {
  const content = String.raw`param(
  [string]$ContactsCsv = ".\exchange-contacts.csv",
  [string]$GroupsCsv = ".\exchange-groups.csv",
  [string]$MembersCsv = ".\exchange-group-members.csv"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) {
  Install-Module ExchangeOnlineManagement -Scope CurrentUser
}

Import-Module ExchangeOnlineManagement
Write-Host "If not connected yet, run: Connect-ExchangeOnline -UserPrincipalName admin@yourdomain.com"

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

  fs.writeFileSync(file, `${content}\n`, "utf8")
}

function writeExchangeFiles(outputDir, contactRows, groupRows, memberRows) {
  fs.mkdirSync(outputDir, { recursive: true })
  writeCsv(path.join(outputDir, "exchange-contacts.csv"), contactRows, [
    "SourceBook",
    "SourceContactId",
    "DisplayName",
    "FirstName",
    "LastName",
    "Alias",
    "ExternalEmailAddress",
    "Nickname",
  ])
  writeCsv(path.join(outputDir, "exchange-groups.csv"), groupRows, [
    "SourceBook",
    "SourceGroupId",
    "GroupName",
    "Alias",
    "Description",
    "MemberCount",
  ])
  writeCsv(path.join(outputDir, "exchange-group-members.csv"), memberRows, [
    "SourceBook",
    "GroupName",
    "GroupAlias",
    "MemberDisplayName",
    "MemberEmail",
  ])
  writePowerShell(path.join(outputDir, "import-exchange-addressbook.ps1"))
}

function buildPilotRows(contactRows, groupRows, memberRows) {
  const externalEmails = new Set(contactRows.map((contact) => contact.ExternalEmailAddress))
  const groupsWithExportedMembers = groupRows
    .map((group) => ({
      group,
      members: memberRows.filter((member) => member.GroupAlias === group.Alias),
    }))
    .filter((item) => item.members.some((member) => externalEmails.has(member.MemberEmail)))

  const pilot =
    groupsWithExportedMembers.find((item) => item.members.length >= 2) ||
    groupsWithExportedMembers[0]

  if (!pilot) {
    return { contactRows: [], groupRows: [], memberRows: [] }
  }

  const pilotGroup = {
    ...pilot.group,
    MemberCount: pilot.members.length,
  }
  const pilotMembers = pilot.members
  const memberEmails = new Set(pilotMembers.map((member) => member.MemberEmail))
  const pilotContacts = contactRows.filter((contact) => memberEmails.has(contact.ExternalEmailAddress))

  return {
    contactRows: pilotContacts,
    groupRows: [pilotGroup],
    memberRows: pilotMembers,
  }
}

async function main() {
  loadDotEnvLocal()
  const supabase = createClient(requireEnv("NEXT_PUBLIC_SUPABASE_URL"), requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"))

  const [contacts, groups, members] = await Promise.all([
    loadAll(supabase, "shared_addressbook_contacts", "display_name"),
    loadAll(supabase, "shared_addressbook_groups", "name"),
    loadAll(supabase, "shared_addressbook_group_members", "source_book"),
  ])

  const { rows: contactRows, contactById } = buildContactRows(contacts)
  const groupRows = buildGroupRows(groups)
  const memberRows = buildMemberRows(groupRows, members, contactById)
  const exportedMemberCounts = memberRows.reduce((counts, member) => {
    counts.set(member.GroupAlias, (counts.get(member.GroupAlias) || 0) + 1)
    return counts
  }, new Map())
  const exchangeGroupRows = groupRows.map((group) => ({
    ...group,
    MemberCount: exportedMemberCounts.get(group.Alias) || 0,
  }))

  writeExchangeFiles(OUTPUT_DIR, contactRows, exchangeGroupRows, memberRows)
  const pilotRows = buildPilotRows(contactRows, exchangeGroupRows, memberRows)
  writeExchangeFiles(PILOT_OUTPUT_DIR, pilotRows.contactRows, pilotRows.groupRows, pilotRows.memberRows)

  console.log(JSON.stringify({
    sourceContacts: contacts.length,
    exportedContacts: contactRows.length,
    sourceGroups: groups.length,
    exportedGroups: exchangeGroupRows.length,
    sourceGroupMembers: members.length,
    exportedGroupMembers: memberRows.length,
    outputDir: OUTPUT_DIR,
    pilot: {
      exportedContacts: pilotRows.contactRows.length,
      exportedGroups: pilotRows.groupRows.length,
      exportedGroupMembers: pilotRows.memberRows.length,
      outputDir: PILOT_OUTPUT_DIR,
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
