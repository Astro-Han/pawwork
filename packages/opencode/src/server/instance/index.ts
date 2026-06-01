import { describeRoute, resolver, validator } from "hono-openapi"
import { Hono } from "hono"
import type { UpgradeWebSocket } from "hono/ws"
import fs from "fs/promises"
import z from "zod"
import { Format } from "../../format"
import { Instance } from "../../project/instance"
import { Vcs } from "../../project/vcs"
import { Agent } from "../../agent/agent"
import { Skill } from "../../skill"
import { Global } from "../../global"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { Runtime } from "@opencode-ai/core/runtime"
import { LSP } from "../../lsp"
import { Command } from "../../command"
import { ExternalResultRoutes } from "./external-result"
import { PermissionRoutes } from "./permission"
import { ProjectRoutes } from "./project"
import { SessionRoutes } from "./session"
import { PtyRoutes } from "./pty"
import { McpRoutes } from "./mcp"
import { FileRoutes } from "./file"
import { ConfigRoutes } from "./config"
import { ExperimentalRoutes } from "./experimental"
import { ProviderRoutes } from "./provider"
import { EventRoutes } from "./event"
import { MemoryRoutes } from "./memory"
import { AutomationRoutes } from "./automation"
import { WorkspaceRouterMiddleware } from "./middleware"
import { AppRuntime } from "@/effect/app-runtime"
import { jsonBodyLimit } from "./json-body-limit"

const applyPatchTooLarge = () =>
  ({
    error: "vcs_apply_failed",
    reason: "too-large",
    message: "Patch exceeds the 10 MB input limit",
  }) satisfies Vcs.ApplyError

const applyPatchInvalidInput = () =>
  ({
    error: "vcs_apply_failed",
    reason: "invalid-input",
    message: "Patch request body must be valid JSON with a string patch",
  }) satisfies Vcs.ApplyError

const applyJsonEnvelopeBytes = Buffer.byteLength(JSON.stringify({ patch: "" }))
// A JSON string can encode one decoded byte as six ASCII bytes (for example "\u000a").
const maxJsonStringEscapeRatio = 6
const applyJsonBodyMaxBytes = Vcs.MAX_APPLY_PATCH_BYTES * maxJsonStringEscapeRatio + applyJsonEnvelopeBytes

const applyPatchBodyLimit = jsonBodyLimit({
  maxBytes: applyJsonBodyMaxBytes,
  tooLarge: (c) => c.json(applyPatchTooLarge(), 413),
  invalidJson: (c) => c.json(applyPatchInvalidInput(), 400),
})

export const InstanceRoutes = (upgrade: UpgradeWebSocket): Hono =>
  new Hono()
    .use(WorkspaceRouterMiddleware(upgrade))
    .route("/project", ProjectRoutes())
    .route("/pty", PtyRoutes(upgrade))
    .route("/config", ConfigRoutes())
    .route("/experimental", ExperimentalRoutes())
    .route("/session", SessionRoutes())
    .route("/permission", PermissionRoutes())
    .route("/external-result", ExternalResultRoutes())
    .route("/provider", ProviderRoutes())
    .route("/memory", MemoryRoutes())
    .route("/automation", AutomationRoutes())
    .route("/", FileRoutes())
    .route("/", EventRoutes())
    .route("/mcp", McpRoutes())
    .post(
      "/instance/dispose",
      describeRoute({
        summary: "Dispose instance",
        description: "Clean up and dispose the current OpenCode instance, releasing all resources.",
        operationId: "instance.dispose",
        responses: {
          200: {
            description: "Instance disposed",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        await Instance.dispose()
        return c.json(true)
      },
    )
    .get(
      "/path",
      describeRoute({
        summary: "Get paths",
        description: "Retrieve the current working directory and related path information for the OpenCode instance.",
        operationId: "path.get",
        parameters: [
          {
            name: "ensureConfig",
            in: "query",
            required: false,
            schema: {
              type: "boolean",
            },
            description: "Create the global config directory before returning it.",
          },
        ],
        responses: {
          200: {
            description: "Path",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      home: z.string(),
                      state: z.string(),
                      config: z.string(),
                      worktree: z.string(),
                      directory: z.string(),
                    })
                    .meta({
                      ref: "Path",
                    }),
                ),
              },
            },
          },
        },
      }),
      async (c) => {
        const ensureConfig = c.req.query("ensureConfig") === "true"
        const config = Runtime.isPawWork()
          ? ensureConfig
            ? await PawWorkHome.ensurePrimary()
            : PawWorkHome.primary()
          : Global.Path.config
        if (ensureConfig && !Runtime.isPawWork()) await fs.mkdir(config, { recursive: true })
        return c.json({
          home: Global.Path.home,
          state: Global.Path.state,
          config,
          worktree: Instance.worktree,
          directory: Instance.directory,
        })
      },
    )
    .get(
      "/vcs",
      describeRoute({
        summary: "Get VCS info",
        description: "Retrieve version control system (VCS) information for the current project, such as git branch.",
        operationId: "vcs.get",
        responses: {
          200: {
            description: "VCS info",
            content: {
              "application/json": {
                schema: resolver(Vcs.Info),
              },
            },
          },
        },
      }),
      async (c) => {
        const [branch, default_branch] = await Promise.all([Vcs.branch(), Vcs.defaultBranch()])
        return c.json({
          branch,
          default_branch,
        })
      },
    )
    .get(
      "/vcs/diff",
      describeRoute({
        summary: "Get VCS diff",
        description: "Retrieve the current working-tree diff. `git` compares the working tree against HEAD (covers staged and unstaged changes plus untracked files); `branch` compares the working tree against the merge base with the default branch.",
        operationId: "vcs.diff",
        responses: {
          200: {
            description: "VCS diff",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileDiff.array()),
              },
            },
          },
        },
      }),
      validator(
        "query",
        z.object({
          mode: Vcs.Mode,
        }),
      ),
      async (c) => {
        return c.json(await Vcs.diff(c.req.valid("query").mode))
      },
    )
    .get(
      "/vcs/status",
      describeRoute({
        summary: "Get VCS status",
        description: "Retrieve working tree file status summaries for the current project.",
        operationId: "vcs.status",
        responses: {
          200: {
            description: "VCS status",
            content: {
              "application/json": {
                schema: resolver(Vcs.FileStatus.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await Vcs.status())
      },
    )
    .get(
      "/vcs/diff/raw",
      describeRoute({
        summary: "Get raw VCS diff",
        description: "Retrieve the current git diff as raw patch text.",
        operationId: "vcs.diffRaw",
        responses: {
          200: {
            description: "Raw VCS diff",
            content: {
              "text/plain": {
                schema: resolver(z.string()),
              },
            },
          },
          413: {
            description: "Raw VCS diff failure",
            content: {
              "application/json": {
                schema: resolver(Vcs.DiffRawError),
              },
            },
          },
        },
      }),
      async (c) => {
        try {
          c.header("content-type", "text/plain; charset=UTF-8")
          return c.text(await Vcs.diffRaw())
        } catch (error) {
          if (error instanceof Vcs.RawDiffError) {
            const body = {
              error: "vcs_diff_raw_failed",
              reason: error.reason,
              message: error.message,
            } satisfies Vcs.DiffRawError
            return c.json(body, 413)
          }
          throw error
        }
      },
    )
    .post(
      "/vcs/apply",
      describeRoute({
        summary: "Apply VCS patch",
        description: "Apply a git patch to the current project.",
        operationId: "vcs.apply",
        responses: {
          200: {
            description: "Patch apply result",
            content: {
              "application/json": {
                schema: resolver(Vcs.ApplyResult),
              },
            },
          },
          400: {
            description: "VCS patch apply failure",
            content: {
              "application/json": {
                schema: resolver(Vcs.ApplyError),
              },
            },
          },
          413: {
            description: "VCS patch apply failure",
            content: {
              "application/json": {
                schema: resolver(Vcs.ApplyError),
              },
            },
          },
        },
      }),
      applyPatchBodyLimit,
      validator("json", Vcs.ApplyInput, (result, c) => {
        if (!result.success) return c.json(applyPatchInvalidInput(), 400)
      }),
      async (c) => {
        try {
          return c.json(await Vcs.apply(c.req.valid("json")))
        } catch (error) {
          if (error instanceof Vcs.PatchApplyError) {
            const body =
              error.reason === "too-large"
                ? applyPatchTooLarge()
                : ({
                    error: "vcs_apply_failed",
                    reason: error.reason,
                    message: error.message,
                  } satisfies Vcs.ApplyError)
            return c.json(body, error.reason === "too-large" ? 413 : 400)
          }
          throw error
        }
      },
    )
    .get(
      "/command",
      describeRoute({
        summary: "List commands",
        description: "Get a list of all available commands in the OpenCode system.",
        operationId: "command.list",
        responses: {
          200: {
            description: "List of commands",
            content: {
              "application/json": {
                schema: resolver(Command.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const commands = await AppRuntime.runPromise(Command.Service.use((svc) => svc.list()))
        return c.json(commands)
      },
    )
    .get(
      "/agent",
      describeRoute({
        summary: "List agents",
        description: "Get a list of all available AI agents in the OpenCode system.",
        operationId: "app.agents",
        responses: {
          200: {
            description: "List of agents",
            content: {
              "application/json": {
                schema: resolver(Agent.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const modes = await Agent.list()
        return c.json(modes)
      },
    )
    .get(
      "/skill",
      describeRoute({
        summary: "List skills",
        description: "Get a list of all available skills in the OpenCode system.",
        operationId: "app.skills",
        responses: {
          200: {
            description: "List of skills",
            content: {
              "application/json": {
                schema: resolver(Skill.Info.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        const skills = await Skill.all()
        return c.json(skills)
      },
    )
    .get(
      "/lsp",
      describeRoute({
        summary: "Get LSP status",
        description: "Get LSP server status",
        operationId: "lsp.status",
        responses: {
          200: {
            description: "LSP server status",
            content: {
              "application/json": {
                schema: resolver(LSP.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await LSP.status())
      },
    )
    .get(
      "/formatter",
      describeRoute({
        summary: "Get formatter status",
        description: "Get formatter status",
        operationId: "formatter.status",
        responses: {
          200: {
            description: "Formatter status",
            content: {
              "application/json": {
                schema: resolver(Format.Status.array()),
              },
            },
          },
        },
      }),
      async (c) => {
        return c.json(await AppRuntime.runPromise(Format.Service.use((svc) => svc.status())))
      },
    )
