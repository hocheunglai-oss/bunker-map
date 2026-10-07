import type { OfficeCalendarEvent } from "@/data/eventCalendar"
import { HOLIDAY_LABELS, PUBLIC_HOLIDAY_DEFINITIONS, type HolidayCountry } from "@/data/publicHolidays"
import { holidayBaseline, holidayIdentity, legacyHolidayId, type HolidayCalendarEvent, type HolidayCoverage } from "@/lib/holidayCalendar"

function normalizedTags(event: OfficeCalendarEvent) {
  return event.tags.map((tag) => tag.trim().toUpperCase())
}

function isHongKongHoliday(event: OfficeCalendarEvent) {
  const title = event.title.trim().toUpperCase()
  const tags = normalizedTags(event)

  return (
    event.id.toLowerCase().startsWith("public-holiday-hk-") ||
    title.startsWith("HOLIDAY ATTENDANCE") ||
    title === "PUBLIC HOLIDAY - HONG KONG" ||
    (tags.includes("PUBLIC-HOLIDAY") && tags.includes("HK"))
  )
}

function coversImportedHolidayDate(
  current: OfficeCalendarEvent,
  imported: OfficeCalendarEvent,
) {
  return (
    current.startDate <= imported.startDate &&
    current.endDate >= imported.endDate
  )
}

export function mergeImportedEvents<T extends OfficeCalendarEvent>(
  current: T[],
  imported: T[],
) {
  const seen = new Set(
    current.map(
      (event) =>
        `${event.startDate}|${event.endDate}|${event.title.toUpperCase()}`,
    ),
  )
  const seenIds = new Set(current.map((event) => event.id))
  const nextEvents = [...current]

  for (const event of imported) {
    const key = `${event.startDate}|${event.endDate}|${event.title.toUpperCase()}`
    const alreadyHasHongKongHoliday =
      isHongKongHoliday(event) &&
      nextEvents.some(
        (existing) =>
          isHongKongHoliday(existing) &&
          coversImportedHolidayDate(existing, event),
      )

    if (alreadyHasHongKongHoliday || seen.has(key) || seenIds.has(event.id)) {
      continue
    }

    seen.add(key)
    seenIds.add(event.id)
    nextEvents.push(event)
  }

  return nextEvents
}

const importedFields = new Set(["id", "startDate", "endDate", "title", "people", "uncertainPeople", "tags", "eventType", "holidaySource"])
const obsoleteLegacyDates: Partial<Record<HolidayCountry, string[]>> = {
  US: ["2026-02-12", "2026-04-03", "2026-05-08", "2027-02-12", "2027-03-26", "2027-05-08", "2027-12-31"],
}

function untouchedShape(event: OfficeCalendarEvent) {
  return !event.people.length && !(event.uncertainPeople || []).length &&
    Object.keys(event).every((key) => importedFields.has(key)) &&
    (!event.eventType || event.eventType === "Public Holiday")
}

function pristineLegacy(event: OfficeCalendarEvent, country: HolidayCountry, allowedNames: string[] = []) {
  return untouchedShape(event) && event.startDate === event.endDate &&
    event.id === legacyHolidayId(country, event.startDate) &&
    JSON.stringify([...event.tags].sort()) === JSON.stringify(["public-holiday", country].sort()) &&
    (country === "HK"
      ? allowedNames.some((name) => event.title === `HOLIDAY ATTENDANCE - ${name.toUpperCase()}`)
      : event.title === `PUBLIC HOLIDAY - ${HOLIDAY_LABELS[country]}`)
}

function sourceOf(event: OfficeCalendarEvent) {
  const source = (event as Partial<HolidayCalendarEvent>).holidaySource
  return source && typeof source.identity === "string" && typeof source.baseline === "string" &&
    Array.isArray(source.deletionIds) && source.deletionIds.every((id) => typeof id === "string") ? source : null
}

function pristineManaged(event: OfficeCalendarEvent, desired: HolidayCalendarEvent) {
  const source = sourceOf(event)
  return Boolean(source && source.identity === desired.holidaySource.identity &&
    source.country === desired.holidaySource.country && source.year === desired.holidaySource.year &&
    (event.id === desired.id || desired.holidaySource.deletionIds.includes(event.id) || source.deletionIds?.includes(event.id)) &&
    untouchedShape(event) && source.baseline === holidayBaseline(event))
}

function countriesCovered(event: OfficeCalendarEvent): HolidayCountry[] {
  const title = event.title.trim().toUpperCase()
  if (isHongKongHoliday(event)) return ["HK"]
  const result: HolidayCountry[] = []
  for (const country of ["SG", "TW", "US"] as const) {
    if ((normalizedTags(event).includes("PUBLIC-HOLIDAY") && normalizedTags(event).includes(country)) ||
      (/^(PUBLIC|GOVERNMENT|BANK) HOLIDAY\s*-/.test(title) && new RegExp(`\\b${HOLIDAY_LABELS[country]}\\b`).test(title))) result.push(country)
  }
  return result
}

export type HolidayReconciliationPlan = {
  additions: HolidayCalendarEvent[]
  updates: HolidayCalendarEvent[]
  removals: string[]
  preserved: Array<{ id: string; reason: string; reviewRequired: boolean }>
  complete: boolean
}

/** Pure preview. The server commits this plan once with the preview's store CAS.
 * Unknown rows are never deleted. Changed/assigned rows are preserved for review.
 * Both legacy date IDs and stable identities honor intentional deletion markers.
 */
export function planHolidayReconciliation(
  current: OfficeCalendarEvent[], imported: HolidayCalendarEvent[],
  options: { coverage: HolidayCoverage[]; deletedEventIds?: string[] },
): HolidayReconciliationPlan {
  const plan: HolidayReconciliationPlan = { additions: [], updates: [], removals: [], preserved: [],
    complete: options.coverage.length > 0 && options.coverage.every((item) => item.status === "verified") }
  const deleted = new Set(options.deletedEventIds || [])
  const verified = new Set(options.coverage.filter((item) => item.status === "verified").map((item) => `${item.country}-${item.year}`))
  const preservedIds = new Set<string>()
  const recognizedIds = new Set<string>()
  function preserve(event: OfficeCalendarEvent, reason: string, reviewRequired: boolean) {
    if (!preservedIds.has(event.id)) {
      plan.preserved.push({ id: event.id, reason, reviewRequired })
      preservedIds.add(event.id)
    }
    if (reviewRequired) plan.complete = false
  }
  for (const desired of imported) {
    const source = desired.holidaySource
    if (!verified.has(`${source.country}-${source.year}`)) continue
    const definition = PUBLIC_HOLIDAY_DEFINITIONS.find((item) => holidayIdentity(item) === source.identity)
    if (!definition) continue
    const candidates = current.filter((event) => event.id === desired.id ||
      source.deletionIds.includes(event.id) || sourceOf(event)?.identity === source.identity)
    for (const event of candidates) recognizedIds.add(event.id)
    // Never recreate a deleted identity at a new date. An existing counterpart
    // may remain after duplicate cleanup, whose removed copy also has a tombstone.
    if (!candidates.length && source.deletionIds.some((id) => deleted.has(id))) continue
    // A surviving old-date alias is not permission to move back into an
    // explicitly deleted target. Duplicate-cleanup tombstones at an old date
    // must still allow a verified counterpart already present at the target.
    const targetDeleted = deleted.has(desired.id) || deleted.has(legacyHolidayId(source.country, desired.startDate))
    if (targetDeleted && !candidates.some((event) => event.startDate === desired.startDate && event.endDate === desired.endDate)) {
      for (const event of candidates) preserve(event, "The corrected holiday date was previously deleted; the existing entry was kept for review.", true)
      continue
    }
    const pristine = (event: OfficeCalendarEvent) => pristineManaged(event, desired) ||
      pristineLegacy(event, source.country, definition.legacyNames)
    const modified = candidates.filter((event) => !pristine(event))
    for (const event of modified) preserve(event, "Holiday has manual changes or attendance assignments; review it before correcting.", true)
    // Never add another copy beside a manually modified version of this holiday.
    if (modified.length && !candidates.some(pristine)) continue
    const manualCoverage = current.filter((event) => !candidates.includes(event) &&
      countriesCovered(event).includes(source.country) && coversImportedHolidayDate(event, desired))
    const selected = [...candidates].filter(pristine).sort((a, b) =>
      Number(b.startDate === desired.startDate) - Number(a.startDate === desired.startDate) || a.id.localeCompare(b.id))[0]
    if (manualCoverage.length) {
      for (const event of manualCoverage) preserve(event, "Existing holiday entry covers this country and date; it was kept unchanged.", false)
      // Preserve the manual entry; remove only exact, pristine duplicate imports.
      for (const event of candidates.filter(pristine)) plan.removals.push(event.id)
      continue
    }
    if (selected) {
      const next = { ...desired, id: selected.id, holidaySource: { ...source,
        deletionIds: [...new Set([...source.deletionIds, ...(sourceOf(selected)?.deletionIds || []), selected.id])] } }
      next.holidaySource.baseline = holidayBaseline(next)
      if (holidayBaseline(selected) !== holidayBaseline(next) || JSON.stringify(sourceOf(selected)) !== JSON.stringify(next.holidaySource)) plan.updates.push(next)
      for (const duplicate of candidates.filter((event) => event !== selected && pristine(event))) plan.removals.push(duplicate.id)
    } else {
      plan.additions.push(desired)
    }
  }
  for (const [code, dates] of Object.entries(obsoleteLegacyDates)) {
    const country = code as HolidayCountry
    for (const date of dates || []) {
      if (!verified.has(`${country}-${date.slice(0, 4)}`)) continue
      const retiredIdentity = country === "US" && date === "2027-12-31" ? "us-2027-next-new-year-observed" : null
      for (const event of current.filter((item) => item.id === legacyHolidayId(country, date) ||
        (retiredIdentity && sourceOf(item)?.identity === retiredIdentity))) {
        recognizedIds.add(event.id)
        const source = sourceOf(event)
        const pristineRetired = retiredIdentity && source?.identity === retiredIdentity &&
          source.country === country && source.year === 2027 && source.revision === "2026-10-07.1" &&
          event.startDate === date && event.endDate === date &&
          (event.id === `public-holiday-${retiredIdentity}` || source.deletionIds.includes(event.id)) &&
          untouchedShape(event) && source.baseline === holidayBaseline(event)
        if (pristineLegacy(event, country) || pristineRetired) plan.removals.push(event.id)
        else preserve(event, "Former regional/observance entry has manual changes; review it before removing.", true)
      }
    }
  }
  for (const event of current) {
    if (recognizedIds.has(event.id)) continue
    if (event.id.startsWith("public-holiday-") || sourceOf(event)) {
      const code = event.id.match(/^public-holiday-(hk|sg|tw|us)-/i)?.[1]?.toUpperCase()
      const countries = new Set([...countriesCovered(event), ...(code ? [code] : []), ...(sourceOf(event)?.country ? [sourceOf(event)!.country] : [])])
      if ([...countries].some((country) => verified.has(`${country}-${event.startDate.slice(0, 4)}`))) {
        preserve(event, "Imported holiday is not recognized in the verified reference; it was kept for review.", true)
      }
      continue
    }
    for (const country of countriesCovered(event)) {
      if (!verified.has(`${country}-${event.startDate.slice(0, 4)}`)) continue
      if (!imported.some((holiday) => holiday.holidaySource.country === country && coversImportedHolidayDate(event, holiday))) {
        preserve(event, "Manual holiday date is outside the verified reference; it was not changed.", true)
      }
    }
  }
  plan.removals = [...new Set(plan.removals)]
  return plan
}
