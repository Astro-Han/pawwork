export type TurnFetchAssistantLite = {
  id: string
  parentID: string | null | undefined
  completed: number | undefined
}

export type TurnFetchTarget = {
  userMessageID: string
  key: string
}

export type TurnFetchInput = {
  sessionID: string
  assistants: ReadonlyArray<TurnFetchAssistantLite>
}

export function turnFetchTargets(input: TurnFetchInput): TurnFetchTarget[] {
  const byParent = new Map<string, Array<{ id: string; completed: number }>>()
  for (const a of input.assistants) {
    if (!a.parentID) continue
    if (typeof a.completed !== "number") {
      byParent.set(a.parentID, byParent.get(a.parentID) ?? [])
      byParent.get(a.parentID)!.push({ id: a.id, completed: -1 })
      continue
    }
    const list = byParent.get(a.parentID) ?? []
    list.push({ id: a.id, completed: a.completed })
    byParent.set(a.parentID, list)
  }
  const targets: TurnFetchTarget[] = []
  for (const [parentID, list] of byParent) {
    if (list.some((a) => a.completed < 0)) continue
    const sigs = list.map((a) => `${a.id}@${a.completed}`).sort()
    targets.push({ userMessageID: parentID, key: `${input.sessionID}:${parentID}:${sigs.join(",")}` })
  }
  return targets
}

export function turnFetchSignature(input: TurnFetchInput): string {
  return turnFetchTargets(input)
    .map((t) => t.key)
    .sort()
    .join("|")
}
