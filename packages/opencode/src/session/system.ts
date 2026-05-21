import { Context, Effect, Layer } from "effect"

import { Instance } from "../project/instance"

import PROMPT_PAWWORK from "./prompt/pawwork.txt"
import type { SessionExecutionContext } from "./execution-context"
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

export function provider(_model: Provider.Model) {
  return [PROMPT_PAWWORK]
}

export type SessionEnvironmentContext = Pick<
  SessionExecutionContext,
  "ownerDirectory" | "activeDirectory" | "activeWorktree"
>

export type EnvironmentInput = {
  model: Provider.Model
  locale?: string
  executionContext?: SessionEnvironmentContext
}

export interface Interface {
  readonly environment: (input: EnvironmentInput) => string[]
  readonly skills: (agent: Agent.Info) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SystemPrompt") {}

export function renderSessionEnvironment(input: {
  model: Provider.Model
  locale?: string
  project: { vcs?: string }
  executionContext: SessionEnvironmentContext
}) {
  const env = [
    `You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`,
    `Here is some useful information about the environment you are running in:`,
    `<env>`,
    `  Working directory: ${input.executionContext.activeDirectory}`,
    `  Workspace root folder: ${input.executionContext.ownerDirectory}`,
    `  Is directory a git repo: ${input.project.vcs === "git" ? "yes" : "no"}`,
    `  Platform: ${process.platform}`,
    `  Today's date: ${new Date().toDateString()}`,
  ]

  if (input.locale) env.push(`  User locale: ${input.locale}`)

  env.push(`</env>`)
  return [env.join("\n")]
}

function ambientExecutionContext(): SessionEnvironmentContext {
  return {
    ownerDirectory: Instance.worktree,
    activeDirectory: Instance.directory,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skill = yield* Skill.Service

    return Service.of({
      environment(input) {
        const project = Instance.project
        return renderSessionEnvironment({
          model: input.model,
          locale: input.locale,
          project,
          executionContext: input.executionContext ?? ambientExecutionContext(),
        })
      },

      skills: Effect.fn("SystemPrompt.skills")(function* (agent: Agent.Info) {
        if (Permission.disabled(["skill"], agent.permission).has("skill")) return

        const list = yield* skill.available(agent)

        return [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          // the agents seem to ingest the information about skills a bit better if we present a more verbose
          // version of them here and a less verbose version in tool description, rather than vice versa.
          Skill.fmt(list, { verbose: true }),
        ].join("\n")
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Skill.defaultLayer))

export * as SystemPrompt from "./system"
