export type FuelKey = "hsfo" | "vlsfo" | "mgo"
export type FallbackValue = "-" | "NA" | "SE"
export type FallbackMap = Record<string, FallbackValue>

export const FALLBACK_REMARK_ID = 105

export function buildFallbackKey(port: string, fuel: FuelKey) {
  return `${port.toLowerCase()}::${fuel}`
}
