import { Info as ConfigInfo } from "@/config/config"
import { ConfigProvidersResult } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"

const root = "/config"

export const WorkspaceRoutingQuery = Schema.Struct({
  directory: Schema.optionalKey(Schema.String),
  workspace: Schema.optionalKey(Schema.String),
})

export const BadRequestError = Schema.Struct({
  data: Schema.Any,
  errors: Schema.Array(Schema.Record(Schema.String, Schema.Any)),
  success: Schema.Literal(false),
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "BadRequestError",
      description: "Bad request",
    }),
)

export const ConfigApi = HttpApi.make("config")
  .add(
    HttpApiGroup.make("config")
      .add(
        HttpApiEndpoint.get("get", root, {
          query: WorkspaceRoutingQuery,
          success: ConfigInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.get",
            summary: "Get configuration",
            description: "Retrieve the current OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("update", root, {
          query: WorkspaceRoutingQuery,
          // Declaration only in this trial; the handler mirrors Hono's validator("json", Config.Info.zod).
          payload: ConfigInfo,
          success: ConfigInfo,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.update",
            summary: "Update configuration",
            description: "Update OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("providers", `${root}/providers`, {
          query: WorkspaceRoutingQuery,
          success: ConfigProvidersResult,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.providers",
            summary: "List config providers",
            description: "Get a list of all configured AI providers and their default models.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "config",
          description: "HttpApi config routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode config HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for the config route group.",
    }),
  )
