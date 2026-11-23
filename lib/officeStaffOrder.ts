export const officeStaffOrder = ["VL", "SC", "OL", "KZ", "CY", "MY", "ML", "LV", "NN", "DT", "LL", "LC", "JZ", "KI"] as const

const ranks = new Map<string, number>(officeStaffOrder.map((code, index) => [code, index]))

export function compareOfficeStaff(left: string, right: string) {
  const rank = (code: string) => ranks.get(code.trim().toUpperCase()) ?? ranks.size
  return rank(left) - rank(right)
}
