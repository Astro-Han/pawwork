import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingQuery } from "./common"

const PendingExternalResult = Schema.Struct({
  session: Schema.Any,
  message: Schema.Any,
  part: Schema.Any,
})

export const ExternalResultApi = HttpApi.make("externalResult")
  .add(
    HttpApiGroup.make("externalResult")
      .add(
        HttpApiEndpoint.get("list", "/external-result", {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(PendingExternalResult),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "externalResult.list",
            summary: "List pending external-result tool calls",
            description:
              "Return the (session, message, part) trio for every external-result Deferred currently awaiting a user response.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "external-result",
          description: "HttpApi external-result routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode external-result HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for external-result routes.",
    }),
  )
