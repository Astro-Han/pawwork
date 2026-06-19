import { Auth } from "@/auth"
import { ProviderID } from "@/provider/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const AuthParam = Schema.Struct({
  providerID: ProviderID,
})

const LogPayload = Schema.Struct({
  service: Schema.String,
  level: Schema.Literals(["debug", "info", "error", "warn"]),
  message: Schema.String,
  extra: Schema.optional(Schema.Record(Schema.String, Schema.Any)),
})

export const ControlApi = HttpApi.make("control")
  .add(
    HttpApiGroup.make("control")
      .add(
        HttpApiEndpoint.put("authSet", "/auth/:providerID", {
          params: AuthParam,
          payload: Auth.Info,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "auth.set",
            summary: "Set auth credentials",
            description: "Set authentication credentials",
          }),
        ),
        HttpApiEndpoint.delete("authRemove", "/auth/:providerID", {
          params: AuthParam,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "auth.remove",
            summary: "Remove auth credentials",
            description: "Remove authentication credentials",
          }),
        ),
        HttpApiEndpoint.post("log", "/log", {
          query: WorkspaceRoutingQuery,
          payload: LogPayload,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "app.log",
            summary: "Write log",
            description: "Write a log entry to the server logs with specified level and metadata.",
          }),
        ),
        HttpApiEndpoint.get("doc", "/doc", {
          success: Schema.Any,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "doc",
            summary: "Get OpenAPI document",
            description: "Return the server OpenAPI document.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "control",
          description: "HttpApi control-plane JSON routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode control HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for control-plane JSON routes.",
    }),
  )
