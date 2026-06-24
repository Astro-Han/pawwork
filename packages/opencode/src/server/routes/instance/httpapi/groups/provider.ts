import {
  Authorization as ProviderAuthAuthorization,
  AuthorizeInput as ProviderAuthAuthorizeInput,
  CallbackInput as ProviderAuthCallbackInput,
  Methods as ProviderAuthMethods,
} from "@/provider/auth"
import { ListResult } from "@/provider/provider"
import { ModelID, ProviderID } from "@/provider/schema"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { BadRequestError, WorkspaceRoutingQuery } from "./common"

const root = "/provider"

const ProviderParam = Schema.Struct({
  providerID: ProviderID,
})

export const RecentModelInput = Schema.Struct({
  providerID: ProviderID,
  modelID: ModelID,
})

export const FetchedModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})

export const FetchModelsResult = Schema.Struct({
  models: Schema.Array(FetchedModel),
})

export const FetchModelsError = Schema.Struct({
  message: Schema.String,
}).pipe(
  HttpApiSchema.status(400),
  (schema) =>
    schema.annotate({
      identifier: "FetchModelsError",
      description: "Failed to reach or parse the provider's models endpoint.",
    }),
)

export const ProviderApi = HttpApi.make("provider")
  .add(
    HttpApiGroup.make("provider")
      .add(
        HttpApiEndpoint.get("list", root, {
          query: WorkspaceRoutingQuery,
          success: ListResult,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.list",
            summary: "List providers",
            description: "Get a list of all available AI providers, including both available and connected ones.",
          }),
        ),
        HttpApiEndpoint.get("auth", `${root}/auth`, {
          query: WorkspaceRoutingQuery,
          success: ProviderAuthMethods,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.auth",
            summary: "Get provider auth methods",
            description: "Retrieve available authentication methods for all AI providers.",
          }),
        ),
        HttpApiEndpoint.post("authorize", `${root}/:providerID/oauth/authorize`, {
          params: ProviderParam,
          query: WorkspaceRoutingQuery,
          payload: ProviderAuthAuthorizeInput,
          success: Schema.UndefinedOr(ProviderAuthAuthorization),
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.authorize",
            summary: "OAuth authorize",
            description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
          }),
        ),
        HttpApiEndpoint.post("callback", `${root}/:providerID/oauth/callback`, {
          params: ProviderParam,
          query: WorkspaceRoutingQuery,
          payload: ProviderAuthCallbackInput,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.oauth.callback",
            summary: "OAuth callback",
            description: "Handle the OAuth callback from a provider after user authorization.",
          }),
        ),
        HttpApiEndpoint.post("recent", `${root}/recent`, {
          query: WorkspaceRoutingQuery,
          payload: RecentModelInput,
          success: Schema.Boolean,
          error: BadRequestError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.recordRecent",
            summary: "Record recent model",
            description:
              "Persist the user's picked model as the recent default that model-less sessions (e.g. a Telegram /new) inherit. Called by the desktop model picker on an explicit pick.",
          }),
        ),
        HttpApiEndpoint.post("fetchModels", `${root}/:providerID/models`, {
          params: ProviderParam,
          query: WorkspaceRoutingQuery,
          success: FetchModelsResult,
          error: FetchModelsError,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "provider.fetchModels",
            summary: "Fetch provider models",
            description:
              "Discover an OpenAI-compatible provider's models live from its /models endpoint using the provider's configured base URL, auth, and headers. Returns the parsed list without persisting it.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "provider",
          description: "HttpApi provider routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode provider HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for the provider route group.",
    }),
  )
