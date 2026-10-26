// CY's DingTalk exception was authorized on 14 October 2026. It applies to
// closed months from October 2026 onward until the policy is explicitly
// removed. Keep both identifiers so a reassigned staff code cannot inherit it.
const CY_DINGTALK_EXCEPTION = Object.freeze({
  personId: "e2cd1a9d-95c1-4292-940a-884537f35cf3",
  staffCode: "CY",
  firstYear: 2026,
  firstMonth: 10,
})

export const CY_DINGTALK_EXCEPTION_ACTOR = "system:attendance-cy-dingtalk-exception"

export const CY_DINGTALK_EXCEPTION_NOTE =
  "System confirmed after the second reminder under CY's ongoing DingTalk exception, authorized 14 October 2026. DingTalk synchronization was not required for this confirmation. This is not employee approval or independent proof of attendance; corrections may be raised with an administrator."

export function hasCyDingTalkAutoConfirmException(
  person: { id: string; staffCode: string },
  period: { year: number; month: number },
) {
  return person.id === CY_DINGTALK_EXCEPTION.personId &&
    person.staffCode === CY_DINGTALK_EXCEPTION.staffCode &&
    (period.year > CY_DINGTALK_EXCEPTION.firstYear ||
      (period.year === CY_DINGTALK_EXCEPTION.firstYear &&
        period.month >= CY_DINGTALK_EXCEPTION.firstMonth))
}

// JZ was authorized for the same ongoing treatment as CY on 26 October 2026.
// Match CY's October 2026 effective period, but also pin the linked admin so
// a reassigned account, person or staff code cannot inherit this exception.
const JZ_DINGTALK_EXCEPTION = Object.freeze({
  personId: "50988b84-4d6c-4089-9112-d6bfad1ed72d",
  adminUserId: "3cf2bff0-4eda-4c36-8827-a8f7be0c764d",
  staffCode: "JZ",
  firstYear: 2026,
  firstMonth: 10,
})

export const JZ_DINGTALK_EXCEPTION_ACTOR = "system:attendance-jz-dingtalk-exception"

export const JZ_DINGTALK_EXCEPTION_NOTE =
  "System confirmed after the second reminder under JZ's ongoing DingTalk exception, authorized 26 October 2026. DingTalk synchronization was not required for this confirmation. This is not employee approval or independent proof of attendance; corrections may be raised with an administrator."

export function hasJzDingTalkAutoConfirmException(
  person: { id: string; adminUserId: string | null; staffCode: string },
  period: { year: number; month: number },
) {
  return person.id === JZ_DINGTALK_EXCEPTION.personId &&
    person.adminUserId === JZ_DINGTALK_EXCEPTION.adminUserId &&
    person.staffCode === JZ_DINGTALK_EXCEPTION.staffCode &&
    (period.year > JZ_DINGTALK_EXCEPTION.firstYear ||
      (period.year === JZ_DINGTALK_EXCEPTION.firstYear &&
        period.month >= JZ_DINGTALK_EXCEPTION.firstMonth))
}
