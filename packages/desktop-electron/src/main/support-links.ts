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

export const FEEDBACK_FORM_URL = normalizeFeedbackFormUrl(import.meta.env.PAWWORK_FEEDBACK_FORM_URL ?? "")
export const PAWWORK_GITHUB_URL = "https://github.com/Astro-Han/pawwork"
export const PAWWORK_GITHUB_ISSUE_URL = `${PAWWORK_GITHUB_URL}/issues/new?template=01-bug-report.yml`
