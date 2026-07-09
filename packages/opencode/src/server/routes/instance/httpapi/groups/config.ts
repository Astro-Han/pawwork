import { ConfigLoadError, Info as ConfigInfo } from "@/config/config"
import { ConfigProvidersResult } from "@/provider/provider"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const root = "/config"

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
        HttpApiEndpoint.get("errors", `${root}/errors`, {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(ConfigLoadError),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "config.errors",
            summary: "List config load errors",
            description:
              "List config files that failed to load (invalid JSON or schema). The rest of the config still loads; this lets the app surface one readable message instead of failing repeatedly.",
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
