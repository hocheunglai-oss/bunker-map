export const SPC_FEEDBACK_CATEGORIES = ["SUGGESTION", "PROBLEM", "NEW FEATURE", "OTHER"] as const
export const SPC_FEEDBACK_STATUSES = ["NEW", "REVIEWING", "PLANNED", "COMPLETED", "CLOSED"] as const

export type SpcFeedbackCategory = (typeof SPC_FEEDBACK_CATEGORIES)[number]
export type SpcFeedbackStatus = (typeof SPC_FEEDBACK_STATUSES)[number]

export type SpcFeedbackRecord = {
  id: string
  category: SpcFeedbackCategory
  title: string
  message: string
  area: string
  status: SpcFeedbackStatus
  adminResponse: string
  createdByUsername: string
  createdByDisplayName: string
  reviewedByDisplayName: string
  createdAt: string
  updatedAt: string
}
