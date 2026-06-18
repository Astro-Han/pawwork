import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { Instance } from "@/project/instance"
import { MemoryService } from "@/memory/service"
import { AppRuntime } from "@/effect/app-runtime"

const MemoryRawInput = z.object({ content: z.string() }).meta({ ref: "MemoryRawInput" })
const MemoryDisabledInput = z.object({ disabled: z.boolean() }).meta({ ref: "MemoryDisabledInput" })

const MemoryState = z.any().meta({ ref: "MemoryState" })

const runMemoryRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

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

export const MemoryRoutes = () =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get PawWork memory",
        operationId: "memory.get",
        responses: {
          200: { description: "Memory state", content: { "application/json": { schema: resolver(MemoryState) } } },
        },
      }),
      async (c) => c.json(await runMemoryRoute(readMemory())),
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update raw PawWork memory",
        operationId: "memory.update",
        responses: {
          200: { description: "Memory state", content: { "application/json": { schema: resolver(MemoryState) } } },
          400: { description: "Invalid memory file" },
        },
      }),
      validator("json", MemoryRawInput),
      async (c) => {
        try {
          const content = c.req.valid("json").content
          const state = await runMemoryRoute(updateRawMemory(content))
          return c.json(state)
        } catch (error) {
          return c.json({ error: "invalid_memory_file", reason: error instanceof Error ? error.message : String(error) }, 400)
        }
      },
    )
    .post(
      "/reset",
      describeRoute({
        summary: "Reset PawWork memory",
        operationId: "memory.reset",
        responses: {
          200: { description: "Memory state", content: { "application/json": { schema: resolver(MemoryState) } } },
        },
      }),
      async (c) => {
        const state = await runMemoryRoute(resetMemory())
        return c.json(state)
      },
    )
    .patch(
      "/disabled",
      describeRoute({
        summary: "Disable or enable PawWork memory",
        operationId: "memory.disabled",
        responses: {
          200: { description: "Memory state", content: { "application/json": { schema: resolver(MemoryState) } } },
        },
      }),
      validator("json", MemoryDisabledInput),
      async (c) => {
        const disabled = c.req.valid("json").disabled
        const state = await runMemoryRoute(setMemoryDisabled(disabled))
        return c.json(state)
      },
    )
    .delete(
      "/entry/:id",
      describeRoute({
        summary: "Delete PawWork memory entry",
        operationId: "memory.deleteEntry",
        responses: {
          200: { description: "Memory state", content: { "application/json": { schema: resolver(MemoryState) } } },
        },
      }),
      async (c) => {
        const id = c.req.param("id")
        const state = await runMemoryRoute(deleteMemoryEntry(id))
        return c.json(state)
      },
    )
