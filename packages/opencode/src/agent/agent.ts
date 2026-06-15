import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncate"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Plugin } from "@/plugin"
import { Effect, Context, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Global } from "@opencode-ai/core/global"
import { aiSdkTracer } from "@opencode-ai/core/effect/observability"
import path from "path"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: Permission.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly get: (agent: string) => Effect.Effect<Agent.Info>
    readonly list: () => Effect.Effect<Agent.Info[]>
    readonly defaultAgent: () => Effect.Effect<string>
    readonly generate: (input: {
      description: string
      model?: { providerID: ProviderID; modelID: ModelID }
    }) => Effect.Effect<{
      identifier: string
      whenToUse: string
      systemPrompt: string
    }>
  }

  type State = Omit<Interface, "generate">

  export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const provider = yield* Provider.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Agent.state")(function* (ctx) {
          const cfg = yield* config.get()

          const defaults = Permission.fromConfig({
            "*": "allow",
            doom_loop: "ask",
            // Web automation (browser_* tools and the opencli adapters) inherits
            // the "*": "allow" baseline by design: the embedded browser is local
            // and fully visible to the user, which is the safety net (browser
            // design §9). It stays consistent with file editing, which is also
            // default-allow. Tighten per target with permission rules if ever
            // needed — the gate is default-open, not absent.
            question: "deny",
            plan_enter: "deny",
            plan_exit: "deny",
            read: {
              "*": "allow",
              "*.env": "ask",
              "*.env.*": "ask",
              "*.env.example": "allow",
            },
            bash: {
              "*": "allow",
              "sudo *": "ask",
              "dd *": "deny",
              "mkfs*": "deny",
              "rm *": "deny",
              "rmdir *": "deny",
              "unlink *": "deny",
              "find * -delete*": "deny",
              "Remove-Item *": "deny",
              "del *": "deny",
              "erase *": "deny",
              "rd *": "deny",
            },
            external_directory: {
              "*": "allow",
            },
          })

          const user = Permission.fromConfig(cfg.permission ?? {})

          const agents: Record<string, Info> = {
            build: {
              name: "build",
              description: "The default agent. Executes tools based on configured permissions.",
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                }),
                user,
              ),
              mode: "primary",
              native: true,
            },
            // PawWork: visible Plan mode permanently removed (issue #239); resolve sync
            // conflicts in this region to HEAD. Plan capability migrated to plan tool per #127.
            general: {
              name: "general",
              description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  todowrite: "deny",
                }),
                user,
              ),
              options: {},
              mode: "subagent",
              native: true,
            },
            explore: {
              name: "explore",
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                  grep: "allow",
                  glob: "allow",
                  bash: "allow",
                  webfetch: "allow",
                  websearch: "allow",
                  read: "allow",
                  external_directory: {
                    "*": "allow",
                  },
                }),
                user,
              ),
              description: `Fast agent specialized for broad codebase exploration when the parent does not yet know the right files or symbols to inspect. Use this for unknown-entry searches, cross-directory pattern discovery, or independent research that can return one concise summary. Do not use it when the parent already knows the target file, symbol, or 1-3 likely files; read/search directly instead. When calling this agent, specify the desired thoroughness level (retrieval budget): "quick" for basic searches, "medium" for moderate exploration, or "very thorough" only for genuinely broad analysis across multiple locations and naming conventions.`,
              prompt: PROMPT_EXPLORE,
              options: {},
              mode: "subagent",
              native: true,
            },
            compaction: {
              name: "compaction",
              mode: "primary",
              native: true,
              hidden: true,
              prompt: PROMPT_COMPACTION,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              options: {},
            },
            title: {
              name: "title",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              temperature: 0.5,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_TITLE,
            },
            summary: {
              name: "summary",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_SUMMARY,
            },
          }

          for (const [key, value] of Object.entries(cfg.agent ?? {})) {
            if (value.disable) {
              delete agents[key]
              continue
            }
            let item = agents[key]
            if (!item)
              item = agents[key] = {
                name: key,
                mode: "all",
                permission: Permission.merge(defaults, user),
                options: {},
                native: false,
              }
            if (value.model) item.model = Provider.parseModel(value.model)
            item.variant = value.variant ?? item.variant
            item.prompt = value.prompt ?? item.prompt
            item.description = value.description ?? item.description
            item.temperature = value.temperature ?? item.temperature
            item.topP = value.top_p ?? item.topP
            item.mode = value.mode ?? item.mode
            item.color = value.color ?? item.color
            item.hidden = value.hidden ?? item.hidden
            item.name = value.name ?? item.name
            item.steps = value.steps ?? item.steps
            item.options = mergeDeep(item.options, value.options ?? {})
            item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          }

          // Ensure runtime-owned helper dirs are allowed unless explicitly configured.
          for (const name in agents) {
            const agent = agents[name]
            const allow: Record<string, "allow"> = {}
            for (const pattern of [Truncate.GLOB, path.join(Global.Path.tmp, "*")]) {
              const explicit = agent.permission.some((r) => {
                if (r.permission !== "external_directory") return false
                if (r.action !== "deny") return false
                return r.pattern === pattern
              })
              if (!explicit) allow[pattern] = "allow"
            }
            if (Object.keys(allow).length > 0) {
              agents[name].permission = Permission.merge(
                agents[name].permission,
                Permission.fromConfig({ external_directory: allow }),
              )
            }
          }

          const get = Effect.fnUntraced(function* (agent: string) {
            yield* Effect.void
            return agents[agent]
          })

          const list = Effect.fnUntraced(function* () {
            yield* Effect.void
            return pipe(
              agents,
              values(),
              sortBy(
                [(x) => x.name === "build", "desc"],
                [(x) => x.name, "asc"],
              ),
            )
          })

          const defaultAgent = Effect.fnUntraced(function* () {
            yield* Effect.void
            const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
            if (!visible) throw new Error("no primary visible agent found")
            return visible.name
          })

          return {
            get,
            list,
            defaultAgent,
          } satisfies State
        }),
      )

      return Service.of({
        get: Effect.fn("Agent.get")(function* (agent: string) {
          return yield* InstanceState.useEffect(state, (s) => s.get(agent))
        }),
        list: Effect.fn("Agent.list")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.list())
        }),
        defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
        }),
        generate: Effect.fn("Agent.generate")(function* (input: {
          description: string
          model?: { providerID: ProviderID; modelID: ModelID }
        }) {
          const cfg = yield* config.get()
          const model = input.model ?? (yield* provider.defaultModel().pipe(Effect.orDie))
          const resolved = yield* provider.getModel(model.providerID, model.modelID)
          const language = yield* provider.getLanguage(resolved)

          const system = [PROMPT_GENERATE]
          yield* Effect.promise(() =>
            Plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system }),
          )
          const existing = yield* InstanceState.useEffect(state, (s) => s.list())

          // TODO: clean this up so provider specific logic doesnt bleed over
          const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
          const isOpenaiOauth = model.providerID === "openai" && authInfo?.type === "oauth"

          // Resolve the registered OTel tracer so AI-SDK spans export; without it
          // the SDK falls back to the no-op global tracer. Only on the opt-in path.
          const tracer = cfg.experimental?.openTelemetry ? yield* aiSdkTracer : undefined

          const params = {
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              tracer,
              metadata: {
                userId: cfg.username ?? "unknown",
              },
            },
            temperature: 0.3,
            messages: [
              ...(isOpenaiOauth
                ? []
                : system.map(
                    (item): ModelMessage => ({
                      role: "system",
                      content: item,
                    }),
                  )),
              {
                role: "user",
                content: `Create an agent configuration based on this request: "${input.description}".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
              },
            ],
            model: language,
            schema: z.object({
              identifier: z.string(),
              whenToUse: z.string(),
              systemPrompt: z.string(),
            }),
          } satisfies Parameters<typeof generateObject>[0]

          if (isOpenaiOauth) {
            return yield* Effect.promise(async () => {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, {
                  instructions: system.join("\n"),
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            })
          }

          return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Provider.defaultLayer),
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(agent: string) {
    return runPromise((svc) => svc.get(agent))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function defaultAgent() {
    return runPromise((svc) => svc.defaultAgent())
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    return runPromise((svc) => svc.generate(input))
  }
}
