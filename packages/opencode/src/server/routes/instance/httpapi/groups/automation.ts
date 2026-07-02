import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, NotFoundError, WorkspaceRoutingQuery } from "./common"

const root = "/automation"

const AutomationDefinitionID = Schema.String.check(Schema.isPattern(/^automation_(?!run_)/))
const AutomationRunID = Schema.String.check(Schema.isPattern(/^automation_run_/))
const AutomationRunsLimit = Schema.NumberFromString.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThan(0)),
  Schema.check(Schema.isLessThanOrEqualTo(100)),
)

export const AutomationParam = Schema.Struct({
  automationID: AutomationDefinitionID,
})

export const AutomationRunsQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  limit: Schema.optionalKey(AutomationRunsLimit),
  cursor: Schema.optionalKey(AutomationRunID),
})

function constrainAutomationOpenApi(spec: Record<string, any>) {
  const parameters = spec.paths?.["/automation/{automationID}/runs"]?.get?.parameters
  if (!Array.isArray(parameters)) return spec

  const limit = parameters.find((parameter) => parameter.name === "limit")
  if (limit?.schema && typeof limit.schema === "object") {
    limit.schema = {
      ...limit.schema,
      type: "integer",
      exclusiveMinimum: 0,
      maximum: 100,
    }
  }

  return spec
}

const AutomationValidationError = Schema.Struct({
  error: Schema.Literal("invalid_automation"),
  details: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      message: Schema.String,
    }),
  ),
}).pipe(
  HttpApiSchema.status(422),
  (schema) =>
    schema.annotate({
      identifier: "AutomationValidationError",
      description: "Automation validation failed",
    }),
)

const AutomationConflictError = Schema.Struct({
  error: Schema.Literal("automation_conflict"),
  message: Schema.String,
}).pipe(
  HttpApiSchema.status(409),
  (schema) =>
    schema.annotate({
      identifier: "AutomationConflictError",
      description: "Automation update conflict",
    }),
)

export const AutomationApi = HttpApi.make("automation")
  .add(
    HttpApiGroup.make("automation")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.list",
            summary: "List automations",
            description: "List automation definitions for the current project.",
          }),
        ),
        HttpApiEndpoint.post("create", root, {
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, AutomationValidationError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.create",
            summary: "Create automation",
            description: "Create an automation definition without executing it.",
          }),
        ),
        HttpApiEndpoint.get("get", `${root}/:automationID`, {
          params: AutomationParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.get",
            summary: "Get automation",
            description: "Get one automation definition.",
          }),
        ),
        HttpApiEndpoint.put("update", `${root}/:automationID`, {
          params: AutomationParam,
          query: WorkspaceRoutingQuery,
          payload: Schema.Any,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, AutomationValidationError, AutomationConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.update",
            summary: "Update automation",
            description: "Update an automation definition.",
          }),
        ),
        HttpApiEndpoint.delete("delete", `${root}/:automationID`, {
          params: AutomationParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.delete",
            summary: "Delete automation",
            description:
              "Delete an automation definition, cancel future scheduling, and return a tombstone. Already-started runs continue to completion.",
          }),
        ),
        HttpApiEndpoint.get("runs", `${root}/:automationID/runs`, {
          params: AutomationParam,
          query: AutomationRunsQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.runs",
            summary: "List automation runs",
            description: "List automation runs newest first.",
          }),
        ),
        HttpApiEndpoint.post("runNow", `${root}/:automationID/run`, {
          params: AutomationParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.runNow",
            summary: "Run automation now",
            description:
              "Create a queued automation run, start execution in the background, and return the queued run immediately.",
          }),
        ),
        HttpApiEndpoint.post("pause", `${root}/:automationID/pause`, {
          params: AutomationParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, AutomationConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.pause",
            summary: "Pause automation",
            description: "Pause an automation definition.",
          }),
        ),
        HttpApiEndpoint.post("resume", `${root}/:automationID/resume`, {
          params: AutomationParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
          error: [BadRequestError, NotFoundError, AutomationConflictError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "automation.resume",
            summary: "Resume automation",
            description: "Resume a paused automation definition.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "automation",
          description: "HttpApi automation routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode automation HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for ordinary automation JSON routes.",
      transform: constrainAutomationOpenApi,
    }),
  )
