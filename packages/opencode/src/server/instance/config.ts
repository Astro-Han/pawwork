import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { Effect } from "effect"
import z from "zod"
import { Config } from "../../config/config"
import { Provider } from "../../provider/provider"
import { AppRuntime } from "../../effect/app-runtime"
import { mapValues } from "remeda"
import { errors } from "../error"
import { Log } from "@opencode-ai/core/util/log"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "server" })
const runConfigRoute: typeof AppRuntime.runPromise = (effect, options) => AppRuntime.runPromise(effect, options)

export const getConfig = Effect.fn("ConfigRoutes.get")(function* () {
  const config = yield* Config.Service
  return yield* config.get()
})

export const updateConfig = Effect.fn("ConfigRoutes.update")(function* (input: Config.Info) {
  const config = yield* Config.Service
  yield* config.update(input)
})

export const listConfigProviders = Effect.fn("ConfigRoutes.providers")(function* () {
  const provider = yield* Provider.Service
  return yield* provider.list()
})

export const ConfigRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get configuration",
        description: "Retrieve the current OpenCode configuration settings and preferences.",
        operationId: "config.get",
        responses: {
          200: {
            description: "Get config info",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
        },
      }),
      async (c) => {
        const config = await runConfigRoute(getConfig())
        return c.json(config)
      },
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update configuration",
        description: "Update OpenCode configuration settings and preferences.",
        operationId: "config.update",
        responses: {
          200: {
            description: "Successfully updated config",
            content: {
              "application/json": {
                schema: resolver(Config.Info.zod),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", Config.Info.zod),
      async (c) => {
        const config = c.req.valid("json")
        await runConfigRoute(updateConfig(config))
        return c.json(config)
      },
    )
    .get(
      "/providers",
      describeRoute({
        summary: "List config providers",
        description: "Get a list of all configured AI providers and their default models.",
        operationId: "config.providers",
        responses: {
          200: {
            description: "List of providers",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    providers: Provider.Info.array(),
                    default: z.record(z.string(), z.string()),
                  }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        using _ = log.time("providers")
        const providers = await runConfigRoute(listConfigProviders())
        return c.json({
          providers: Object.values(providers),
          default: mapValues(providers, (item) => Provider.defaultModelID(item)),
        })
      },
    ),
)
