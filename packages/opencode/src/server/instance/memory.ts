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

function service() {
  return MemoryService.create({ workspacePath: Instance.directory })
}

function runMemory<A>(fn: (memory: ReturnType<typeof service>) => Promise<A>) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const memory = service()
      return yield* Effect.promise(() => fn(memory))
    }),
  )
}

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
      async (c) => c.json(await runMemory((memory) => memory.read())),
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
          const state = await runMemory(async (memory) => {
            await memory.saveRaw(content)
            return memory.read()
          })
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
        const state = await runMemory(async (memory) => {
          await memory.resetToTemplate()
          return memory.read()
        })
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
        const state = await runMemory(async (memory) => {
          await memory.setDisabled(disabled)
          return memory.read()
        })
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
        const state = await runMemory(async (memory) => {
          await memory.deleteEntry(id)
          return memory.read()
        })
        return c.json(state)
      },
    )
