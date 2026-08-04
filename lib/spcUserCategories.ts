export type SpcUserCategory = "SUPPLIER TRADER" | "BUYER TRADER" | "ADMIN"

type CategorizedSpcUser = {
  role: string
  isSupplierTrader: boolean
}

export function isSpcUserInCategory(user: CategorizedSpcUser, category: SpcUserCategory) {
  if (category === "SUPPLIER TRADER") return user.isSupplierTrader
  return user.role === category
}
