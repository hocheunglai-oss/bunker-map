export const defaultEventCalendarPeople = ["VL", "SC", "OL", "DT", "KZ", "CY", "MY", "LC", "LL", "JZ"]

export function normalizeEventCalendarPeople(value: string[]) {
  return [...new Set(value.map((item) => item.trim().toUpperCase()).filter((item) => item && item !== "??"))]
}
