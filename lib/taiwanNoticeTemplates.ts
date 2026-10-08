export type TaiwanNoticeTemplate = {
  id: string
  group: string
  label: string
  text: string
  guidance?: string
}

// Reference wording, not live operational status. Historical dates and charges
// deliberately become placeholders so selecting a template cannot publish them.
export const TAIWAN_NOTICE_TEMPLATES: readonly TaiwanNoticeTemplate[] = [
  {
    id: "bao-shan-2026-10", group: "CPC notice · 7 October 2026", label: "Kaohsiung · BAO SHAN NO. 2 · 12–17 October 2026",
    text: "KAOHSIUNG – BUNKER BARGE BAO SHAN NO. 2 WILL BE OUT OF SERVICE FROM 12 TO 17 OCTOBER 2026 DUE TO EQUIPMENT MAINTENANCE.\nBUNKERING CAPACITY WILL BE LIMITED. PLEASE ARRANGE ORDERS EARLY AND ALLOW SUFFICIENT TIME FOR BARGE SCHEDULING.",
    guidance: "CPC notice dated 7 October 2026. Limited Kaohsiung capacity, not a complete delivery suspension. No affected product is specified. Review before use; remove from the report after the affected period.",
  },
  { id: "holiday-day", group: "Holiday notice", label: "No orders · single day", text: "HOLIDAY NOTICE – NO ORDER WILL BE ACCEPTED BY CPC ON [DATE]." },
  { id: "holiday-period", group: "Holiday notice", label: "No orders · date range", text: "HOLIDAY NOTICE – NO ORDER WILL BE ACCEPTED BY CPC FROM [FROM DATE] TO [TO DATE]." },
  { id: "oil-fence-increase", group: "Oil fence charge", label: "Charge increase", text: "EFFECTIVE FROM [EFFECTIVE DATE] (DELY DATE BASIS), OIL FENCE CHARGE WILL BE INCREASED FROM $[OLD CHARGE] TO $[NEW CHARGE]." },
  { id: "oil-fence-charge", group: "Oil fence charge", label: "Applicable charge", text: "EFFECTIVE FROM [EFFECTIVE DATE] (DELY DATE BASIS), OIL FENCE CHARGE $[CHARGE] WILL BE APPLICABLE." },
  { id: "hualien-truck", group: "Hualien", label: "Truck delivery", text: "HUALIEN – DELIVERY WILL BE MADE BY TRUCK UNTIL FURTHER NOTICE AND SUBJECT TO CPC’S RECONFIRMATION." },
  { id: "kaohsiung-if380-maintenance", group: "Kaohsiung · delivery suspension", label: "IF380 S3.5% · barge maintenance", text: "KAOHSIUNG – IF380 S3.5% DELY IS SUSPENDED UNTIL [UNTIL DATE] DUE TO BARGE MAINTENANCE." },
  { id: "kaohsiung-if180-nomination", group: "Kaohsiung · delivery suspension", label: "IF180 S0.5% · no new nominations", text: "KAOHSIUNG – IF180 S0.5% NEW NOMINATION WILL NOT BE ACCEPTED BY CPC UNTIL FURTHER NOTICE." },
  { id: "kaohsiung-if180-pipeline", group: "Kaohsiung · delivery suspension", label: "IF180 S0.5% · pipeline maintenance", text: "KAOHSIUNG – IF180 S0.5% DELY WILL BE SUSPENDED FROM [FROM DATE] TO [TO DATE] DUE TO PIPELINE MAINTENANCE." },
  { id: "kaohsiung-mgo-kict", group: "Kaohsiung · delivery suspension", label: "MGO · KICT S01–S19", text: "KAOHSIUNG – MGO DELY AT KICT S01-S19 IS SUSPENDED UNTIL FURTHER NOTICE." },
  { id: "kaohsiung-one-barge", group: "Kaohsiung · tight barge availability", label: "One IFO barge and one MGO barge", text: "KAOHSIUNG – ONLY ONE IFO BARGE AND ONE MGO BARGE ARE AVAILABLE UNTIL FURTHER NOTICE. ORDERS WILL BE SUBJECT TO CPC’S RECONFIRMATION." },
  { id: "kaohsiung-mgo-delay", group: "Kaohsiung · tight barge availability", label: "MGO orders · possible delivery delay", text: "KAOHSIUNG – DUE TO TIGHT BARGE AVAILABILITY, ORDERS WITH MGO WILL BE SUBJECT TO CPC’S RECONFIRMATION AND DELY WILL BE SUBJECT TO DELAY." },
  { id: "kaohsiung-ifo-tight", group: "Kaohsiung · tight product availability", label: "IFO availability", text: "KAOHSIUNG – IFO AVAILABILITY IS CURRENTLY TIGHT. ORDERS ARE SUBJECT TO CPC’S RECONFIRMATION." },
  { id: "keelung-one-barge", group: "Keelung", label: "Only one barge in service", text: "KEELUNG – DELIVERY WILL BE PERFORMED BY ONLY ONE BARGE [PERIOD]." },
  { id: "keelung-if380-tight", group: "Keelung", label: "IF380 tight · possible IF180 substitution", text: "KEELUNG – IF380 AVAILABILITY IS CURRENTLY TIGHT. VESSELS MAY BE SUPPLIED WITH IF180 PRODUCT UNTIL [UNTIL DATE]." },
  { id: "keelung-ifo-tight", group: "Keelung", label: "IFO availability", text: "KEELUNG – IFO AVAILABILITY IS CURRENTLY TIGHT. ORDERS ARE SUBJECT TO CPC’S RECONFIRMATION." },
  { id: "suao-truck", group: "Suao", label: "Barge suspension · truck delivery", text: "SUAO – DELIVERY WILL BE MADE BY TRUCK FROM [FROM DATE] UNTIL FURTHER NOTICE AND SUBJECT TO CPC’S RECONFIRMATION." },
  { id: "suao-pipeline", group: "Suao", label: "Pipeline maintenance", text: "SUAO – DUE TO PIPELINE MAINTENANCE, PROMPT DELIVERY WILL BE SUBJECT TO CPC’S RECONFIRMATION." },
  { id: "taichung-if180-repairs", group: "Taichung", label: "IF180 S0.5% · urgent repairs", text: "TAICHUNG – IF180 S0.5% DELIVERY IS SUSPENDED UNTIL FURTHER NOTICE DUE TO URGENT REPAIRS." },
]

export const TAIWAN_NOTICE_TEMPLATE_GROUPS = [...new Set(TAIWAN_NOTICE_TEMPLATES.map((item) => item.group))]

export function validateTaiwanNoticeDraft(text: string): string | null {
  if (!text.trim()) return "Enter the notice wording first."
  if (/\[(?:DATE|FROM DATE|TO DATE|EFFECTIVE DATE|UNTIL DATE|OLD CHARGE|NEW CHARGE|CHARGE|PERIOD)\]|DD\/MM\/(?:YYYY|YY)/i.test(text)) {
    return "Replace the date, period or charge placeholders before adding or saving the notice."
  }
  return null
}

/** Append only new lines; preserve the current draft and its paragraph breaks. */
export function appendTaiwanNotice(current: string, draft: string) {
  const existing = new Set(current.split(/\r?\n/).map((line) => line.trim().toUpperCase()).filter(Boolean))
  const additions = draft.split(/\r?\n/).map((line) => line.trim()).filter((line) => {
    if (!line || existing.has(line.toUpperCase())) return false
    existing.add(line.toUpperCase())
    return true
  })
  return {
    text: additions.length ? [current.trimEnd(), additions.join("\n")].filter(Boolean).join("\n") : current,
    added: additions.length,
  }
}
