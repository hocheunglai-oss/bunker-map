import type { SpcUserOption } from "@/lib/spcUsers"

type TraderUser = SpcUserOption & { isActive?: boolean }

const officeCodes: Record<string, string> = {
  "HONG KONG": "HK",
  SINGAPORE: "SG",
  ITALY: "IT",
  GENOA: "IT",
  MONACO: "MC",
  GREECE: "GR",
  FRANCE: "FR",
  USA: "US",
  "UNITED STATES": "US",
  UAE: "AE",
  "UNITED ARAB EMIRATES": "AE",
  KOREA: "KR",
  JAPAN: "JP",
  VIETNAM: "VN",
}

const officeNames: Record<string, string> = {
  HK: "HONG KONG",
  SG: "SINGAPORE",
  IT: "ITALY",
  MC: "MONACO",
  GR: "GREECE",
  FR: "FRANCE",
  US: "USA",
  USA: "USA",
  AE: "UNITED ARAB EMIRATES",
  KR: "KOREA",
  JP: "JAPAN",
  VN: "VIETNAM",
}

const resignedTraderOfficeOverrides: Record<string, string> = {
  SAM: "HONG KONG",
  MIRKO: "ITALY",
}

function cleanText(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim()
}

function lookupKey(value: unknown) {
  return cleanText(value).toUpperCase()
}

function traderToken(value: unknown) {
  const text = lookupKey(value)
  if (!text) return ""
  const localPart = text.includes("@") ? text.split("@")[0] : text
  const withoutStatus = localPart.replace(/[-_.\s]+RESIGNED$/i, "")
  const withoutOffice = withoutStatus.replace(/[-_.\s]+(?:AE|GR|HK|IT|MC|SG|US|USA|VN)$/i, "")
  return withoutOffice.split(/[-_.\s]+/).find(Boolean) || ""
}

function displayName(user: TraderUser) {
  return cleanText(user.displayName || user.username)
}

function officeCode(value: unknown) {
  const key = lookupKey(value)
  if (!key) return ""
  if (officeCodes[key]) return officeCodes[key]
  return officeNames[key] ? (key === "USA" ? "US" : key) : ""
}

function officeName(value: unknown) {
  const key = lookupKey(value)
  if (!key) return ""
  if (officeNames[key]) return officeNames[key]
  if (officeCodes[key]) return officeNames[officeCodes[key]] || key
  return ""
}

function suffixOfficeName(value: unknown) {
  const match = lookupKey(value).match(/(?:^|[-_.\s])([A-Z]{2,3})(?:[-_.\s]+RESIGNED)?$/)
  return match ? officeName(match[1]) : ""
}

function domainOfficeName(value: unknown) {
  const text = cleanText(value).toLowerCase()
  if (text.endsWith(".hk")) return "HONG KONG"
  if (text.endsWith(".sg")) return "SINGAPORE"
  if (text.endsWith(".it")) return "ITALY"
  if (text.endsWith(".mc")) return "MONACO"
  if (text.endsWith(".gr")) return "GREECE"
  if (text.endsWith(".ae")) return "UNITED ARAB EMIRATES"
  return ""
}

function resignedTraderOfficeName(username: unknown, fallbackDisplayName?: unknown) {
  const displayToken = traderToken(fallbackDisplayName)
  if (displayToken && resignedTraderOfficeOverrides[displayToken]) return resignedTraderOfficeOverrides[displayToken]
  const usernameToken = traderToken(username)
  if (usernameToken && resignedTraderOfficeOverrides[usernameToken]) return resignedTraderOfficeOverrides[usernameToken]
  return ""
}

function compactName(value: unknown) {
  const token = traderToken(value)
  if (token) return token
  return lookupKey(value).split(/\s+/).find(Boolean) || ""
}

function buildTokenMatches(tokenMatches: Map<string, TraderUser[]>) {
  return new Map(
    Array.from(tokenMatches.entries()).flatMap(([token, matches]) => {
      const unique = Array.from(new Map(matches.map((user) => [user.id, user])).values())
      return unique.length === 1 ? [[token, unique[0]] as const] : []
    }),
  )
}

export function createActiveSpcTraderResolver(users: TraderUser[]) {
  const exactMatches = new Map<string, TraderUser>()
  const tokenMatches = new Map<string, TraderUser[]>()
  const anyExactMatches = new Map<string, TraderUser>()
  const anyTokenMatches = new Map<string, TraderUser[]>()

  function addExact(map: Map<string, TraderUser>, value: unknown, user: TraderUser) {
    const key = lookupKey(value)
    if (key && !map.has(key)) map.set(key, user)
  }

  function addToken(map: Map<string, TraderUser[]>, value: unknown, user: TraderUser) {
    const token = traderToken(value)
    if (!token) return
    map.set(token, [...(map.get(token) || []), user])
  }

  users.forEach((user) => {
    addExact(anyExactMatches, user.username, user)
    addExact(anyExactMatches, user.displayName, user)
    addToken(anyTokenMatches, user.username, user)
    addToken(anyTokenMatches, user.displayName, user)
    if (user.isActive === false) return
    addExact(exactMatches, user.username, user)
    addExact(exactMatches, user.displayName, user)
    addToken(tokenMatches, user.username, user)
    addToken(tokenMatches, user.displayName, user)
  })

  const uniqueTokenMatches = buildTokenMatches(tokenMatches)
  const anyUniqueTokenMatches = buildTokenMatches(anyTokenMatches)

  function resolveFromMaps(
    exact: Map<string, TraderUser>,
    uniqueTokens: Map<string, TraderUser>,
    username: unknown,
    fallbackDisplayName?: unknown,
  ) {
    const usernameKey = lookupKey(username)
    if (usernameKey) {
      const exactUser = exact.get(usernameKey)
      if (exactUser) return exactUser
    }

    const displayKey = lookupKey(fallbackDisplayName)
    if (displayKey) {
      const exactUser = exact.get(displayKey)
      if (exactUser) return exactUser
    }

    const usernameToken = traderToken(username)
    if (usernameToken) {
      const tokenUser = uniqueTokens.get(usernameToken)
      if (tokenUser) return tokenUser
    }

    const displayToken = traderToken(fallbackDisplayName)
    if (displayToken) {
      const tokenUser = uniqueTokens.get(displayToken)
      if (tokenUser) return tokenUser
    }

    return null
  }

  function resolveUser(username: unknown, fallbackDisplayName?: unknown) {
    return resolveFromMaps(exactMatches, uniqueTokenMatches, username, fallbackDisplayName)
  }

  function resolveAnyUser(username: unknown, fallbackDisplayName?: unknown) {
    return resolveFromMaps(anyExactMatches, anyUniqueTokenMatches, username, fallbackDisplayName)
  }

  function officeForTrader(username: unknown, fallbackDisplayName?: unknown, fallbackOffice?: unknown) {
    const user = resolveAnyUser(username, fallbackDisplayName)
    return (
      officeName(user?.office) ||
      resignedTraderOfficeName(username, fallbackDisplayName) ||
      suffixOfficeName(fallbackDisplayName) ||
      suffixOfficeName(username) ||
      domainOfficeName(username) ||
      domainOfficeName(fallbackDisplayName) ||
      officeName(fallbackOffice) ||
      ""
    )
  }

  function resignedLabel(username: unknown, fallbackDisplayName?: unknown, fallbackOffice?: unknown) {
    const user = resolveAnyUser(username, fallbackDisplayName)
    const name = compactName(displayName(user || ({ username, displayName: fallbackDisplayName } as TraderUser))) ||
      compactName(username) ||
      "UNKNOWN"
    const office = officeCode(officeForTrader(username, fallbackDisplayName, fallbackOffice))
    return office ? `${name}-${office}-RESIGNED` : `${name}-RESIGNED`
  }

  function displayNameOrRetired(username: unknown, fallbackDisplayName?: unknown, fallbackOffice?: unknown) {
    const user = resolveUser(username, fallbackDisplayName)
    return user ? displayName(user) : resignedLabel(username, fallbackDisplayName, fallbackOffice)
  }

  return {
    resolveUser,
    displayNameOrRetired,
    officeForTrader,
  }
}
