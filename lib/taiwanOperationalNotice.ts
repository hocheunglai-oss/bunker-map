export const TAIWAN_OPERATIONAL_NOTICE_REMARK_ID = 3

export type TaiwanOperationalNotice = {
  active: boolean
  title: string
  message: string
}

export const emptyTaiwanOperationalNotice: TaiwanOperationalNotice = {
  active: false,
  title: "",
  message: "",
}

export const taiwanTyphoonNoticeTemplate: TaiwanOperationalNotice = {
  active: true,
  title: "Typhoon Notice",
  message: [
    "Due to Typhoon Bavi and CPC office closure, no Taiwan posted prices will be released today. CPC bunker ordering is suspended for today.",
    "CPC is expected to reopen next Monday, 13 Jul. Delivery may be suspended at some ports, and each port may have different suspension or reopening timing.",
    "The latest available posted prices remain for indication only. Updates will resume after CPC returns to normal office operation.",
  ].join("\n\n"),
}

export function normaliseTaiwanOperationalNotice(
  notice: Partial<TaiwanOperationalNotice> | null | undefined,
): TaiwanOperationalNotice {
  if (!notice || typeof notice !== "object") return emptyTaiwanOperationalNotice

  return {
    active: Boolean(notice.active),
    title: typeof notice.title === "string" ? notice.title : "",
    message: typeof notice.message === "string" ? notice.message : "",
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
