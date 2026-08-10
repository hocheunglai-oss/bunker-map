export type AttendanceWorkMode = "office" | "home-office" | "business-trip"

export type AttendanceWorkModePolicy = {
  id: string
  personId: string
  mode: Exclude<AttendanceWorkMode, "business-trip">
  effectiveFrom: string
  effectiveTo: string | null
  source: string
}

export type AttendanceWorkModeOverride = {
  id: string
  personId: string
  workDate: string
  mode: AttendanceWorkMode
  note: string
  createdBy: string
  updatedBy: string
  createdAt: string
  updatedAt: string
}

export function resolveAttendanceWorkMode(input: {
  personId: string
  workDate: string
  policies: AttendanceWorkModePolicy[]
  overrides: AttendanceWorkModeOverride[]
  recordedCode?: "HO" | "OS" | null
}) {
  const policy = input.policies.find(
    (entry) =>
      entry.personId === input.personId &&
      entry.effectiveFrom <= input.workDate &&
      (!entry.effectiveTo || entry.effectiveTo >= input.workDate),
  )
  const override = input.overrides.find(
    (entry) =>
      entry.personId === input.personId && entry.workDate === input.workDate,
  )
  const defaultWorkMode: AttendanceWorkMode = policy?.mode || "office"
  const workMode: AttendanceWorkMode =
    override?.mode ||
    (input.recordedCode === "HO"
      ? "home-office"
      : input.recordedCode === "OS"
        ? "business-trip"
        : defaultWorkMode)
  const workModeSource = override
    ? ("manual" as const)
    : input.recordedCode
      ? ("leave" as const)
      : policy
        ? ("default" as const)
        : null
  return { policy, override, defaultWorkMode, workMode, workModeSource }
}

type DerivedWorkModeUnitsInput = {
  workMode: AttendanceWorkMode
  workModeSource: "manual" | "leave" | "default" | null
  required: boolean
  holiday: boolean
  future: boolean
  absenceUnits: number
}

function derivedWorkModeUnits(
  input: DerivedWorkModeUnitsInput,
  targetMode: "home-office" | "business-trip",
) {
  if (
    input.workMode !== targetMode ||
    input.workModeSource === "leave" ||
    !input.required ||
    input.holiday ||
    input.future
  ) {
    return 0
  }
  return Math.max(0, 1 - Math.min(1, input.absenceUnits))
}

export function derivedHomeOfficeUnits(input: DerivedWorkModeUnitsInput) {
  return derivedWorkModeUnits(input, "home-office")
}

export function derivedBusinessTripUnits(input: DerivedWorkModeUnitsInput) {
  return derivedWorkModeUnits(input, "business-trip")
}
