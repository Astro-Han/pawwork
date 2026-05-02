import type { QuestionRequest, Todo } from "@opencode-ai/sdk/v2"

export const QUESTION_REFETCH_ATTEMPTS = 4
export const QUESTION_REFETCH_DELAY_MS = 250

export const todoCompletionSignature = (todos: ReadonlyArray<Pick<Todo, "content" | "priority" | "status">>) =>
  todos.map((todo) => todo.status).join("\u0000")

export async function refetchPendingQuestions(input: {
  maxAttempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
  shouldContinue: () => boolean
  list: () => Promise<ReadonlyArray<QuestionRequest>>
  apply: (sessionID: string, questions: QuestionRequest[]) => void
}) {
  const maxAttempts = input.maxAttempts ?? QUESTION_REFETCH_ATTEMPTS
  const delayMs = input.delayMs ?? QUESTION_REFETCH_DELAY_MS
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)))

  for (let attempt = 0; attempt < maxAttempts && input.shouldContinue(); attempt++) {
    const questions = await input.list()
    const valid = questions.filter((q): q is QuestionRequest => !!q?.id && !!q.sessionID)
    if (valid.length > 0) {
      const grouped = new Map<string, QuestionRequest[]>()
      for (const q of valid) {
        const list = grouped.get(q.sessionID)
        if (list) list.push(q)
        else grouped.set(q.sessionID, [q])
      }
      for (const [sessionID, list] of grouped) {
        input.apply(
          sessionID,
          list.sort((a, b) => (a.id < b.id ? -1 : 1)),
        )
      }
      return true
    }
    if (attempt < maxAttempts - 1) await sleep(delayMs)
  }

  return false
}
