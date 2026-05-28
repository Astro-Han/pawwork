import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Automation, AutomationID, ValidationError } from "@/automation"
import { errors } from "../error"

function validationError(error: ValidationError) {
  return { error: "invalid_automation", details: error.details }
}

export const AutomationRoutes = (): Hono =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List automations",
        description: "List automation definitions for the current project.",
        operationId: "automation.list",
        responses: {
          200: {
            description: "Automation definitions",
            content: { "application/json": { schema: resolver(Automation.ListResponse) } },
          },
        },
      }),
      (c) => c.json({ items: Automation.list() }),
    )
    .post(
      "/",
      describeRoute({
        summary: "Create automation",
        description: "Create an automation definition without executing it.",
        operationId: "automation.create",
        responses: {
          200: {
            description: "Created automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          422: { description: "Automation validation failed" },
          ...errors(400),
        },
      }),
      validator("json", Automation.CreateInput),
      async (c) => {
        try {
          const definition = Automation.create(c.req.valid("json"))
          await Automation.publishDefinitionUpdated(definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ValidationError) return c.json(validationError(error), 422)
          throw error
        }
      },
    )
    .get(
      "/:automationID",
      describeRoute({
        summary: "Get automation",
        description: "Get one automation definition.",
        operationId: "automation.get",
        responses: {
          200: {
            description: "Automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      (c) => c.json(Automation.get(c.req.valid("param").automationID)),
    )
    .put(
      "/:automationID",
      describeRoute({
        summary: "Update automation",
        description: "Update an automation definition.",
        operationId: "automation.update",
        responses: {
          200: {
            description: "Updated automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          422: { description: "Automation validation failed" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      validator("json", Automation.UpdateInput),
      async (c) => {
        try {
          const definition = Automation.update(c.req.valid("param").automationID, c.req.valid("json"))
          await Automation.publishDefinitionUpdated(definition)
          return c.json(definition)
        } catch (error) {
          if (error instanceof ValidationError) return c.json(validationError(error), 422)
          throw error
        }
      },
    )
    .post(
      "/:automationID/pause",
      describeRoute({
        summary: "Pause automation",
        description: "Pause an automation definition.",
        operationId: "automation.pause",
        responses: {
          200: {
            description: "Paused automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const definition = Automation.update(c.req.valid("param").automationID, { paused: true })
        await Automation.publishDefinitionUpdated(definition)
        return c.json(definition)
      },
    )
    .post(
      "/:automationID/resume",
      describeRoute({
        summary: "Resume automation",
        description: "Resume a paused automation definition.",
        operationId: "automation.resume",
        responses: {
          200: {
            description: "Resumed automation definition",
            content: { "application/json": { schema: resolver(Automation.Definition) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const definition = Automation.update(c.req.valid("param").automationID, { paused: false })
        await Automation.publishDefinitionUpdated(definition)
        return c.json(definition)
      },
    )
    .delete(
      "/:automationID",
      describeRoute({
        summary: "Delete automation",
        description: "Delete an automation definition and return a tombstone.",
        operationId: "automation.delete",
        responses: {
          200: {
            description: "Automation deletion tombstone",
            content: { "application/json": { schema: resolver(Automation.Tombstone) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const tombstone = Automation.remove(c.req.valid("param").automationID)
        await Automation.publishDefinitionDeleted(tombstone)
        return c.json(tombstone)
      },
    )
    .post(
      "/:automationID/run",
      describeRoute({
        summary: "Run automation now",
        description: "Create a scheduled automation run record. Execution lands in a later PR.",
        operationId: "automation.runNow",
        responses: {
          200: {
            description: "Automation run",
            content: { "application/json": { schema: resolver(Automation.Run) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      async (c) => {
        const run = Automation.runNow(c.req.valid("param").automationID)
        await Automation.publishRunUpdated(run)
        return c.json(run)
      },
    )
    .get(
      "/:automationID/runs",
      describeRoute({
        summary: "List automation runs",
        description: "List automation runs newest first.",
        operationId: "automation.runs",
        responses: {
          200: {
            description: "Automation runs",
            content: { "application/json": { schema: resolver(Automation.RunsResponse) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ automationID: AutomationID.Definition.zod })),
      validator(
        "query",
        z.object({
          limit: z.coerce.number().int().positive().max(100).optional(),
          cursor: AutomationID.Run.zod.optional(),
        }),
      ),
      (c) => c.json(Automation.runs({ automationID: c.req.valid("param").automationID, ...c.req.valid("query") })),
    )
