import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { MemoryService } from "@/memory/service"

function createMemoryService() {
  return MemoryService.create({ workspacePath: Instance.directory })
}

export const readMemory = Effect.fn("MemoryRoutes.read")(function* () {
  const memory = createMemoryService()
  return yield* Effect.promise(() => memory.read())
})

export const updateRawMemory = Effect.fn("MemoryRoutes.updateRaw")(function* (content: string) {
  const memory = createMemoryService()
  yield* Effect.promise(() => memory.saveRaw(content))
  return yield* Effect.promise(() => memory.read())
})

export const resetMemory = Effect.fn("MemoryRoutes.reset")(function* () {
  const memory = createMemoryService()
  yield* Effect.promise(() => memory.resetToTemplate())
  return yield* Effect.promise(() => memory.read())
})

export const setMemoryDisabled = Effect.fn("MemoryRoutes.disabled")(function* (disabled: boolean) {
  const memory = createMemoryService()
  yield* Effect.promise(() => memory.setDisabled(disabled))
  return yield* Effect.promise(() => memory.read())
})

export const deleteMemoryEntry = Effect.fn("MemoryRoutes.deleteEntry")(function* (id: string) {
  const memory = createMemoryService()
  yield* Effect.promise(() => memory.deleteEntry(id))
  return yield* Effect.promise(() => memory.read())
})
