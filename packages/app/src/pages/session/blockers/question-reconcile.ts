import type { QuestionRequest } from "@opencode-ai/sdk/v2/client"

export const QUESTION_REFETCH_ATTEMPTS = 4
export const QUESTION_REFETCH_DELAY_MS = 250

export async function refetchPendingQuestionsForSession(input: {
  sessionID: string
  maxAttempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  shouldContinue: () => boolean
  list: () => Promise<ReadonlyArray<QuestionRequest>>
  apply: (sessionID: string, questions: QuestionRequest[]) => void
}): Promise<boolean> {
  const maxAttempts = input.maxAttempts ?? QUESTION_REFETCH_ATTEMPTS
  const delayMs = input.delayMs ?? QUESTION_REFETCH_DELAY_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!input.shouldContinue()) return false

    const questions = await input.list()

    if (!input.shouldContinue()) return false

    const target = questions
      .filter((question): question is QuestionRequest => !!question?.id && question.sessionID === input.sessionID)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    if (target.length > 0) {
      if (!input.shouldContinue()) return false
      input.apply(input.sessionID, target)
      return true
    }

    if (attempt < maxAttempts - 1) await sleep(delayMs)
  }

  return false
}
