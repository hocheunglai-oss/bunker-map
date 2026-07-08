import type { SpcUserOption } from "@/lib/spcUsers"

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
  const withoutOffice = localPart.replace(/[-_.\s]+(?:AE|GR|HK|IT|MC|SG|US|USA|VN)$/i, "")
  return withoutOffice.split(/[-_.\s]+/).find(Boolean) || ""
}

function displayName(user: SpcUserOption) {
  return cleanText(user.displayName || user.username)
}

export function createActiveSpcTraderResolver(users: SpcUserOption[]) {
  const exactMatches = new Map<string, SpcUserOption>()
  const tokenMatches = new Map<string, SpcUserOption[]>()

  function addExact(value: unknown, user: SpcUserOption) {
    const key = lookupKey(value)
    if (key && !exactMatches.has(key)) exactMatches.set(key, user)
  }

  function addToken(value: unknown, user: SpcUserOption) {
    const token = traderToken(value)
    if (!token) return
    tokenMatches.set(token, [...(tokenMatches.get(token) || []), user])
  }

  users.forEach((user) => {
    addExact(user.username, user)
    addExact(user.displayName, user)
    addToken(user.username, user)
    addToken(user.displayName, user)
  })

  const uniqueTokenMatches = new Map(
    Array.from(tokenMatches.entries()).flatMap(([token, matches]) => {
      const unique = Array.from(new Map(matches.map((user) => [user.id, user])).values())
      return unique.length === 1 ? [[token, unique[0]] as const] : []
    }),
  )

  function resolveUser(username: unknown, fallbackDisplayName?: unknown) {
    const usernameKey = lookupKey(username)
    if (usernameKey) {
      const exactUser = exactMatches.get(usernameKey)
      if (exactUser) return exactUser
    }

    const displayKey = lookupKey(fallbackDisplayName)
    if (displayKey) {
      const exactUser = exactMatches.get(displayKey)
      if (exactUser) return exactUser
    }

    const usernameToken = traderToken(username)
    if (usernameToken) {
      const tokenUser = uniqueTokenMatches.get(usernameToken)
      if (tokenUser) return tokenUser
    }

    const displayToken = traderToken(fallbackDisplayName)
    if (displayToken) {
      const tokenUser = uniqueTokenMatches.get(displayToken)
      if (tokenUser) return tokenUser
    }

    return null
  }

  function displayNameOrRetired(username: unknown, fallbackDisplayName?: unknown) {
    const user = resolveUser(username, fallbackDisplayName)
    return user ? displayName(user) : "RETIRED"
  }

  return {
    resolveUser,
    displayNameOrRetired,
  }
}
