import fs from "node:fs"
import path from "node:path"
import { createClient } from "@supabase/supabase-js"

const PROJECT_ROOT = process.cwd()
const DEFAULT_BASE_URL = "http://192.168.1.100:81/cistem"
const DEFAULT_USERNAME = "admin"
const DEFAULT_PASSWORD = "admin"
const LIST_PAGE_SIZE = 20

function loadEnv() {
  return Object.fromEntries(
    fs
      .readFileSync(path.join(PROJECT_ROOT, ".env.local"), "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((line) => !line.trim().startsWith("#"))
      .map((line) => {
        const idx = line.indexOf("=")
        return [line.slice(0, idx).trim(), line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "")]
      }),
  )
}

function normalizeText(value) {
  return (value || "").trim()
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie()
  const value = headers.get("set-cookie")
  return value ? [value] : []
}

async function loginAndAuthenticate(baseUrl, username, password) {
  const loginUrl = `${baseUrl.replace(/\/$/, "")}/login.php`
  const root = baseUrl.replace(/\/$/, "")
  const loginBody = new URLSearchParams({ username, password, type: "" })
  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: loginBody.toString(),
    redirect: "manual",
  })

  if (!loginResponse.ok && loginResponse.status !== 302) {
    throw new Error(`Cistem login failed with status ${loginResponse.status}.`)
  }

  const cookies = getSetCookies(loginResponse.headers)
    .map((cookie) => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ")

  if (!cookies) throw new Error("Cistem login did not return a session cookie.")
  return { cookies, root }
}

function decodeHtml(value) {
  return (value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\r/g, "")
}

function stripTags(value) {
  return decodeHtml((value || "").replace(/<[^>]+>/g, ""))
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function matchInputValue(html, name) {
  const regex = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, "i")
  const match = html.match(regex)
  return decodeHtml(match?.[1] || "").trim()
}

function matchTextareaValue(html, name) {
  const regex = new RegExp(`<textarea[^>]*name="${name}"[^>]*>([\\s\\S]*?)<\\/textarea>`, "i")
  const match = html.match(regex)
  return stripTags(match?.[1] || "")
}

function matchSelectedOptionValue(html, selectName) {
  const selectRegex = new RegExp(`<select[^>]*name="${selectName}"[\\s\\S]*?<\\/select>`, "i")
  const selectMatch = html.match(selectRegex)
  if (!selectMatch) return ""
  const optionMatch = selectMatch[0].match(/<option value="([^"]*)"[^>]*selected="selected"/i)
  return decodeHtml(optionMatch?.[1] || "").trim()
}

function matchCheckedRadioValue(html, name) {
  const regex = new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"[^>]*checked(?:="checked")?`, "i")
  const match = html.match(regex)
  return decodeHtml(match?.[1] || "").trim()
}

function buildCompanyPhone(parts) {
  return parts.filter(Boolean).join(" ").trim() || null
}

function compactLines(lines) {
  return (
    lines
      .map((line) => line.trim())
      .filter(Boolean)
      .join("\n")
      .trim() || null
  )
}

function parseTotalRecords(html) {
  const match = html.match(/Records&nbsp;\d+&nbsp;to&nbsp;\d+&nbsp;of&nbsp;(\d+)/i)
  return Number(match?.[1] || "0")
}

function extractCompanyIds(html) {
  return Array.from(
    new Set(
      [...html.matchAll(/OpenUpdateCompany\((\d+)\)/g)]
        .map((match) => Number(match[1]))
        .filter((id) => id > 0),
    ),
  )
}

function stripTitleAndRemark(text) {
  const cleaned = normalizeText(text)
  const match = cleaned.match(/^(MR|MS|CP)\s+(.*?)(?:\s+\(([^)]+)\))?$/i)
  if (!match) {
    return { title: null, fullName: cleaned, nameRemark: null }
  }
  return {
    title: match[1].toUpperCase(),
    fullName: normalizeText(match[2]),
    nameRemark: normalizeText(match[3] || "") || null,
  }
}

function parseClipContact(line) {
  const text = normalizeText(line)
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return { email: emailMatch?.[0] || null }
}

function extractContactsTable(html) {
  const contactsCellMatch = html.match(
    /<td style="width: 600px; white-space: nowrap;"><span id="el\d+_v_contacts_contacts"[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i,
  )
  const tableHtml = contactsCellMatch?.[1] || ""
  const rows = [
    ...tableHtml.matchAll(
      /<tr><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><td[^>]*>([\s\S]*?)<\/td><\/tr>/g,
    ),
  ]
  return rows.map((match) => ({
    name: stripTags(match[1]),
    ext: stripTags(match[2]),
    direct: stripTags(match[3]),
    mobile1: stripTags(match[4]),
    mobile2: stripTags(match[5]),
  }))
}

function extractCompanyRowBlocks(html) {
  const marker = '<tr data-rowindex="'
  const startIndex = html.indexOf(marker)
  if (startIndex < 0) return []
  const tbodyStart = html.slice(startIndex)
  return tbodyStart
    .split(marker)
    .slice(1)
    .map((part) => `${marker}${part}`)
}

function companySourceKey(name) {
  return (name || "").trim().toLowerCase()
}

function buildContactSourceKey(row) {
  return [
    row.company_source_id || "",
    row.full_name || "",
    row.general_email || "",
    row.direct_line || "",
    row.mobile_1 || "",
  ]
    .join("|")
    .toLowerCase()
}

function parseContactsFromCompanyRow(rowHtml) {
  const companyIdMatch = rowHtml.match(/OpenUpdateCompany\((\d+)\)/)
  const companyId = companyIdMatch?.[1] || ""
  const companyName = stripTags((rowHtml.match(/OpenUpdateCompany\(\d+\)">([\s\S]*?)<\/a>/) || [])[1] || "")
  const clipValue = decodeHtml((rowHtml.match(/<input id='CLIP_\d+' type='hidden' value='([^']*)'/) || [])[1] || "")
  const clipParts = clipValue.split("!x!").map((part) => normalizeText(part)).filter(Boolean)
  const clipContacts = clipParts.filter((part) => /^(MR|MS|CP)\b/i.test(part))
  const visibleContacts = extractContactsTable(rowHtml)

  return visibleContacts.map((contact, index) => {
    const parsedName = stripTitleAndRemark(contact.name)
    const clipContact = parseClipContact(clipContacts[index] || "")
    const row = {
      full_name: parsedName.fullName || contact.name,
      company: companyName || null,
      company_source_id: companyId || null,
      title: parsedName.title,
      name_remark: parsedName.nameRemark,
      tel_ext: normalizeText(contact.ext) || null,
      direct_line: normalizeText(contact.direct) || null,
      mobile_1: normalizeText(contact.mobile1) || null,
      mobile_2: normalizeText(contact.mobile2) || null,
      general_email: clipContact.email,
    }
    return { ...row, source_key: buildContactSourceKey(row) }
  })
}

async function fetchText(url, cookies) {
  const response = await fetch(url, { headers: { Cookie: cookies } })
  if (!response.ok) throw new Error(`Request failed (${response.status}) for ${url}`)
  return response.text()
}

async function collectCompaniesAndContacts(root, cookies) {
  const firstPageHtml = await fetchText(`${root}/v_contactslist.php`, cookies)
  const totalRecords = parseTotalRecords(firstPageHtml)
  if (totalRecords <= 0) throw new Error("Unable to determine total company records.")

  const companyIds = new Set(extractCompanyIds(firstPageHtml))
  const contacts = []
  for (const rowHtml of extractCompanyRowBlocks(firstPageHtml)) contacts.push(...parseContactsFromCompanyRow(rowHtml))

  for (let start = 1; start <= totalRecords; start += LIST_PAGE_SIZE) {
    const html = start === 1 ? firstPageHtml : await fetchText(`${root}/v_contactslist.php?start=${start}`, cookies)
    for (const id of extractCompanyIds(html)) companyIds.add(id)
    if (start !== 1) {
      for (const rowHtml of extractCompanyRowBlocks(html)) contacts.push(...parseContactsFromCompanyRow(rowHtml))
    }
    if (start === 1 || start % 200 === 1 || start + LIST_PAGE_SIZE > totalRecords) {
      console.log(`Scanned contact pages through row ${Math.min(start + LIST_PAGE_SIZE - 1, totalRecords)}/${totalRecords}`)
    }
  }

  return {
    companyIds: Array.from(companyIds),
    contacts: Array.from(new Map(contacts.map((row) => [row.source_key, row])).values()),
  }
}

function parseCompanyDetails(html) {
  const name = matchInputValue(html, "x_company_name")
  const otherName = matchInputValue(html, "x_company_other_name")
  const address = matchTextareaValue(html, "x_company_addr")
  const country = matchSelectedOptionValue(html, "x_company_addr_country")
  const telCountry = matchInputValue(html, "x_company_tel_country")
  const telArea = matchInputValue(html, "x_company_tel_area")
  const tel1 = matchInputValue(html, "x_company_tel_no_1")
  const tel2 = matchInputValue(html, "x_company_tel_no_2")
  const speedDial = matchSelectedOptionValue(html, "x_company_tel_speeddial")
  const fax = matchInputValue(html, "x_company_fax_no_1")
  const website = matchInputValue(html, "x_company_website")
  const email = matchInputValue(html, "x_company_email")
  const remarks = matchTextareaValue(html, "x_company_info")
  const contactType = matchCheckedRadioValue(html, "x_company_type")
  const stemManagement = matchCheckedRadioValue(html, "x_company_for_bunker_prog")
  const companyStatus = matchCheckedRadioValue(html, "x_company_status")
  const sellerTerm = matchInputValue(html, "x_seller_term")
  const sellerCreditLimit = matchInputValue(html, "x_seller_credit_limit")
  const sellerCreditLimitFlexibility = matchInputValue(html, "x_seller_credit_limit_flexibility")
  const sellerClassification = matchInputValue(html, "x_seller_classification")
  const sellerRemark1 = matchTextareaValue(html, "x_seller_remark_1")
  const sellerRemark2 = matchTextareaValue(html, "x_seller_remark_2")
  const sellerRemark3 = matchTextareaValue(html, "x_seller_remark_3")
  const sellerRemark4 = matchTextareaValue(html, "x_seller_remark_4")
  const buyerTerm = matchInputValue(html, "x_buyer_term")
  const buyerCreditLimit = matchInputValue(html, "x_buyer_credit_limit")
  const buyerCreditLimitFlexibility = matchInputValue(html, "x_buyer_credit_limit_flexibility")
  const buyerClassification = matchInputValue(html, "x_buyer_classification")
  const buyerRemark1 = matchTextareaValue(html, "x_buyer_remark_1")
  const buyerRemark2 = matchTextareaValue(html, "x_buyer_remark_2")
  const buyerRemark3 = matchTextareaValue(html, "x_buyer_remark_3")
  const buyerRemark4 = matchTextareaValue(html, "x_buyer_remark_4")

  return {
    name,
    other_name: otherName || null,
    phone: buildCompanyPhone([telCountry, telArea, tel1].filter(Boolean)),
    address: compactLines([address].filter(Boolean)),
    country: country || null,
    tel_country: telCountry || null,
    tel_area: telArea || null,
    tel_no_1: tel1 || null,
    tel_no_2: tel2 || null,
    tel_speed_dial: speedDial || null,
    fax_no_1: fax || null,
    website: website || null,
    email: email || null,
    contact_type: contactType || null,
    stem_management: stemManagement || null,
    company_status: companyStatus || null,
    company_info: remarks || null,
    seller_term: sellerTerm || null,
    seller_credit_limit: sellerCreditLimit || null,
    seller_credit_limit_flexibility: sellerCreditLimitFlexibility || null,
    seller_classification: sellerClassification || null,
    seller_remark_1: sellerRemark1 || null,
    seller_remark_2: sellerRemark2 || null,
    seller_remark_3: sellerRemark3 || null,
    seller_remark_4: sellerRemark4 || null,
    buyer_term: buyerTerm || null,
    buyer_credit_limit: buyerCreditLimit || null,
    buyer_credit_limit_flexibility: buyerCreditLimitFlexibility || null,
    buyer_classification: buyerClassification || null,
    buyer_remark_1: buyerRemark1 || null,
    buyer_remark_2: buyerRemark2 || null,
    buyer_remark_3: buyerRemark3 || null,
    buyer_remark_4: buyerRemark4 || null,
    source_key: companySourceKey(name),
  }
}

async function collectCompanyDetails(root, cookies, companyIds) {
  const results = []
  const concurrency = 8
  let index = 0

  async function worker() {
    while (index < companyIds.length) {
      const currentIndex = index
      index += 1
      const companyId = companyIds[currentIndex]
      const html = await fetchText(`${root}/companyedit.php?company_id=${companyId}`, cookies)
      const company = parseCompanyDetails(html)
      if (company.name) results.push(company)
      if ((currentIndex + 1) % 100 === 0 || currentIndex + 1 === companyIds.length) {
        console.log(`Fetched company details ${currentIndex + 1}/${companyIds.length}`)
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return Array.from(new Map(results.map((company) => [company.source_key, company])).values())
}

async function fetchAllSupabaseRows(supabase, table, orderColumn) {
  const rows = []
  const pageSize = 1000
  let from = 0
  while (true) {
    const query = supabase.from(table).select("*").range(from, from + pageSize - 1)
    const result = orderColumn ? await query.order(orderColumn, { ascending: true }) : await query
    if (result.error) throw result.error
    const batch = result.data || []
    rows.push(...batch)
    if (batch.length < pageSize) break
    from += pageSize
  }
  return rows
}

function compareFields(label, source, target, fields) {
  const diffs = []
  for (const field of fields) {
    const left = normalizeText(source[field] ?? "")
    const right = normalizeText(target[field] ?? "")
    if (left !== right) {
      diffs.push({ field, source: left || null, phonebook: right || null })
    }
  }
  return { label, diffs }
}

function takeExamples(items, count = 10) {
  return items.slice(0, count)
}

async function main() {
  const env = loadEnv()
  const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
  const { cookies, root } = await loginAndAuthenticate(
    env.CISTEM_BASE_URL || DEFAULT_BASE_URL,
    env.CISTEM_USERNAME || DEFAULT_USERNAME,
    env.CISTEM_PASSWORD || DEFAULT_PASSWORD,
  )

  const [phonebookCompanies, phonebookContacts] = await Promise.all([
    fetchAllSupabaseRows(supabase, "phonebook_companies", "name"),
    fetchAllSupabaseRows(supabase, "phonebook_contacts", "full_name"),
  ])
  console.log(`Loaded phonebook rows: ${phonebookCompanies.length} companies, ${phonebookContacts.length} contacts`)

  const { companyIds, contacts: sourceContacts } = await collectCompaniesAndContacts(root, cookies)
  console.log(`Loaded source contacts: ${sourceContacts.length} contacts across ${companyIds.length} companies`)
  const sourceCompanies = await collectCompanyDetails(root, cookies, companyIds)
  console.log(`Loaded source companies: ${sourceCompanies.length}`)

  const companyFields = [
    "name",
    "other_name",
    "phone",
    "address",
    "country",
    "tel_country",
    "tel_area",
    "tel_no_1",
    "tel_no_2",
    "tel_speed_dial",
    "fax_no_1",
    "website",
    "email",
    "contact_type",
    "stem_management",
    "company_status",
    "company_info",
    "seller_term",
    "seller_credit_limit",
    "seller_credit_limit_flexibility",
    "seller_classification",
    "seller_remark_1",
    "seller_remark_2",
    "seller_remark_3",
    "seller_remark_4",
    "buyer_term",
    "buyer_credit_limit",
    "buyer_credit_limit_flexibility",
    "buyer_classification",
    "buyer_remark_1",
    "buyer_remark_2",
    "buyer_remark_3",
    "buyer_remark_4",
  ]

  const contactFields = [
    "full_name",
    "company",
    "company_source_id",
    "title",
    "name_remark",
    "tel_ext",
    "direct_line",
    "mobile_1",
    "mobile_2",
    "general_email",
  ]

  const sourceCompaniesByKey = new Map(sourceCompanies.map((row) => [row.source_key, row]))
  const phonebookCompaniesByKey = new Map(phonebookCompanies.map((row) => [row.source_key, row]))
  const sourceContactsByKey = new Map(sourceContacts.map((row) => [row.source_key, row]))
  const phonebookContactsByKey = new Map(phonebookContacts.map((row) => [row.source_key, row]))

  const missingCompaniesInPhonebook = sourceCompanies.filter((row) => !phonebookCompaniesByKey.has(row.source_key))
  const extraCompaniesInPhonebook = phonebookCompanies.filter((row) => !sourceCompaniesByKey.has(row.source_key))
  const missingContactsInPhonebook = sourceContacts.filter((row) => !phonebookContactsByKey.has(row.source_key))
  const extraContactsInPhonebook = phonebookContacts.filter((row) => !sourceContactsByKey.has(row.source_key))

  const companyDiffs = []
  for (const source of sourceCompanies) {
    const target = phonebookCompaniesByKey.get(source.source_key)
    if (!target) continue
    const result = compareFields(source.name, source, target, companyFields)
    if (result.diffs.length > 0) companyDiffs.push(result)
  }

  const contactDiffs = []
  for (const source of sourceContacts) {
    const target = phonebookContactsByKey.get(source.source_key)
    if (!target) continue
    const result = compareFields(`${source.full_name} @ ${source.company}`, source, target, contactFields)
    if (result.diffs.length > 0) contactDiffs.push(result)
  }

  const report = {
    generated_at: new Date().toISOString(),
    counts: {
      source_companies: sourceCompanies.length,
      phonebook_companies: phonebookCompanies.length,
      source_contacts: sourceContacts.length,
      phonebook_contacts: phonebookContacts.length,
    },
    missing_companies_in_phonebook: missingCompaniesInPhonebook.length,
    extra_companies_in_phonebook: extraCompaniesInPhonebook.length,
    mismatched_companies: companyDiffs.length,
    missing_contacts_in_phonebook: missingContactsInPhonebook.length,
    extra_contacts_in_phonebook: extraContactsInPhonebook.length,
    mismatched_contacts: contactDiffs.length,
    examples: {
      missing_companies_in_phonebook: takeExamples(missingCompaniesInPhonebook.map((row) => row.name)),
      extra_companies_in_phonebook: takeExamples(extraCompaniesInPhonebook.map((row) => row.name)),
      company_differences: takeExamples(companyDiffs, 15),
      missing_contacts_in_phonebook: takeExamples(
        missingContactsInPhonebook.map((row) => `${row.full_name} @ ${row.company || "No Company"}`),
      ),
      extra_contacts_in_phonebook: takeExamples(
        extraContactsInPhonebook.map((row) => `${row.full_name} @ ${row.company || "No Company"}`),
      ),
      contact_differences: takeExamples(contactDiffs, 15),
    },
  }

  const outputPath = path.join(PROJECT_ROOT, "notes", "phonebook-audit.json")
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2))

  console.log(JSON.stringify(report, null, 2))
  console.log(`\nAudit report written to ${outputPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
