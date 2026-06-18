import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const MemoryRawPayload = Schema.Struct({
  content: Schema.String,
})

const MemoryDisabledPayload = Schema.Struct({
  disabled: Schema.Boolean,
})

const MemoryEntryParam = Schema.Struct({
  id: Schema.String,
})

export const MemoryApi = HttpApi.make("memory")
  .add(
    HttpApiGroup.make("memory")
      .add(
        HttpApiEndpoint.get("get", "/memory", {
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.get",
            summary: "Get PawWork memory",
          }),
        ),
        HttpApiEndpoint.patch("update", "/memory", {
          query: WorkspaceRoutingQuery,
          payload: MemoryRawPayload,
          success: Schema.Any,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.update",
            summary: "Update raw PawWork memory",
          }),
        ),
        HttpApiEndpoint.post("reset", "/memory/reset", {
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.reset",
            summary: "Reset PawWork memory",
          }),
        ),
        HttpApiEndpoint.patch("disabled", "/memory/disabled", {
          query: WorkspaceRoutingQuery,
          payload: MemoryDisabledPayload,
          success: Schema.Any,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.disabled",
            summary: "Disable or enable PawWork memory",
          }),
        ),
        HttpApiEndpoint.delete("deleteEntry", "/memory/entry/:id", {
          params: MemoryEntryParam,
          query: WorkspaceRoutingQuery,
          success: Schema.Any,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "memory.deleteEntry",
            summary: "Delete PawWork memory entry",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "memory",
          description: "HttpApi PawWork memory routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode memory HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for PawWork memory routes.",
    }),
  )
