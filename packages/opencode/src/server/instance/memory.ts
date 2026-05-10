import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Instance } from "@/project/instance"
import { MemoryProposal } from "@/memory/proposal"
import { MemoryService } from "@/memory/service"

const MemoryRawInput = z.object({ content: z.string() }).meta({ ref: "MemoryRawInput" })
const MemoryDisabledInput = z.object({ disabled: z.boolean() }).meta({ ref: "MemoryDisabledInput" })
const MemoryProposalInput = z
  .object({
    text: z.string(),
    scope: z.enum(["user", "project"]),
    tags: z.array(z.string()).default([]),
    source: z.string().optional(),
  })
  .meta({ ref: "MemoryProposalInput" })

const MemoryState = z.any().meta({ ref: "MemoryState" })

function service() {
  return MemoryService.create({ workspacePath: Instance.directory })
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
      async (c) => c.json(await service().read()),
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
          await service().saveRaw(c.req.valid("json").content)
          return c.json(await service().read())
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
        await service().resetToTemplate()
        return c.json(await service().read())
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
        await service().setDisabled(c.req.valid("json").disabled)
        return c.json(await service().read())
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
        await service().deleteEntry(c.req.param("id"))
        return c.json(await service().read())
      },
    )
    .post(
      "/proposal/preview",
      describeRoute({
        summary: "Preview PawWork memory proposal",
        operationId: "memory.previewProposal",
        responses: {
          200: { description: "Preview", content: { "application/json": { schema: resolver(z.any()) } } },
        },
      }),
      validator("json", MemoryProposalInput),
      async (c) => c.json(MemoryProposal.fromText(c.req.valid("json"))),
    )
    .post(
      "/proposal/accept",
      describeRoute({
        summary: "Accept PawWork memory proposal",
        operationId: "memory.acceptProposal",
        responses: {
          200: { description: "Memory state", content: { "application/json": { schema: resolver(MemoryState) } } },
        },
      }),
      validator("json", MemoryProposalInput),
      async (c) => {
        await service().appendAcceptedProposal(c.req.valid("json"))
        return c.json(await service().read())
      },
    )
