export function normalizeFeedbackFormUrl(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return ""
  try {
    const url = new URL(trimmed)
    return url.protocol === "https:" ? url.toString() : ""
  } catch {
    return ""
  }
}

export function feedbackFormUrl(
  buildTimeValue = import.meta.env.PAWWORK_FEEDBACK_FORM_URL ?? "",
  runtimeValue = process.env.PAWWORK_FEEDBACK_FORM_URL ?? "",
) {
  return normalizeFeedbackFormUrl(buildTimeValue || runtimeValue)
}

export const FEEDBACK_FORM_URL = feedbackFormUrl()
export const PAWWORK_GITHUB_URL = "https://github.com/Astro-Han/pawwork"
export const PAWWORK_GITHUB_ISSUE_URL = `${PAWWORK_GITHUB_URL}/issues/new?template=01-bug-report.yml`
