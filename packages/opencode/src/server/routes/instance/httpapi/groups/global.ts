import { Info as ConfigInfo } from "@/config/config"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError } from "./common"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const GlobalDisposeResult = Schema.Struct({
  status: Schema.Literals(["completed", "deferred"]),
  lifecycleActionID: Schema.String,
  affectedDirectoryKeys: Schema.Array(Schema.String),
})

const GlobalUpgradePayload = Schema.Struct({
  target: Schema.optionalKey(Schema.String),
})

const GlobalUpgradeSuccess = Schema.Struct({
  success: Schema.Literal(true),
  version: Schema.String,
})

const GlobalUpgradeFailure = Schema.Struct({
  success: Schema.Literal(false),
  error: Schema.String,
})

const GlobalUpgradeBadRequest = GlobalUpgradeFailure.pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "GlobalUpgradeBadRequest",
      description: "Global upgrade request cannot be fulfilled",
    }),
)

const GlobalUpgradeServerError = GlobalUpgradeFailure.pipe(
  HttpApiSchema.status(500),
  (schema) =>
    schema.annotate({
      identifier: "GlobalUpgradeServerError",
      description: "Global upgrade failed",
    }),
)

export const GlobalPaths = {
  config: "/global/config",
  health: "/global/health",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
} as const

export const GlobalApi = HttpApi.make("global")
  .add(
    HttpApiGroup.make("global")
      .add(
        HttpApiEndpoint.get("configGet", GlobalPaths.config, {
          success: ConfigInfo,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "global.config.get",
            summary: "Get global configuration",
            description: "Retrieve the current global OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
          payload: ConfigInfo,
          success: ConfigInfo,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "global.config.update",
            summary: "Update global configuration",
            description: "Update global OpenCode configuration settings and preferences.",
          }),
        ),
        HttpApiEndpoint.get("health", GlobalPaths.health, {
          success: GlobalHealth,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "global.health",
            summary: "Get health",
            description: "Get health information about the OpenCode server.",
          }),
        ),
        HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
          success: GlobalDisposeResult,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "global.dispose",
            summary: "Dispose instance",
            description: "Clean up and dispose all OpenCode instances, releasing all resources.",
          }),
        ),
        HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
          payload: GlobalUpgradePayload,
          success: Schema.Union([GlobalUpgradeSuccess, GlobalUpgradeFailure]),
          error: [BadRequestError, GlobalUpgradeBadRequest, GlobalUpgradeServerError],
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "global.upgrade",
            summary: "Upgrade opencode",
            description: "Upgrade opencode to the specified version or latest if not specified.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "global",
          description: "HttpApi global control routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode global HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for global control routes.",
    }),
  )
