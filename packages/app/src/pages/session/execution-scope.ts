import type { VcsReviewMode } from "./review-change-mode"

export type ExecutionScope = {
  serverKey: string
  directory: string
  epoch: number
}

export function executionScopeKey(scope: ExecutionScope) {
  return JSON.stringify([scope.serverKey, scope.directory, scope.epoch])
}

export function sameExecutionScope(a: ExecutionScope | undefined, b: ExecutionScope | undefined) {
  if (!a || !b) return a === b
  return a.serverKey === b.serverKey && a.directory === b.directory && a.epoch === b.epoch
}

export function nextExecutionEpoch(current: number) {
  return current + 1
}

export function createExecutionScopeTracker() {
  let current: ExecutionScope | undefined

  return (input: { serverKey: string; directory: string }): ExecutionScope => {
    if (!current) {
      current = { serverKey: input.serverKey, directory: input.directory, epoch: 0 }
      return current
    }

    if (current.serverKey === input.serverKey && current.directory === input.directory) return current

    current = {
      serverKey: input.serverKey,
      directory: input.directory,
      epoch: nextExecutionEpoch(current.epoch),
    }
    return current
  }
}

export function shouldApplyExecutionResult(input: { requested: ExecutionScope; current: ExecutionScope | undefined }) {
  return sameExecutionScope(input.requested, input.current)
}

export function vcsTaskKey(scope: ExecutionScope, mode: VcsReviewMode) {
  return `${executionScopeKey(scope)}\n${mode}`
}
