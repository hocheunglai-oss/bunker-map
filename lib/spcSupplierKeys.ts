function cleanText(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .trim()
}

function compactText(value: unknown) {
  return cleanText(value).replace(/\s+/g, " ").trim()
}

export const SUPPLIER_ALIASES: Record<string, string> = {
  BP: "BP MARINE",
  BPSINOPEC: "BP-SINOPEC",
  "BP SINOPEC": "BP-SINOPEC",
  CHIMBUSCCO: "CHIMBUSCO PAN NATION",
  CHIMBUSCO: "CHIMBUSCO PAN NATION",
  "CHIMBUSCCO PAN NATION": "CHIMBUSCO PAN NATION",
  "CHIMBUSCCO PAN NATION SG": "CHIMBUSCO PAN NATION",
  "CHIMBUSCO PAN NATION": "CHIMBUSCO PAN NATION",
  "CHIMBUSCO PAN NATION SG": "CHIMBUSCO PAN NATION",
  "CHIMBUSCO PAN NATION SINGAPORE": "CHIMBUSCO PAN NATION",
  "CHIMBUSCO SG": "CHIMBUSCO PAN NATION",
  EASTPAC: "EASTPEC",
  EASTPEC: "EASTPEC",
  EMF: "EQUATORIAL",
  "EQUATORIAL GLOBAL MARINE": "EQUATORIAL",
  EXXON: "EXXONMOBIL",
  "GLOBAL MARINE": "GLOBAL MARINE TRANSPORT",
  "GLOBAL MARINE FC BDN": "GLOBAL MARINE TRANSPORT",
  "GLOBAL MARINE TRANSPORT": "GLOBAL MARINE TRANSPORT",
  "GLOBAL MARINE TRANSPORTATION": "GLOBAL MARINE TRANSPORT",
  GMT: "GLOBAL MARINE TRANSPORT",
  HAIYIN: "HAIYIN",
  "HAI YIN": "HAIYIN",
  "ITG XIANG YU": "OPULENT",
  "MGO GO": "MGO GO",
  "MONJASA EASTPAC": "EASTPEC",
  OPPULENT: "OPULENT",
  "PETRO CHINA": "PETROCHINA",
  "PETRO-CHINA": "PETROCHINA",
  PETROCHINA: "PETROCHINA",
  "PETROCHINA CHIMBUSCO SG": "PETROCHINA",
  SENTEK: "SFI ENERGY",
  SINGFAR: "SFI ENERGY",
  "SENTEK SINGFAR": "SFI ENERGY",
  "SENTEK SINGFAR SFI ENERGY": "SFI ENERGY",
  "SFI ENERGY EX SINGFAR": "SFI ENERGY",
  "SFI ENERGY": "SFI ENERGY",
  "TFG MARINE": "TFG MARINE",
  "TIMES MARINE": "TIMES MARINE",
  VITOL: "VITOL",
}

export function supplierBase(value: unknown) {
  return compactText(value)
    .replace(/\s*>>.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function normaliseSupplierToken(value: unknown) {
  return supplierBase(value)
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " AND ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .replace(/\bPTE\b|\bLTD\b|\bLIMITED\b|\bSINGAPORE\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
}

export function canonicalSupplierName(value: unknown) {
  const token = normaliseSupplierToken(value)
  return SUPPLIER_ALIASES[token] || token
}

export function supplierKey(value: unknown) {
  return canonicalSupplierName(value).replace(/[^A-Z0-9]+/g, "")
}

export function displaySupplierName(value: unknown) {
  const base = supplierBase(value).replace(/\s+/g, " ").trim()
  const alias = SUPPLIER_ALIASES[normaliseSupplierToken(base)]
  return alias || base
}
