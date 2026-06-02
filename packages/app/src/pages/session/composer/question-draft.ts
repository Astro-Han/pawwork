// One question's selected labels. Mirrors the per-row shape of the
// `payload.answers: string[][]` body sent to POST /session/:id/tool/respond
// (validated by questionDecoder in packages/opencode/src/tool/question.ts).
export type QuestionAnswer = readonly string[]

export type DraftAnswer = QuestionAnswer | undefined

export const cache = new Map<string, { tab: number; answers: DraftAnswer[]; custom: string[]; customOn: boolean[] }>()
