export const TAIWAN_OPERATIONAL_NOTICE_REMARK_ID = 3

export type TaiwanOperationalNotice = {
  active: boolean
  typhoonName: string
  expectedReopenDate: string
}

export const emptyTaiwanOperationalNotice: TaiwanOperationalNotice = {
  active: false,
  typhoonName: "",
  expectedReopenDate: "",
}

export const taiwanTyphoonNoticeTemplate: TaiwanOperationalNotice = {
  active: true,
  typhoonName: "Bavi",
  expectedReopenDate: "next Monday, 13 Jul",
}

export function normaliseTaiwanOperationalNotice(
  notice: (Partial<TaiwanOperationalNotice> & { message?: string }) | null | undefined,
): TaiwanOperationalNotice {
  if (!notice || typeof notice !== "object") return emptyTaiwanOperationalNotice
  const legacyMessage = typeof notice.message === "string" ? notice.message : ""
  const legacyTyphoonName = legacyMessage.match(/Typhoon\s+(.+?)\s+and CPC office closure/i)?.[1] || ""
  const legacyExpectedReopenDate =
    legacyMessage.match(/CPC is expected to reopen\s+(.+?)\.\s+Delivery/i)?.[1] || ""

  return {
    active: Boolean(notice.active),
    typhoonName: typeof notice.typhoonName === "string" ? notice.typhoonName : legacyTyphoonName,
    expectedReopenDate:
      typeof notice.expectedReopenDate === "string" ? notice.expectedReopenDate : legacyExpectedReopenDate,
  }
}

export function parseTaiwanOperationalNotice(content: string | null | undefined) {
  if (!content) return emptyTaiwanOperationalNotice

  try {
    return normaliseTaiwanOperationalNotice(JSON.parse(content) as Partial<TaiwanOperationalNotice>)
  } catch {
    return emptyTaiwanOperationalNotice
  }
}

export function serializeTaiwanOperationalNotice(notice: TaiwanOperationalNotice) {
  return JSON.stringify(normaliseTaiwanOperationalNotice(notice))
}

export function buildTaiwanOperationalNoticeMessage(notice: TaiwanOperationalNotice) {
  const typhoonName = notice.typhoonName.trim()
  const expectedReopenDate = notice.expectedReopenDate.trim()

  if (!typhoonName || !expectedReopenDate) return ""

  return [
    `Due to Typhoon ${typhoonName} and CPC office closure, no Taiwan posted prices will be released today. CPC bunker ordering is suspended for today.`,
    `CPC is expected to reopen ${expectedReopenDate}. Delivery may be suspended at some ports, and each port may have different suspension or reopening timing.`,
    "The latest available posted prices remain for indication only. Updates will resume after CPC returns to normal office operation.",
  ].join("\n\n")
}

export function isTaiwanOperationalNoticeReady(notice: TaiwanOperationalNotice) {
  return (
    notice.active &&
    notice.typhoonName.trim().length > 0 &&
    notice.expectedReopenDate.trim().length > 0
  )
}
