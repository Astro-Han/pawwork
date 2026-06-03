import { PlanExitTool } from "./plan"
import { Session } from "../session"
import { QuestionTool } from "./question"
import { ShellTool } from "./shell"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { ReadTool } from "./read"
import { AgentTool } from "./agent"
import { AgentListTool } from "./agent-list"
import { AgentOutputTool } from "./agent-output"
import { TodoWriteTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import { DEFERRED_TOOL_IDS, TOOL_INFO_ID, ToolInfoTool, buildCardList } from "./tool-info"
import * as Tool from "./tool"
import { Config } from "../config/config"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { Provider } from "../provider/provider"
import { ProviderID, type ModelID } from "../provider/schema"
import { WebSearchTool } from "./websearch"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Settings } from "@/settings"
import { Log } from "@opencode-ai/core/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncate"
import { WebSearchAuth } from "./websearch-auth"
import { ApplyPatchTool } from "./apply_patch"
import { EnterWorktreeTool } from "./enter-worktree"
import { ExitWorktreeTool } from "./exit-worktree"
import { AutomateTool } from "./automate"
import { Automation } from "@/automation"
import { Permission } from "../permission"
import { Glob } from "../util/glob"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { ZodOverride } from "@/util/effect-zod"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "../file/ripgrep"
import { Format } from "../format"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"
import { Env } from "../env"
import { Todo } from "../session/todo"
import { TurnChange } from "../session/turn-change"
import { LSP } from "../lsp"
import { Instruction } from "../session/instruction"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../bus"
import { Agent } from "../agent/agent"
import { Skill } from "../skill"
import { SubagentRun } from "../session/subagent-run"
import { needsConfigDependencies, usesConfigDependencies } from "../config/dependency"

export function localToolImportSpec(input: string) {
  return input.startsWith("file://") ? input : pathToFileURL(input).href
}

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  type AgentDef = Tool.InferDef<typeof AgentTool>
  type ReadDef = Tool.InferDef<typeof ReadTool>

  type State = {
    custom: Tool.Def[]
    builtin: Tool.Def[]
    agent: AgentDef
    read: ReadDef
  }

  export interface Interface {
    readonly ids: () => Effect.Effect<string[]>
    readonly all: () => Effect.Effect<Tool.Def[]>
    readonly named: () => Effect.Effect<{ agent: AgentDef; read: ReadDef }>
    readonly tools: (model: {
      providerID: ProviderID
      modelID: ModelID
      agent: Agent.Info
      activatedTools?: ReadonlySet<string>
      deferredAvailable?: (id: string) => boolean
    }) => Effect.Effect<Tool.Def[]>
    readonly invalidate: () => Effect.Effect<void>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  export const layer: Layer.Layer<
    Service,
    never,
    | Config.Service
    | Plugin.Service
    | Todo.Service
    | TurnChange.Service
    | Agent.Service
    | Skill.Service
    | Session.Service
    | SubagentRun.Service
    | Provider.Service
    | LSP.Service
    | Settings.Service
    | WebSearchAuth.Service
    | Instruction.Service
    | AppFileSystem.Service
    | Bus.Service
    | HttpClient.HttpClient
    | ChildProcessSpawner
    | Ripgrep.Service
    | Format.Service
    | Truncate.Service
    | Automation.Service
  > = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const plugin = yield* Plugin.Service
      const agents = yield* Agent.Service
      const skill = yield* Skill.Service
      const truncate = yield* Truncate.Service
      const settings = yield* Settings.Service

      const invalid = yield* InvalidTool
      const agent = yield* AgentTool
      const agentList = yield* AgentListTool
      const agentOutput = yield* AgentOutputTool
      const read = yield* ReadTool
      const question = yield* QuestionTool
      const todo = yield* TodoWriteTool
      const lsptool = yield* LspTool
      const plan = yield* PlanExitTool
      const webfetch = yield* WebFetchTool
      const websearch = yield* WebSearchTool
      const bash = yield* ShellTool
      const globtool = yield* GlobTool
      const writetool = yield* WriteTool
      const edit = yield* EditTool
      const greptool = yield* GrepTool
      const patchtool = yield* ApplyPatchTool
      const skilltool = yield* SkillTool
      const enterWorktree = yield* EnterWorktreeTool
      const exitWorktree = yield* ExitWorktreeTool
      const automate = yield* AutomateTool

      const toolInfoInfo = yield* ToolInfoTool((toolID, output) =>
        plugin.trigger("tool.definition", { toolID }, output),
      )

      const state = yield* InstanceState.make<State>(
        Effect.fn("ToolRegistry.state")(function* (ctx) {
          const lspEnabled = yield* settings.lspEnabled()
          const webSearchEnabled = yield* settings.webSearchEnabled()
          const custom: Tool.Def[] = []

          function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
            // Plugin tools define their args as a raw Zod shape. Wrap the derived
            // Zod object in `Schema.declare` so it slots into the Schema-typed
            // framework, and annotate with `ZodOverride` so the walker emits the
            // original Zod for LLM JSON Schema generation.
            const zodParams = z.object(def.args)
            const parameters = Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success).annotate({
              [ZodOverride]: zodParams,
            })
            return {
              id,
              parameters,
              description: def.description,
              execute: (args, toolCtx) =>
                Effect.gen(function* () {
                  const pluginCtx: PluginToolContext = {
                    ...toolCtx,
                    ask: (req) => toolCtx.ask(req),
                    directory: ctx.directory,
                    worktree: ctx.worktree,
                  }
                  const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
                  const agent = yield* Effect.promise(() => Agent.get(toolCtx.agent))
                  const out = yield* truncate.output(result, {}, agent)
                  return {
                    title: "",
                    output: out.truncated ? out.content : result,
                    metadata: {
                      truncated: out.truncated,
                      outputPath: out.truncated ? out.outputPath : undefined,
                    },
                  }
                }).pipe(
                  Effect.withSpan("Tool.execute", {
                    attributes: {
                      "tool.name": id,
                      "session.id": toolCtx.sessionID,
                      "message.id": toolCtx.messageID,
                      ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
                    },
                  }),
                ),
            }
          }

          const dirs = yield* config.directories()
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          const cfg = yield* config.get()
          const rules = Permission.fromConfig(cfg.permission ?? {})
          const depsReady = new Set<string>()
          const depsFailed = new Set<string>()
          for (const match of matches) {
            const namespace = path.basename(match, path.extname(match))
            const text = yield* Effect.promise(() => Bun.file(match).text())
            const named = Array.from(
              text.matchAll(/export\s+(?:const|let|var|async function|function)\s+([A-Za-z_$][\w$]*)/g),
              (item) => `${namespace}_${item[1]}`,
            )
            const ids = [...(text.includes("export default") ? [namespace] : []), ...named]
            const disabled = new Set([
              ...ids.filter((id) => cfg.tools?.[id] === false),
              ...Permission.disabled(ids, rules),
            ])
            if (ids.length && ids.every((id) => disabled.has(id))) continue
            const spec = localToolImportSpec(match)
            const configDir = path.dirname(path.dirname(match))
            const usesDeps = yield* Effect.promise(() => usesConfigDependencies(match))
            if (usesDeps && depsFailed.has(configDir)) continue
            if (usesDeps && !depsReady.has(configDir)) {
              depsReady.add(configDir)
              const needsDeps = yield* Effect.promise(() => needsConfigDependencies(match, configDir))
              yield* config.waitForDependencies()
              if (needsDeps) {
                const installed = yield* Effect.promise(async () => {
                  try {
                    return await Config.installDependencies(configDir)
                  } catch (error) {
                    log.warn("failed to install config dependencies for local tool", {
                      dir: configDir,
                      error: String(error),
                    })
                    return false
                  }
                })
                if (!installed) {
                  depsFailed.add(configDir)
                  continue
                }
              }
            }
            const mod = yield* Effect.promise(() => import(spec))
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          const plugins = yield* plugin.list()
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
            }
          }
          const questionEnabled =
            ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

          const tool = yield* Effect.all({
            invalid: Tool.init(invalid),
            bash: Tool.init(bash),
            read: Tool.init(read),
            glob: Tool.init(globtool),
            grep: Tool.init(greptool),
            edit: Tool.init(edit),
            write: Tool.init(writetool),
            agent: Tool.init(agent),
            agentList: Tool.init(agentList),
            agentOutput: Tool.init(agentOutput),
            fetch: Tool.init(webfetch),
            todo: Tool.init(todo),
            search: Tool.init(websearch),
            skill: Tool.init(skilltool),
            patch: Tool.init(patchtool),
            question: Tool.init(question),
            lsp: Tool.init(lsptool),
            plan: Tool.init(plan),
            enterWorktree: Tool.init(enterWorktree),
            exitWorktree: Tool.init(exitWorktree),
            automate: Tool.init(automate),
            toolInfo: Tool.init(toolInfoInfo),
          })

          return {
            custom,
            builtin: [
              tool.invalid,
              ...(questionEnabled ? [tool.question] : []),
              tool.bash,
              tool.read,
              tool.glob,
              tool.grep,
              tool.edit,
              tool.write,
              tool.agent,
              tool.agentList,
              tool.agentOutput,
              tool.fetch,
              tool.todo,
              ...(webSearchEnabled ? [tool.search] : []),
              tool.skill,
              tool.toolInfo,
              tool.patch,
              ...(lspEnabled ? [tool.lsp] : []),
              ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [tool.plan] : []),
              tool.automate,
              tool.enterWorktree,
              tool.exitWorktree,
            ],
            agent: tool.agent,
            read: tool.read,
          }
        }),
      )

      const all: Interface["all"] = Effect.fn("ToolRegistry.all")(function* () {
        const s = yield* InstanceState.get(state)
        return [...s.builtin, ...s.custom] as Tool.Def[]
      })

      const ids: Interface["ids"] = Effect.fn("ToolRegistry.ids")(function* () {
        return (yield* all()).map((tool) => tool.id)
      })

      const describeSkill = Effect.fn("ToolRegistry.describeSkill")(function* (agent: Agent.Info) {
        const list = yield* skill.available(agent)
        const visible = Skill.displayable(list)
        if (visible.length === 0) return Skill.fmt(visible, { verbose: false })
        return [
          "Load a specialized skill that provides domain-specific instructions and workflows.",
          "",
          "When you recognize that a task matches one of the available skills listed below, use this tool to load the full skill instructions.",
          "",
          "The skill will inject detailed instructions, workflows, and access to bundled resources (scripts, references, templates) into the conversation context.",
          "",
          'Tool output includes a `<skill_content name="...">` block with the loaded content.',
          "",
          "The following skills provide specialized sets of instructions for particular tasks",
          "Invoke this tool to load a skill when a task matches one of the available skills listed below:",
          "",
          Skill.fmt(visible, { verbose: false }),
        ].join("\n")
      })

      const describeTask = Effect.fn("ToolRegistry.describeTask")(function* (agent: Agent.Info) {
        const items = (yield* agents.list()).filter((item) => item.mode !== "primary")
        const filtered = items.filter(
          (item) => Permission.evaluate("agent", item.name, agent.permission).action !== "deny",
        )
        const list = filtered.toSorted((a, b) => a.name.localeCompare(b.name))
        const description = list
          .map(
            (item) =>
              `- ${item.name}: ${item.description ?? "This subagent should only be called manually by the user."}`,
          )
          .join("\n")
        return ["Available agent types and the tools they have access to:", description].join("\n")
      })

      const tools: Interface["tools"] = Effect.fn("ToolRegistry.tools")(function* (input) {
        const webSearchEnabled = yield* settings.webSearchEnabled()
        const filtered = (yield* all()).filter((tool) => {
          if (tool.id === WebSearchTool.id) return webSearchEnabled

          const usePatch =
            !!Env.get("OPENCODE_E2E_LLM_URL") ||
            (input.modelID.includes("gpt-") && !input.modelID.includes("oss") && !input.modelID.includes("gpt-4"))
          if (tool.id === ApplyPatchTool.id) return usePatch
          if (tool.id === EditTool.id || tool.id === WriteTool.id) return !usePatch

          if (DEFERRED_TOOL_IDS.has(tool.id)) {
            const available = input.deferredAvailable?.(tool.id) ?? true
            return available && (input.activatedTools?.has(tool.id) ?? false)
          }

          return true
        })

        const availableDeferred = [...DEFERRED_TOOL_IDS].filter(
          (id) => (input.deferredAvailable?.(id) ?? true) && !(input.activatedTools?.has(id) ?? false),
        )

        return yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool: Tool.Def) {
            using _ = log.time(tool.id)
            const output = {
              description: tool.description,
              parameters: tool.parameters,
            }
            yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              description: [
                output.description,
                tool.id === AgentTool.id ? yield* describeTask(input.agent) : undefined,
                tool.id === SkillTool.id ? yield* describeSkill(input.agent) : undefined,
                tool.id === TOOL_INFO_ID ? buildCardList(availableDeferred) : undefined,
              ]
                .filter(Boolean)
                .join("\n"),
              parameters: output.parameters,
              execute: tool.execute,
              formatValidationError: tool.formatValidationError,
            }
          }),
          { concurrency: "unbounded" },
        )
      })

      const named: Interface["named"] = Effect.fn("ToolRegistry.named")(function* () {
        const s = yield* InstanceState.get(state)
        return { agent: s.agent, read: s.read }
      })

      const invalidate: Interface["invalidate"] = Effect.fn("ToolRegistry.invalidate")(function* () {
        yield* InstanceState.invalidate(state)
      })

      return Service.of({ ids, all, named, tools, invalidate })
    }),
  )

  export const defaultLayer = Layer.suspend(() =>
    layer.pipe(
      Layer.provide(Config.defaultLayer),
      Layer.provide(Plugin.defaultLayer),
      Layer.provide(Layer.mergeAll(Todo.defaultLayer, TurnChange.defaultLayer)),
      Layer.provide(Skill.defaultLayer),
      Layer.provide(Agent.defaultLayer),
      Layer.provide(Session.defaultLayer),
      Layer.provide(SubagentRun.defaultLayer),
      Layer.provide(Provider.defaultLayer),
      Layer.provide(LSP.defaultLayer),
      Layer.provide(Settings.defaultLayer),
      Layer.provide(WebSearchAuth.defaultLayer),
      Layer.provide(Instruction.defaultLayer),
      Layer.provide(AppFileSystem.defaultLayer),
      Layer.provide(Bus.layer),
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Format.defaultLayer),
      Layer.provide(CrossSpawnSpawner.defaultLayer),
      Layer.provide(Ripgrep.defaultLayer),
      Layer.provide(Truncate.defaultLayer),
      Layer.provide(Automation.defaultLayer),
    ),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  export async function tools(input: {
    providerID: ProviderID
    modelID: ModelID
    agent: Agent.Info
    activatedTools?: ReadonlySet<string>
    deferredAvailable?: (id: string) => boolean
  }): Promise<(Tool.Def & { id: string })[]> {
    return runPromise((svc) => svc.tools(input))
  }

  export async function invalidate() {
    return runPromise((svc) => svc.invalidate())
  }
}
