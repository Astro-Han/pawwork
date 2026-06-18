import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import { Provider } from "../../provider/provider"
import { ProviderAuth } from "../../provider/auth"
import { ProviderID, ModelID } from "../../provider/schema"
import { AppRuntime } from "../../effect/app-runtime"
import { errors } from "../error"
import { lazy } from "../../util/lazy"
import { Log } from "@opencode-ai/core/util/log"
import { authorizeProvider, completeProviderAuth, getAuthMethods, listProviders, recordRecentModel } from "./provider-actions"

const log = Log.create({ service: "server" })

const runProviderRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

export const ProviderRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List providers",
        description: "Get a list of all available AI providers, including both available and connected ones.",
        operationId: "provider.list",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    all: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                    connected: z.array(z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const providers = await runProviderRoute(listProviders())
        return c.json(providers)
      },
    )
    .get(
      "/auth",
      describeRoute({
        summary: "Get provider auth methods",
        description: "Retrieve available authentication methods for all AI providers.",
        operationId: "provider.auth",
        responses: {
          200: {
            description: "Provider auth methods",
            content: {
              "application/json": {
                schema: resolver(z.record(z.string(), z.array(ProviderAuth.Method))),
              },
            },
          },
        },
      }),
      async (c) => {
        const methods = await runProviderRoute(getAuthMethods())
        return c.json(methods)
      },
    )
    .post(
      "/:providerID/oauth/authorize",
      describeRoute({
        summary: "OAuth authorize",
        description: "Initiate OAuth authorization for a specific AI provider to get an authorization URL.",
        operationId: "provider.oauth.authorize",
        responses: {
          200: {
            description: "Authorization URL and method",
            content: {
              "application/json": {
                schema: resolver(ProviderAuth.Authorization.optional()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          inputs: z.record(z.string(), z.string()).optional().meta({ description: "Prompt inputs" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, inputs } = c.req.valid("json")
        const result = await runProviderRoute(authorizeProvider({ providerID, method, inputs }))
        return c.json(result)
      },
    )
    .post(
      "/:providerID/oauth/callback",
      describeRoute({
        summary: "OAuth callback",
        description: "Handle the OAuth callback from a provider after user authorization.",
        operationId: "provider.oauth.callback",
        responses: {
          200: {
            description: "OAuth callback processed successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "param",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
        }),
      ),
      validator(
        "json",
        z.object({
          method: z.number().meta({ description: "Auth method index" }),
          code: z.string().optional().meta({ description: "OAuth authorization code" }),
        }),
      ),
      async (c) => {
        const providerID = c.req.valid("param").providerID
        const { method, code } = c.req.valid("json")
        await runProviderRoute(completeProviderAuth({ providerID, method, code }))
        return c.json(true)
      },
    )
    .post(
      "/recent",
      describeRoute({
        summary: "Record recent model",
        description:
          "Persist the user's picked model as the recent default that model-less sessions (e.g. a Telegram /new) inherit. Called by the desktop model picker on an explicit pick.",
        operationId: "provider.recordRecent",
        responses: {
          200: {
            description: "Recorded",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          providerID: ProviderID.zod.meta({ description: "Provider ID" }),
          modelID: ModelID.zod.meta({ description: "Model ID" }),
        }),
      ),
      async (c) => {
        const { providerID, modelID } = c.req.valid("json")
        await runProviderRoute(recordRecentModel({ providerID, modelID }))
        return c.json(true)
      },
    ),
)
