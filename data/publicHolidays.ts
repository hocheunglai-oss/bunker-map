// Reviewed against the official sources below on 2026-10-07. This is a versioned
// reference, not an extrapolation: unpublished/unreviewed years are unavailable.
export const PUBLIC_HOLIDAY_REVISION = "2026-10-07.1"
export const HOLIDAY_COUNTRIES = ["HK", "SG", "TW", "US"] as const
export type HolidayCountry = (typeof HOLIDAY_COUNTRIES)[number]
export type HolidayDefinition = {
  country: HolidayCountry
  year: number
  key: string
  date: string
  name: string
  legacyNames?: string[]
  legacyDates?: string[]
}
type Row = [key: string, date: string, name: string, legacyName?: string]

export const HOLIDAY_SCOPES: Record<HolidayCountry, string> = {
  HK: "Hong Kong general holidays (ordinary Sundays excluded)",
  SG: "Singapore public holidays (Sunday holidays shown on their observed day)",
  TW: "Taiwan government office calendar: named holidays and substitute days, not private-employer closure advice",
  US: "USA federal holidays (observed dates, not state holidays)",
}
export const HOLIDAY_LABELS: Record<HolidayCountry, string> = {
  HK: "HONG KONG", SG: "SINGAPORE", TW: "TAIWAN", US: "USA",
}
export const HOLIDAY_SOURCES: Record<HolidayCountry, Record<number, string[]>> = {
  HK: {
    2026: ["https://www.info.gov.hk/gia/general/202505/16/P2025051300353.htm"],
    2027: ["https://www.info.gov.hk/gia/general/202605/15/P2026051400300.htm"],
  },
  SG: {
    2026: ["https://www.mom.gov.sg/newsroom/press-releases/2025/0616-public-holidays-for-2026", "https://www.mom.gov.sg/employment-practices/public-holidays"],
    2027: ["https://www.mom.gov.sg/newsroom/press-releases/2026/0618-public-holidays-for-2027"],
  },
  TW: {
    2026: ["https://www.dgpa.gov.tw/information?pid=12574&uid=82", "https://www.dgpa.gov.tw/uploads/dgpa/files/202506/a52331bd-a189-466b-b0f0-cae3062bbf74.csv"],
    2027: ["https://www.dgpa.gov.tw/information?pid=12983&uid=2", "https://www.dgpa.gov.tw/uploads/dgpa/files/202607/f538b1ff-ba60-4c63-9477-10db8e6612d1.csv"],
  },
  US: {
    2026: ["https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/"],
    2027: ["https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/"],
  },
}

const rows: Record<HolidayCountry, Record<number, Row[]>> = {
  HK: {
    2026: [
      ["new-year", "01-01", "The first day of January", "New Year's Day"],
      ["lunar-new-year-1", "02-17", "Lunar New Year's Day", "Lunar New Year"],
      ["lunar-new-year-2", "02-18", "The second day of Lunar New Year", "Second day of Lunar New Year"],
      ["lunar-new-year-3", "02-19", "The third day of Lunar New Year", "Third day of Lunar New Year"],
      ["good-friday", "04-03", "Good Friday"],
      ["good-friday-following", "04-04", "The day following Good Friday", "Holy Saturday"],
      ["ching-ming-observed", "04-06", "The day following Ching Ming Festival", "Ching Ming Festival"],
      ["easter-monday-observed", "04-07", "The day following Easter Monday", "Easter Monday"],
      ["labour-day", "05-01", "Labour Day"],
      ["buddha-birthday", "05-25", "The day following the Birthday of the Buddha", "Buddha's Birthday"],
      ["tuen-ng", "06-19", "Tuen Ng Festival", "Dragon Boat Festival"],
      ["hksar-establishment", "07-01", "Hong Kong Special Administrative Region Establishment Day"],
      ["mid-autumn-following", "09-26", "The day following the Chinese Mid-Autumn Festival", "Day following the Mid-Autumn Festival"],
      ["national-day", "10-01", "National Day"],
      ["chung-yeung", "10-19", "The day following Chung Yeung Festival", "Chung Yeung Festival"],
      ["christmas", "12-25", "Christmas Day"],
      ["christmas-following", "12-26", "The first weekday after Christmas Day", "Boxing Day"],
    ],
    2027: [
      ["new-year", "01-01", "The first day of January", "New Year's Day"],
      ["lunar-new-year-1", "02-06", "Lunar New Year's Day", "Lunar New Year"],
      ["lunar-new-year-3", "02-08", "The third day of Lunar New Year", "Second day of Lunar New Year"],
      ["lunar-new-year-4", "02-09", "The fourth day of Lunar New Year", "Third day of Lunar New Year"],
      ["good-friday", "03-26", "Good Friday"],
      ["good-friday-following", "03-27", "The day following Good Friday", "Holy Saturday"],
      ["easter-monday", "03-29", "Easter Monday"],
      ["ching-ming", "04-05", "Ching Ming Festival"],
      ["labour-day", "05-01", "Labour Day"],
      ["buddha-birthday", "05-13", "The Birthday of the Buddha", "Buddha's Birthday"],
      ["tuen-ng", "06-09", "Tuen Ng Festival", "Dragon Boat Festival"],
      ["hksar-establishment", "07-01", "Hong Kong Special Administrative Region Establishment Day"],
      ["mid-autumn-following", "09-16", "The day following the Chinese Mid-Autumn Festival", "Day following the Mid-Autumn Festival"],
      ["national-day", "10-01", "National Day"],
      ["chung-yeung", "10-08", "Chung Yeung Festival"],
      ["christmas", "12-25", "Christmas Day"],
      ["christmas-following", "12-27", "The first weekday after Christmas Day", "Boxing Day"],
    ],
  },
  SG: {
    2026: [
      ["new-year", "01-01", "New Year's Day"], ["chinese-new-year-1", "02-17", "Chinese New Year (day 1)"],
      ["chinese-new-year-2", "02-18", "Chinese New Year (day 2)"], ["hari-raya-puasa", "03-21", "Hari Raya Puasa"],
      ["good-friday", "04-03", "Good Friday"], ["labour-day", "05-01", "Labour Day"],
      ["hari-raya-haji", "05-27", "Hari Raya Haji"], ["vesak", "06-01", "Vesak Day (observed)"],
      ["national-day", "08-10", "National Day (observed)"], ["deepavali", "11-09", "Deepavali (observed)"],
      ["christmas", "12-25", "Christmas Day"],
    ],
    2027: [
      ["new-year", "01-01", "New Year's Day"], ["chinese-new-year-1", "02-06", "Chinese New Year (day 1)"],
      ["chinese-new-year-2", "02-08", "Chinese New Year (day 2, observed)"], ["hari-raya-puasa", "03-10", "Hari Raya Puasa"],
      ["good-friday", "03-26", "Good Friday"], ["labour-day", "05-01", "Labour Day"],
      ["hari-raya-haji", "05-17", "Hari Raya Haji"], ["vesak", "05-20", "Vesak Day"],
      ["national-day", "08-09", "National Day"], ["deepavali", "10-28", "Deepavali"], ["christmas", "12-25", "Christmas Day"],
    ],
  },
  // DGPA named days (remarks populated), including substitute days. Ordinary
  // weekends are excluded. The scope is government offices, not employment law.
  TW: {
    2026: [
      ["new-year", "01-01", "New Year's Day"], ["lunar-eve-eve", "02-15", "Day before Lunar New Year's Eve"],
      ["lunar-eve", "02-16", "Lunar New Year's Eve"], ["lunar-new-year-1", "02-17", "Lunar New Year (day 1)"],
      ["lunar-new-year-2", "02-18", "Lunar New Year (day 2)"], ["lunar-new-year-3", "02-19", "Lunar New Year (day 3)"],
      ["lunar-substitute-1", "02-20", "Lunar New Year substitute day"], ["peace-substitute", "02-27", "Peace Memorial Day (observed)"],
      ["peace", "02-28", "Peace Memorial Day"], ["children-substitute", "04-03", "Children's Day (observed)"],
      ["children", "04-04", "Children's Day"], ["ching-ming", "04-05", "Tomb Sweeping Day"],
      ["ching-ming-substitute", "04-06", "Tomb Sweeping Day (observed)"], ["labour-day", "05-01", "Labour Day"],
      ["dragon-boat", "06-19", "Dragon Boat Festival"], ["mid-autumn", "09-25", "Mid-Autumn Festival"],
      ["teachers", "09-28", "Confucius' Birthday / Teachers' Day"], ["national-substitute", "10-09", "National Day (observed)"],
      ["national", "10-10", "National Day"], ["retrocession", "10-25", "Taiwan Retrocession and Battle of Guningtou Commemoration"],
      ["retrocession-substitute", "10-26", "Taiwan Retrocession and Battle of Guningtou Commemoration (observed)"],
      ["constitution", "12-25", "Constitution Day"],
    ],
    2027: [
      ["new-year", "01-01", "New Year's Day"], ["lunar-eve-eve", "02-04", "Day before Lunar New Year's Eve"],
      ["lunar-eve", "02-05", "Lunar New Year's Eve"], ["lunar-new-year-1", "02-06", "Lunar New Year (day 1)"],
      ["lunar-new-year-2", "02-07", "Lunar New Year (day 2)"], ["lunar-new-year-3", "02-08", "Lunar New Year (day 3)"],
      ["lunar-substitute-1", "02-09", "Lunar New Year substitute day 1"], ["lunar-substitute-2", "02-10", "Lunar New Year substitute day 2"],
      ["peace", "02-28", "Peace Memorial Day"], ["peace-substitute", "03-01", "Peace Memorial Day (observed)"],
      ["children", "04-04", "Children's Day"], ["ching-ming", "04-05", "Tomb Sweeping Day"],
      ["children-substitute", "04-06", "Children's Day (observed)"], ["labour-substitute", "04-30", "Labour Day (observed)"],
      ["labour-day", "05-01", "Labour Day"], ["dragon-boat", "06-09", "Dragon Boat Festival"],
      ["mid-autumn", "09-15", "Mid-Autumn Festival"], ["teachers", "09-28", "Confucius' Birthday / Teachers' Day"],
      ["national", "10-10", "National Day"], ["national-substitute", "10-11", "National Day (observed)"],
      ["retrocession", "10-25", "Taiwan Retrocession and Battle of Guningtou Commemoration"],
      ["constitution-substitute", "12-24", "Constitution Day (observed)"], ["constitution", "12-25", "Constitution Day"],
      ["next-new-year-observed", "12-31", "New Year's Day 2028 (observed)"],
    ],
  },
  US: {
    2026: [
      ["new-year", "01-01", "New Year's Day"], ["mlk", "01-19", "Birthday of Martin Luther King, Jr."],
      ["washington", "02-16", "Washington's Birthday"], ["memorial", "05-25", "Memorial Day"],
      ["juneteenth", "06-19", "Juneteenth National Independence Day"], ["independence", "07-03", "Independence Day (observed)"],
      ["labor", "09-07", "Labor Day"], ["columbus", "10-12", "Columbus Day"], ["veterans", "11-11", "Veterans Day"],
      ["thanksgiving", "11-26", "Thanksgiving Day"], ["christmas", "12-25", "Christmas Day"],
    ],
    2027: [
      ["new-year", "01-01", "New Year's Day"], ["mlk", "01-18", "Birthday of Martin Luther King, Jr."],
      ["washington", "02-15", "Washington's Birthday"], ["memorial", "05-31", "Memorial Day"],
      ["juneteenth", "06-18", "Juneteenth National Independence Day (observed)"], ["independence", "07-05", "Independence Day (observed)"],
      ["labor", "09-06", "Labor Day"], ["columbus", "10-11", "Columbus Day"], ["veterans", "11-11", "Veterans Day"],
      ["thanksgiving", "11-25", "Thanksgiving Day"], ["christmas", "12-24", "Christmas Day (observed)"],
      ["next-new-year-observed", "12-31", "New Year's Day 2028 (observed)"],
    ],
  },
}

export const PUBLIC_HOLIDAY_DEFINITIONS: HolidayDefinition[] = HOLIDAY_COUNTRIES.flatMap((country) =>
  Object.entries(rows[country]).flatMap(([year, definitions]) => definitions.map(([key, date, name, legacyName]) => ({
    country, year: Number(year), key, date: `${year}-${date}`, name,
    legacyNames: legacyName ? [legacyName] : [name],
    legacyDates: country === "SG" && year === "2026" && key === "hari-raya-puasa" ? ["2026-03-20"]
      : country === "SG" && year === "2027" && key === "deepavali" ? ["2027-10-29"] : [],
  }))),
)
