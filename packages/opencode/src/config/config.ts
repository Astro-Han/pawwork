import { Log } from "../util"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import crypto from "crypto"
import z from "zod"
import { mergeDeep, pipe } from "remeda"
import { Global } from "@opencode-ai/core/global"
import fsNode from "fs/promises"
import { NamedError } from "@opencode-ai/util/error"
import { Flag } from "@opencode-ai/core/flag/flag"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { Instance, type InstanceContext } from "../project/instance"
import { existsSync, statSync } from "fs"
import { GlobalBus } from "@/bus/global"
import { Event } from "../server/event"
import { Account } from "@/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "./console-state"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { InstanceState } from "@/effect"
import { makeRuntime } from "@/effect/run-service"
import { Context, Duration, Effect, Fiber, Layer, Option, Schema } from "effect"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { InstanceRef } from "@/effect/instance-ref"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigKeybinds } from "./keybinds"
import { ConfigLayout } from "./layout"
import { ConfigLSP } from "./lsp"
import { ConfigManaged } from "./managed"
import { ConfigMCP } from "./mcp"
import { ConfigModelID } from "./model-id"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPermission } from "./permission"
import { ConfigPlugin } from "./plugin"
import { ConfigProvider } from "./provider"
import { ConfigServer } from "./server"
import { ConfigSkills } from "./skills"
import { ConfigVariable } from "./variable"
import { RemoteAuthError } from "./error"
import { Npm } from "@opencode-ai/core/npm"
import { Filesystem } from "@/util/filesystem"
import { Installation } from "@/installation"
import { InstallationPluginVersion } from "@opencode-ai/core/installation/version"
import { withLifecycleOrigin } from "@/session/lifecycle-provenance"
import { Runtime } from "@opencode-ai/core/runtime"

const log = Log.create({ service: "config" })
const OPENCODE_PROJECT_CONFIG_NAMES = ["config", "opencode"] as const
const PAWWORK_PROJECT_CONFIG_NAMES = ["config", "opencode", "pawwork"] as const
const OPENCODE_PROJECT_CONFIG_FILES = OPENCODE_PROJECT_CONFIG_NAMES.flatMap((name) => [`${name}.json`, `${name}.jsonc`])
const PAWWORK_PROJECT_CONFIG_FILES = PAWWORK_PROJECT_CONFIG_NAMES.flatMap((name) => [`${name}.json`, `${name}.jsonc`])
const PAWWORK_GLOBAL_CONFIG_FILES = ["pawwork.json", "pawwork.jsonc"] as const
const OPENCODE_GLOBAL_CONFIG_FILES = OPENCODE_PROJECT_CONFIG_FILES

function globalConfigFiles() {
  return Runtime.isPawWork() ? PAWWORK_GLOBAL_CONFIG_FILES : OPENCODE_GLOBAL_CONFIG_FILES
}

function projectConfigNames() {
  return Runtime.isPawWork() ? PAWWORK_PROJECT_CONFIG_NAMES : OPENCODE_PROJECT_CONFIG_NAMES
}

function projectConfigFilesForDirectory(dir: string) {
  if (Runtime.isPawWork() && PawWorkHome.isCandidate(dir)) return []
  const base = path.basename(dir)
  if (base === ".pawwork") return Runtime.isPawWork() ? PAWWORK_PROJECT_CONFIG_FILES : []
  if (base === ".opencode" || dir === Flag.OPENCODE_CONFIG_DIR) {
    return Runtime.isPawWork() ? PAWWORK_PROJECT_CONFIG_FILES : OPENCODE_PROJECT_CONFIG_FILES
  }
  return []
}

async function readRemoteConfigJson(response: Response, input: { url: string; remote: string }) {
  const body = await response.text()
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? ""
  const isHtml = contentType.includes("html") || /^\s*(?:<!doctype html|<html)\b/i.test(body)
  if (isHtml) {
    throw new RemoteAuthError({
      ...input,
      message: "the server returned a login page instead of JSON",
    })
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new RemoteAuthError({
      ...input,
      message: "the server returned non-JSON content",
    })
  }
}

function shouldGenerateInDirectory(dir: string) {
  const base = path.basename(dir)
  if (Runtime.isPawWork() && PawWorkHome.isCandidate(dir)) return PawWorkHome.isPrimary(dir)
  if (Runtime.isPawWork() && base === ".opencode") return false
  if (!Runtime.isPawWork() && base === ".pawwork") return false
  return true
}

type Package = {
  dependencies?: Record<string, string>
}

function configPluginDependencyTarget() {
  return Installation.isLocal() ? "*" : InstallationPluginVersion
}

// Custom merge function that concatenates array fields instead of replacing them
function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeDeep(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown, source: string) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  // Legacy compat for v0.2.13-era configs: ignore removed default_agent before strict schema decode.
  // Keep this as a narrow read-time shim only; do not write the file back.
  delete copy["default_agent"]
  // Legacy compat: formatter integration was removed. Silently ignore the field.
  delete copy["formatter"]
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  return copy
}

async function resolveLoadedPlugins<T extends { plugin?: ConfigPlugin.Spec[] }>(config: T, filepath: string) {
  if (!config.plugin) return config
  for (let i = 0; i < config.plugin.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    config.plugin[i] = await ConfigPlugin.resolvePluginSpec(config.plugin[i], filepath)
  }
  return config
}

function virtualConfigFilepath(options: { dir: string; source: string }) {
  if (options.source.startsWith("mobileconfig:")) return options.source.slice("mobileconfig:".length)
  if (path.isAbsolute(options.dir) || /^[A-Za-z]:[\\/]/.test(options.dir)) return path.join(options.dir, options.source)
}

export const Server = ConfigServer.Server.zod
export const Layout = ConfigLayout.Layout.zod
export type Layout = ConfigLayout.Layout

// Schemas that still live at the zod layer (have .transform / .preprocess /
// .meta not expressible in current Effect Schema) get referenced via a
// ZodOverride-annotated Schema.Any.  Walker sees the annotation and emits the
// exact zod directly, preserving component $refs.
const AgentRef = Schema.Any.annotate({ [ZodOverride]: ConfigAgent.Info })
const LogLevelRef = Schema.Any.annotate({ [ZodOverride]: Log.Level })
const ServerRef = Schema.Any.annotate({
  [ZodOverride]: ConfigServer.Server.zod,
}) as unknown as typeof ConfigServer.Server

const PositiveInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThan(0))
const NonNegativeInt = Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))

// The Effect Schema is the canonical source of truth. The `.zod` compatibility
// surface is derived so existing Hono validators keep working without a parallel
// Zod definition.
//
// The walker emits `z.object({...})` which is non-strict by default. Config
// historically uses `.strict()` (additionalProperties: false in openapi.json),
// so layer that on after derivation.  Re-apply the Config ref afterward
// since `.strict()` strips the walker's meta annotation.
export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({
    description: "JSON schema reference for configuration validation",
  }),
  logLevel: Schema.optional(LogLevelRef).annotate({ description: "Log level" }),
  server: Schema.optional(ServerRef).annotate({
    description: "Server configuration for opencode serve and web commands",
  }),
  command: Schema.optional(Schema.Record(Schema.String, ConfigCommand.Info)).annotate({
    description: "Command configuration, see https://opencode.ai/docs/commands",
  }),
  skills: Schema.optional(ConfigSkills.Info).annotate({ description: "Additional skill folder paths" }),
  watcher: Schema.optional(
    Schema.Struct({
      ignore: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
    }),
  ),
  snapshot: Schema.optional(Schema.Boolean).annotate({
    description:
      "Enable or disable snapshot tracking. When false, filesystem snapshots are not recorded and undoing or reverting will not undo/redo file changes. Defaults to true.",
  }),
  // User-facing plugin config is stored as Specs; provenance gets attached later while configs are merged.
  plugin: Schema.optional(Schema.mutable(Schema.Array(ConfigPlugin.Spec))),
  share: Schema.optional(Schema.Literals(["manual", "auto", "disabled"])).annotate({
    description:
      "Control sharing behavior:'manual' allows manual sharing via commands, 'auto' enables automatic sharing, 'disabled' disables all sharing",
  }),
  autoshare: Schema.optional(Schema.Boolean).annotate({
    description: "@deprecated Use 'share' field instead. Share newly created sessions automatically",
  }),
  autoupdate: Schema.optional(Schema.Union([Schema.Boolean, Schema.Literal("notify")])).annotate({
    description:
      "Automatically update to the latest version. Set to true to auto-update, false to disable, or 'notify' to show update notifications",
  }),
  disabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Disable providers that are loaded automatically",
  }),
  enabled_providers: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "When set, ONLY these providers will be enabled. All other providers will be ignored",
  }),
  model: Schema.optional(ConfigModelID).annotate({
    description: "Model to use in the format of provider/model, eg anthropic/claude-2",
  }),
  small_model: Schema.optional(ConfigModelID).annotate({
    description: "Small model to use for tasks like title generation in the format of provider/model",
  }),
  username: Schema.optional(Schema.String).annotate({
    description: "Custom username to display in conversations instead of system username",
  }),
  mode: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        build: Schema.optional(AgentRef),
      }),
      [Schema.Record(Schema.String, AgentRef)],
    ),
  ).annotate({ description: "@deprecated Use `agent` field instead." }),
  agent: Schema.optional(
    Schema.StructWithRest(
      Schema.Struct({
        // primary
        build: Schema.optional(AgentRef),
        // subagent
        general: Schema.optional(AgentRef),
        explore: Schema.optional(AgentRef),
        // specialized
        title: Schema.optional(AgentRef),
        summary: Schema.optional(AgentRef),
        compaction: Schema.optional(AgentRef),
      }),
      [Schema.Record(Schema.String, AgentRef)],
    ),
  ).annotate({ description: "Agent configuration, see https://opencode.ai/docs/agents" }),
  provider: Schema.optional(Schema.Record(Schema.String, ConfigProvider.Info)).annotate({
    description: "Custom provider configurations and model overrides",
  }),
  mcp: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([
        ConfigMCP.Info,
        // Matches the legacy `{ enabled: false }` form used to disable a server.
        Schema.Any.annotate({ [ZodOverride]: z.object({ enabled: z.boolean() }).strict() }),
      ]),
    ),
  ).annotate({ description: "MCP (Model Context Protocol) server configurations" }),
  lsp: Schema.optional(ConfigLSP.Info),
  instructions: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
    description: "Additional instruction files or patterns to include",
  }),
  layout: Schema.optional(ConfigLayout.Layout).annotate({ description: "@deprecated Always uses stretch layout." }),
  permission: Schema.optional(ConfigPermission.Info),
  tools: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  enterprise: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String).annotate({ description: "Enterprise URL" }),
    }),
  ),
  tool_output: Schema.optional(
    Schema.Struct({
      max_lines: Schema.optional(PositiveInt).annotate({
        description: "Maximum lines of tool output before it is truncated and saved to disk (default: 2000)",
      }),
      max_bytes: Schema.optional(PositiveInt).annotate({
        description: "Maximum bytes of tool output before it is truncated and saved to disk (default: 51200)",
      }),
    }),
  ).annotate({
    description:
      "Thresholds for truncating tool output. When output exceeds either limit, the full text is written to the truncation directory and a preview is returned.",
  }),
  compaction: Schema.optional(
    Schema.Struct({
      auto: Schema.optional(Schema.Boolean).annotate({
        description: "Enable automatic compaction when context is full (default: true)",
      }),
      prune: Schema.optional(Schema.Boolean).annotate({
        description: "Prune old tool outputs (default: `false`). Set `true` to enable.",
      }),
      tail_turns: Schema.optional(NonNegativeInt).annotate({
        description:
          "Number of recent user turns, including their following assistant/tool responses, to keep verbatim during compaction (default: 2)",
      }),
      preserve_recent_tokens: Schema.optional(NonNegativeInt).annotate({
        description: "Maximum number of tokens from recent turns to preserve verbatim after compaction",
      }),
      reserved: Schema.optional(NonNegativeInt).annotate({
        description: "Token buffer for compaction. Leaves enough window to avoid overflow during compaction.",
      }),
    }),
  ),
  experimental: Schema.optional(
    Schema.Struct({
      disable_paste_summary: Schema.optional(Schema.Boolean),
      batch_tool: Schema.optional(Schema.Boolean).annotate({ description: "Enable the batch tool" }),
      openTelemetry: Schema.optional(Schema.Boolean).annotate({
        description: "Enable OpenTelemetry spans for AI SDK calls (using the 'experimental_telemetry' flag)",
      }),
      primary_tools: Schema.optional(Schema.mutable(Schema.Array(Schema.String))).annotate({
        description: "Tools that should only be available to primary agents.",
      }),
      continue_loop_on_deny: Schema.optional(Schema.Boolean).annotate({
        description: "Continue the agent loop when a tool call is denied",
      }),
      mcp_timeout: Schema.optional(PositiveInt).annotate({
        description: "Timeout in milliseconds for model context protocol (MCP) requests",
      }),
    }),
  ),
})
  .annotate({ identifier: "Config" })
  .pipe(
    withStatics((s) => ({
      zod: (zod(s) as unknown as z.ZodObject<any>).strict().meta({ ref: "Config" }) as unknown as z.ZodType<
        DeepMutable<Schema.Schema.Type<typeof s>>
      >,
    })),
  )

// Schema.Struct produces readonly types by default, but the service code
// below mutates Info objects directly (e.g. `config.mode = ...`). Strip the
// readonly recursively so callers get the same mutable shape zod inferred.
//
// `Types.DeepMutable` from effect-smol would be a drop-in, but its fallback
// branch `{ -readonly [K in keyof T]: ... }` collapses `unknown` to `{}`
// (since `keyof unknown = never`), which widens `Record<string, unknown>`
// fields like `ConfigPlugin.Options`. The local version gates on
// `extends object` so `unknown` passes through.
//
// Tuple branch preserves `ConfigPlugin.Spec`'s `readonly [string, Options]`
// shape (otherwise the general array branch widens it to an array).
type DeepMutable<T> = T extends readonly [unknown, ...unknown[]]
  ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
  : T extends readonly (infer U)[]
    ? DeepMutable<U>[]
    : T extends object
      ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
      : T

export type Info = DeepMutable<Schema.Schema.Type<typeof Info>> & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  plugin_origins?: ConfigPlugin.Origin[]
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void, never>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<Info>
  readonly invalidate: (wait?: boolean) => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
  readonly installDependencies: (dir: string) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Config") {}

function globalConfigFile() {
  if (Runtime.isPawWork()) {
    return PawWorkHome.configFileForWrite()
  }
  const candidates = globalConfigFiles().map((file) => path.join(Global.Path.config, file))
  for (const file of [...candidates].reverse()) {
    if (isRegularFileSync(file)) return file
  }
  return path.join(Global.Path.config, Runtime.isPawWork() ? "pawwork.json" : "opencode.json")
}

function isRegularFileSync(file: string) {
  try {
    return statSync(file).isFile()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

function legacyTomlMigrationTarget() {
  const candidates = globalConfigFiles().map((file) => path.join(Global.Path.config, file))
  for (const file of [...candidates].reverse()) {
    if (isRegularFileSync(file)) return file
  }
  return path.join(Global.Path.config, Runtime.isPawWork() ? "pawwork.json" : "opencode.json")
}

export function globalConfigFileForWrite() {
  return globalConfigFile()
}

export function configFileLockKey(file: string) {
  return `config-file:${Filesystem.resolve(file)}`
}

export async function withConfigFileLock<T>(file: string, fn: () => Promise<T>) {
  return EffectFlock.withLockPromise(configFileLockKey(file), fn)
}

function isWindowsSyncUnsupportedError(error: unknown) {
  if (process.platform !== "win32") return false
  const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException)?.code : undefined
  return code === "EPERM" || code === "EINVAL" || code === "ENOTSUP"
}

async function syncHandleBestEffort(handle: { sync: () => Promise<void> }) {
  try {
    await handle.sync()
  } catch (error) {
    if (!isWindowsSyncUnsupportedError(error)) throw error
    log.debug("skipping unsupported Windows fsync", { code: (error as NodeJS.ErrnoException).code })
  }
}

export async function writeConfigTextAtomic(file: string, text: string, options?: { mode?: number }) {
  await fsNode.mkdir(path.dirname(file), { recursive: true })
  const existingMode = await fsNode
    .stat(file)
    .then((stat) => stat.mode & 0o777)
    .catch(() => undefined)
  const mode = existingMode ?? options?.mode
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`,
  )
  try {
    await fsNode.writeFile(tmp, text, mode === undefined ? undefined : { mode })
    if (mode !== undefined) await fsNode.chmod(tmp, mode)
    const tmpHandle = await fsNode.open(tmp, "r")
    try {
      await syncHandleBestEffort(tmpHandle)
    } finally {
      await tmpHandle.close()
    }
    await fsNode.rename(tmp, file)
    const dirHandle = await fsNode.open(path.dirname(file), "r").catch(() => undefined)
    if (dirHandle) {
      try {
        await syncHandleBestEffort(dirHandle)
      } finally {
        await dirHandle.close()
      }
    }
  } catch (error) {
    await fsNode.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

function globalConfigFilesToLoad() {
  if (!Runtime.isPawWork()) {
    const candidates = globalConfigFiles().map((file) => path.join(Global.Path.config, file))
    return candidates.filter(isRegularFileSync)
  }

  return PawWorkHome.configFilesToLoad()
}

function globalConfigSource() {
  return globalConfigFilesToLoad().at(-1)
}

export function globalConfigFileForRead() {
  return globalConfigSource()
}

function projectConfigFile(dir: string) {
  // OpenCode still writes existing legacy `config.*` files, but new project config uses `opencode.json`.
  // PawWork reuses the highest-priority existing project config source before creating a root `pawwork.json`.
  const candidates = Runtime.isPawWork()
    ? [
        ...PAWWORK_PROJECT_CONFIG_FILES.map((file) => path.join(dir, file)),
        ...projectConfigFilesForDirectory(path.join(dir, ".opencode")).map((file) => path.join(dir, ".opencode", file)),
        ...projectConfigFilesForDirectory(path.join(dir, ".pawwork")).map((file) => path.join(dir, ".pawwork", file)),
      ]
    : ["config.json", "config.jsonc", "opencode.json", "opencode.jsonc"].map((file) => path.join(dir, file))
  for (const file of [...candidates].reverse()) {
    if (existsSync(file)) return file
  }
  return path.join(dir, Runtime.isPawWork() ? "pawwork.json" : "opencode.json")
}

export function projectConfigFileForWrite(dir: string) {
  return projectConfigFile(dir)
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => {
    if (value === undefined) return result
    return patchJsonc(result, value, [...path, key])
  }, input)
}

function missingConfigPatch(lowPriority: unknown, highPriority: unknown): Record<string, unknown> | undefined {
  if (!isRecord(lowPriority)) return
  const out: Record<string, unknown> = {}
  const high = isRecord(highPriority) ? highPriority : {}
  for (const [key, lowValue] of Object.entries(lowPriority)) {
    if (!(key in high)) {
      out[key] = lowValue
      continue
    }
    const nested = missingConfigPatch(lowValue, high[key])
    if (nested && Object.keys(nested).length > 0) out[key] = nested
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function normalizeWritableConfig(data: unknown, source: string) {
  const normalized = normalizeLoadedConfig(data, source)
  const parsed = Info.zod.safeParse(normalized)
  if (parsed.success) return writable(parsed.data)

  if (!isRecord(normalized)) return writable(ConfigParse.schema(Info.zod, normalized, source))
  const copy = { ...normalized }
  for (const issue of parsed.error.issues) {
    const hit = issue as { code?: string; keys?: unknown; path?: unknown[] }
    if (hit.code !== "unrecognized_keys" || !Array.isArray(hit.keys)) continue
    for (const key of hit.keys) {
      if (typeof key === "string") deleteConfigKeyAtPath(copy, hit.path ?? [], key)
    }
  }

  return writable(ConfigParse.schema(Info.zod, copy, source))
}

function deleteConfigKeyAtPath(root: Record<string, unknown>, parts: unknown[], key: string) {
  let target: unknown = root
  for (const part of parts) {
    if (typeof part !== "string" && typeof part !== "number") return
    if (Array.isArray(target)) {
      if (typeof part !== "number") return
      target = target[part]
    } else if (isRecord(target)) target = target[part]
    else return
  }
  if (Array.isArray(target)) {
    const index = Number(key)
    if (Number.isInteger(index)) target.splice(index, 1)
    return
  }
  if (isRecord(target)) delete target[key]
}

function shouldMergeLegacyTomlIntoRuntime(globalFiles: string[]) {
  if (!Runtime.isPawWork()) return true
  if (globalFiles.length === 0) return true
  const legacyDir = path.resolve(Global.Path.config)
  return globalFiles.some((file) => path.resolve(path.dirname(file)) === legacyDir)
}

function isAbsoluteOrExternalPath(value: string) {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    value.startsWith("~/") ||
    value.startsWith("~\\") ||
    /^[A-Za-z][A-Za-z\d+.-]*:/.test(value)
  )
}

function resolveSeedPath(value: string, sourceFile: string) {
  if (!value || isAbsoluteOrExternalPath(value)) return value
  return path.resolve(path.dirname(sourceFile), value)
}

function hasConfigPlaceholder(value: string) {
  return /\{[A-Za-z][A-Za-z\d_-]*:/.test(value)
}

function resolveSeedInstructionPath(value: string, sourceFile: string) {
  const rewritten = rewriteFilePlaceholders(value, sourceFile)
  if (hasConfigPlaceholder(rewritten) && rewritten.trimStart().startsWith("{")) return rewritten
  return resolveSeedPath(rewritten, sourceFile)
}

function rewriteFilePlaceholders(value: string, sourceFile: string) {
  return value.replace(/\{file:([^}]+)\}/g, (match, filePath: string) => {
    const trimmed = filePath.trim()
    if (!trimmed || isAbsoluteOrExternalPath(trimmed)) return match
    return `{file:${path.resolve(path.dirname(sourceFile), trimmed)}}`
  })
}

function rewriteFilePlaceholdersDeep(value: unknown, sourceFile: string): unknown {
  if (typeof value === "string") return rewriteFilePlaceholders(value, sourceFile)
  if (Array.isArray(value)) return value.map((item) => rewriteFilePlaceholdersDeep(item, sourceFile))
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        rewriteFilePlaceholdersDeep(childValue, sourceFile),
      ]),
    )
  }
  return value
}

function rewriteSeedPluginSpec(value: unknown, sourceFile: string): unknown {
  if (typeof value === "string") {
    const rewritten = rewriteFilePlaceholders(value, sourceFile)
    return rewritten.startsWith(".") ? resolveSeedPath(rewritten, sourceFile) : rewritten
  }
  if (Array.isArray(value) && typeof value[0] === "string") {
    const rewritten = rewriteFilePlaceholders(value[0], sourceFile)
    return [
      rewritten.startsWith(".") ? resolveSeedPath(rewritten, sourceFile) : rewritten,
      ...value.slice(1).map((item) => rewriteFilePlaceholdersDeep(item, sourceFile)),
    ]
  }
  return rewriteFilePlaceholdersDeep(value, sourceFile)
}

function rewriteSeedConfig(value: Record<string, unknown>, sourceFile: string): Record<string, unknown> {
  const next = rewriteFilePlaceholdersDeep(value, sourceFile) as Record<string, unknown>
  if (Array.isArray(value.instructions)) {
    next.instructions = value.instructions.map((item) =>
      typeof item === "string"
        ? resolveSeedInstructionPath(item, sourceFile)
        : rewriteFilePlaceholdersDeep(item, sourceFile),
    )
  }
  if (Array.isArray(value.plugin)) {
    next.plugin = value.plugin.map((item) => rewriteSeedPluginSpec(item, sourceFile))
  }
  return next
}

function seedConfigValueFromSource(text: string, sourceFile: string) {
  const parsed = ConfigParse.jsonc(text, sourceFile)
  if (!isRecord(parsed)) return text
  return rewriteSeedConfig(normalizeWritableConfig(parsed, sourceFile), sourceFile)
}

function seedConfigTextFromSources(sources: { path: string; text: string }[]) {
  const merged = sources.reduce<unknown>((result, source) => {
    const next = seedConfigValueFromSource(source.text, source.path)
    if (!isRecord(result) || !isRecord(next)) return next
    return mergeDeep(result, next)
  }, {})
  if (!isRecord(merged)) return "{}"
  return JSON.stringify(merged, null, 2)
}

async function writeLegacyTomlMigration(target: string, legacyConfig: Info, options?: { mergeExisting?: boolean }) {
  await withConfigFileLock(target, async () => {
    const existingText = await fsNode.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (existingText !== undefined) {
      if (!options?.mergeExisting) return
      const existing = ConfigParse.jsonc(existingText, target)
      if (!isRecord(existing)) return
      const patch = missingConfigPatch(legacyConfig, existing)
      if (!patch) return
      const updated = target.endsWith(".jsonc")
        ? patchJsonc(existingText, patch)
        : JSON.stringify(mergeDeep(legacyConfig, existing), null, 2)
      await writeConfigTextAtomic(target, updated)
      return
    }
    await writeConfigTextAtomic(target, JSON.stringify(legacyConfig, null, 2))
  })
}

export const ConfigDirectoryTypoError = NamedError.create(
  "ConfigDirectoryTypoError",
  z.object({
    path: z.string(),
    dir: z.string(),
    suggestion: z.string(),
  }),
)

const rawLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const flock = yield* EffectFlock.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service

    const readConfigFile = Effect.fnUntraced(function* (filepath: string) {
      return yield* fs.readFileString(filepath).pipe(
        Effect.catchIf(
          (e) => e.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
        Effect.orDie,
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: ({ path: string } | { dir: string; source: string }) & { allowWrite?: boolean },
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options ? { text, type: "path", path: options.path } : { text, type: "virtual", ...options },
        ),
      )
      const parsed = ConfigParse.jsonc(expanded, source)
      const data = ConfigParse.schema(Info.zod, normalizeLoadedConfig(parsed, source), source)
      const pluginContextPath = "path" in options ? options.path : virtualConfigFilepath(options)
      if (pluginContextPath) {
        yield* Effect.promise(() => resolveLoadedPlugins(data, pluginContextPath))
      }
      if (!("path" in options) || options.allowWrite === false) return data

      if (!data.$schema) {
        data.$schema = "https://opencode.ai/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://opencode.ai/config.json",')
        yield* flock
          .withLock(Effect.promise(() => writeConfigTextAtomic(options.path, updated)), configFileLockKey(options.path))
          .pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, options?: { allowWrite?: boolean }) {
      log.info("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath, allowWrite: options?.allowWrite })
    })

    const loadGlobal = Effect.fnUntraced(function* () {
      let result: Info = {}
      const globalFiles = globalConfigFilesToLoad()
      for (const filepath of globalFiles) {
        const dir = path.dirname(filepath)
        const allowWrite = !Runtime.isPawWork() || PawWorkHome.isPrimary(dir)
        const text = yield* readConfigFile(filepath)
        if (!text) continue
        result = pipe(result, mergeDeep(yield* loadConfig(text, { path: filepath, allowWrite })))
      }

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(async () => {
          let target = ""
          let action = "load"
          let unlinked = false
          try {
            const mod = await import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            action = "normalize"
            const { provider, model, ...rest } = mod.default
            const migrated: Info = { $schema: "https://opencode.ai/config.json" }
            if (provider && model) migrated.model = `${provider}/${model}`
            const legacyConfig = normalizeWritableConfig(mergeDeep(migrated, rest), legacy)
            if (shouldMergeLegacyTomlIntoRuntime(globalFiles)) {
              result = mergeDeep(legacyConfig, result)
            }
            target = legacyTomlMigrationTarget()
            action = isRegularFileSync(target) ? "merge" : "create"
            await writeLegacyTomlMigration(target, legacyConfig, {
              mergeExisting: true,
            })
            action = "unlink"
            await fsNode.unlink(legacy)
            unlinked = true
          } catch (error) {
            log.warn("legacy TOML config migration failed", {
              path: legacy,
              target: target || "unavailable",
              action,
              unlinked,
              error: String(error),
            })
          }
        })
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.sync(() => log.error("failed to load global config, using defaults", { error: String(error) })),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "OPENCODE_CONFIG_CONTENT") return "local"
          if (yield* InstanceRef.use((ctx) => Effect.succeed(Instance.containsPath(source, ctx)))) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // mergePluginOrigins receives raw Specs from one config source, before provenance for this merge step
          // is attached.
          list: ConfigPlugin.Spec[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((spec) => ({ spec, source, scope: hit })),
          ])
          result.plugin = plugins.map((item) => item.spec)
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugin, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            process.env[value.key] = value.token
            log.debug("fetching remote config", { url: `${url}/.well-known/opencode` })
            const response = yield* Effect.promise(() => fetch(`${url}/.well-known/opencode`))
            const remote = `${url}/.well-known/opencode`
            if (response.status === 401 || response.status === 403) {
              throw new RemoteAuthError({
                url,
                remote,
                message: `the server rejected the request with HTTP ${response.status}`,
              })
            }
            if (!response.ok) {
              throw new Error(`failed to fetch remote config from ${url}: ${response.status}`)
            }
            const wellknown = (yield* Effect.promise(() =>
              readRemoteConfigJson(response, { url, remote }),
            )) as { config?: Record<string, unknown> }
            const remoteConfig = wellknown.config ?? {}
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://opencode.ai/config.json"
            const source = remote
            const next = yield* loadConfig(JSON.stringify(remoteConfig), {
              dir: path.dirname(source),
              source,
            })
            yield* merge(source, next, "global")
            log.debug("loaded remote config from well-known", { url })
          }
        }

        const global = yield* getGlobal()
        yield* merge(
          globalConfigSource() ?? (Runtime.isPawWork() ? PawWorkHome.primary() : Global.Path.config),
          global,
          "global",
        )

        if (Flag.OPENCODE_CONFIG) {
          yield* merge(Flag.OPENCODE_CONFIG, yield* loadFile(Flag.OPENCODE_CONFIG))
          log.debug("loaded custom config", { path: Flag.OPENCODE_CONFIG })
        }

        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files(projectConfigNames(), ctx.directory, ctx.worktree).pipe(
            Effect.orDie,
          )) {
            yield* merge(file, yield* loadFile(file), "local")
          }
        }

        result.agent = result.agent || {}
        result.mode = result.mode || {}
        result.plugin = result.plugin || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        const pawworkConfigDir = Flag.PAWWORK_CONFIG_DIR
        if (Runtime.isPawWork() && pawworkConfigDir) {
          log.debug("loading config from PAWWORK_CONFIG_DIR", { path: pawworkConfigDir })
        } else if (Flag.OPENCODE_CONFIG_DIR) {
          log.debug("loading config from OPENCODE_CONFIG_DIR", { path: Flag.OPENCODE_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void, never>[] = []

        for (const dir of directories) {
          const configFiles =
            Runtime.isPawWork() && PawWorkHome.isCandidate(dir) ? [] : projectConfigFilesForDirectory(dir)

          if (configFiles.length > 0) {
            for (const file of configFiles) {
              const source = path.join(dir, file)
              log.debug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source))
              result.agent ??= {}
              result.mode ??= {}
              result.plugin ??= []
            }
          }

          if (shouldGenerateInDirectory(dir)) {
            yield* ensureGitignore(dir).pipe(Effect.orDie)

            const dep = yield* installDependencies(dir).pipe(
              Effect.asVoid,
              Effect.catchDefect((defect) =>
                Effect.sync(() => {
                  log.warn("background dependency install failed", { dir, error: String(defect) })
                }),
              ),
              Effect.forkDetach,
            )
            deps.push(dep)
          }

          result.command = mergeDeep(result.command ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.load(dir)))
          result.agent = mergeDeep(result.agent ?? {}, yield* Effect.promise(() => ConfigAgent.loadMode(dir)))
          // Auto-discovered plugins under `.opencode/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list)
        }

        if (process.env.OPENCODE_CONFIG_CONTENT) {
          const source = "OPENCODE_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.OPENCODE_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          log.debug("loaded custom config from OPENCODE_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        const activeOrg = Option.getOrUndefined(
          yield* accountSvc.activeOrg().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeOrg) activeOrgName = activeOrg.org.name
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["OPENCODE_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("OPENCODE_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.provider ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) => {
              log.debug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              })
              return Effect.void
            }),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of Runtime.isPawWork() ? globalConfigFiles() : OPENCODE_PROJECT_CONFIG_FILES) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        for (const [name, mode] of Object.entries(result.mode ?? {})) {
          result.agent = mergeDeep(result.agent ?? {}, {
            [name]: {
              ...mode,
              mode: "primary" as const,
            },
          })
        }

        if (Flag.OPENCODE_PERMISSION) {
          try {
            result.permission = mergeDeep(result.permission ?? {}, JSON.parse(Flag.OPENCODE_PERMISSION))
          } catch (err) {
            log.warn("OPENCODE_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (result.tools) {
          const perms: Record<string, ConfigPermission.Action> = {}
          for (const [tool, enabled] of Object.entries(result.tools)) {
            const action: ConfigPermission.Action = enabled ? "allow" : "deny"
            if (tool === "write" || tool === "edit" || tool === "patch") {
              perms.edit = action
              continue
            }
            perms[tool] = action
          }
          result.permission = mergeDeep(perms, result.permission ?? {})
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            log.warn("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (result.autoshare === true && !result.share) {
          result.share = "auto"
        }

        if (Flag.OPENCODE_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.OPENCODE_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(AppFileSystem.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const installDependencies: Interface["installDependencies"] = Effect.fn("Config.installDependencies")(function* (
      dir,
    ) {
      const canWrite = yield* fs.access(dir, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!canWrite) return false

      const key = process.platform === "win32" ? "config-install:win32" : `config-install:${AppFileSystem.resolve(dir)}`

      return yield* flock
        .withLock(
          Effect.gen(function* () {
            const pkg = path.join(dir, "package.json")
            const target = configPluginDependencyTarget()
            const parsed = yield* fs.readFileString(pkg).pipe(
              Effect.flatMap((text) =>
                Effect.try({
                  try: () => JSON.parse(text) as unknown,
                  catch: () => undefined,
                }),
              ),
              Effect.catch(() =>
                Effect.succeed({
                  dependencies: {},
                } satisfies Package),
              ),
            )
            const json: Package =
              parsed && typeof parsed === "object" && !Array.isArray(parsed)
                ? (parsed as Package)
                : ({ dependencies: {} } satisfies Package)
            const dependencies = json.dependencies ?? {}
            const required = {
              ...dependencies,
              "@opencode-ai/plugin": target,
            }
            const hasDep = dependencies["@opencode-ai/plugin"] === target
            json.dependencies = required

            const gitignore = path.join(dir, ".gitignore")
            const ignore = yield* fs.existsSafe(gitignore)
            const installed = yield* Effect.all(
              Object.keys(required).map((pkg) =>
                fs.existsSafe(path.join(dir, "node_modules", ...pkg.split("/"), "package.json")),
              ),
              { concurrency: "unbounded" },
            )

            if (!hasDep) {
              yield* fs.writeJson(pkg, json)
            }
            if (!ignore) {
              yield* fs.writeFileString(
                gitignore,
                ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
              )
            }
            if (hasDep && ignore && installed.every(Boolean)) return true
            const installedDependencies = yield* Effect.tryPromise({
              try: () => Npm.install(dir),
              catch: (error) => error,
            }).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.sync(() => {
                  log.warn("dependency install failed", { dir, error: String(error) })
                  return false
                }),
              ),
            )
            return installedDependencies
          }),
          key,
        )
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              log.warn("dependency install failed", { dir, error: String(error) })
              return false
            }),
          ),
        )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = projectConfigFile(dir)
      const input = writable(config)
      let changed: boolean

      if (!file.endsWith(".jsonc")) {
        const existing = yield* loadFile(file)
        // Re-read after loadFile so we see any auto-added $schema, otherwise
        // the first call would always write and tear instances down.
        const before = (yield* readConfigFile(file)) ?? "{}"
        const serialized = JSON.stringify(mergeDeep(writable(existing), input), null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
      } else {
        const before = (yield* readConfigFile(file)) ?? "{}"
        const updated = patchJsonc(before, input)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      // Only tear down running instances if config actually changed on disk.
      // No-op writes from UI mounts (see upstream PR #25114) would otherwise
      // abort any in-flight assistant turn.
      if (changed)
        yield* Effect.promise(() =>
          withLifecycleOrigin(
            { source: "config", operation: "config.update", reason: "config.update" },
            () => Instance.dispose(),
          ),
        )
    })

    const invalidate = Effect.fn("Config.invalidate")(function* (wait?: boolean, operation = "config.invalidate") {
      yield* invalidateGlobal
      const emitDisposed = () => {
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: Event.Disposed.type,
            properties: {},
          },
        })
      }
      const task = withLifecycleOrigin({ source: "config", operation, reason: operation }, async () => {
        const result = await Instance.disposeAll({ onCompleted: emitDisposed })
        if (wait && result.completed) await result.completed
      })
        .catch(() => undefined)
      if (wait) yield* Effect.promise(() => task)
      else void task
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      if (Runtime.isPawWork()) yield* Effect.promise(() => PawWorkHome.ensurePrimary())
      const file = globalConfigFile()
      const { next, changed } = yield* flock.withLock(
        Effect.gen(function* () {
          let next: Info
          let changed: boolean

          if (!Runtime.isPawWork()) yield* Effect.promise(() => fsNode.mkdir(path.dirname(file), { recursive: true }))
          const existingText = yield* readConfigFile(file)
          const seedFiles = existingText === undefined ? globalConfigFilesToLoad() : []
          const seedSource = seedFiles.at(-1)
          const seed =
            existingText === undefined && seedFiles.length > 0
              ? {
                  text: seedConfigTextFromSources(
                    yield* Effect.all(
                      seedFiles.map((source) =>
                        readConfigFile(source).pipe(Effect.map((text) => ({ path: source, text: text ?? "{}" }))),
                      ),
                    ),
                  ),
                  mode: yield* Effect.promise(() =>
                    seedSource
                      ? fsNode
                          .stat(seedSource)
                          .then((stat) => stat.mode & 0o777)
                          .catch(() => undefined)
                      : Promise.resolve(undefined),
                  ),
                }
              : undefined
          const before = existingText ?? seed?.text ?? "{}"
          const fileExisted = existingText !== undefined
          const writeOptions =
            existingText === undefined && Runtime.isPawWork() ? { mode: seed?.mode ?? 0o600 } : undefined

          if (!file.endsWith(".jsonc")) {
            const existing = ConfigParse.schema(Info.zod, ConfigParse.jsonc(before, file), file)
            const merged = mergeDeep(writable(existing), writable(config))
            const serialized = JSON.stringify(merged, null, 2)
            // Always materialize on first run (seed migration), otherwise only
            // when bytes change. See upstream PR #25114.
            changed = !fileExisted || serialized !== before
            if (changed)
              yield* Effect.promise(() => writeConfigTextAtomic(file, serialized, writeOptions)).pipe(Effect.orDie)
            next = merged
          } else {
            const updated = patchJsonc(before, writable(config))
            next = ConfigParse.schema(Info.zod, ConfigParse.jsonc(updated, file), file)
            changed = !fileExisted || updated !== before
            if (changed)
              yield* Effect.promise(() => writeConfigTextAtomic(file, updated, writeOptions)).pipe(Effect.orDie)
          }
          return { next, changed }
        }),
        configFileLockKey(file),
      ).pipe(Effect.orDie)

      // Only invalidate (which calls Instance.disposeAll) if config actually
      // changed on disk. No-op writes from UI mounts would otherwise abort
      // any in-flight assistant turn across all instances.
      if (changed) yield* invalidate(undefined, "config.updateGlobal")
      return next
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
      installDependencies,
    })
  }),
)

export const layer = rawLayer.pipe(Layer.provide(Env.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
)

const { runPromise } = makeRuntime(Service, defaultLayer)

export async function get() {
  return runPromise((svc) => svc.get())
}

export async function getGlobal() {
  return runPromise((svc) => svc.getGlobal())
}

export async function getConsoleState() {
  return runPromise((svc) => svc.getConsoleState())
}

export async function update(config: Info) {
  return runPromise((svc) => svc.update(config))
}

export async function updateGlobal(config: Info) {
  return runPromise((svc) => svc.updateGlobal(config))
}

export async function seedGlobalConfig() {
  await updateGlobal({})
}

export async function invalidate(wait = false) {
  return runPromise((svc) => svc.invalidate(wait))
}

export async function directories() {
  return runPromise((svc) => svc.directories())
}

export async function waitForDependencies() {
  return runPromise((svc) => svc.waitForDependencies())
}

export async function installDependencies(dir: string) {
  return runPromise((svc) => svc.installDependencies(dir))
}

const ConfigInfo = Info
const ConfigServerZod = Server
const ConfigLayoutZod = Layout
const ConfigService = Service
const ConfigLayer = layer
const ConfigDefaultLayer = defaultLayer
const ConfigGet = get
const ConfigGetGlobal = getGlobal
const ConfigGetConsoleState = getConsoleState
const ConfigUpdate = update
const ConfigUpdateGlobal = updateGlobal
const ConfigSeedGlobalConfig = seedGlobalConfig
const ConfigGlobalConfigFileForRead = globalConfigFileForRead
const ConfigGlobalConfigFileForWrite = globalConfigFileForWrite
const ConfigConfigFileLockKey = configFileLockKey
const ConfigWithConfigFileLock = withConfigFileLock
const ConfigWriteConfigTextAtomic = writeConfigTextAtomic
const ConfigProjectConfigFileForWrite = projectConfigFileForWrite
const ConfigInvalidate = invalidate
const ConfigDirectories = directories
const ConfigWaitForDependencies = waitForDependencies
const ConfigInstallDependencies = installDependencies

export namespace Config {
  export const Info = ConfigInfo
  export type Info = import("./config").Info
  export const Server = ConfigServerZod
  export const Layout = ConfigLayoutZod
  export type Layout = import("./config").Layout
  export type Interface = import("./config").Interface
  export const Service = ConfigService
  export type Service = import("./config").Service
  export const layer = ConfigLayer
  export const defaultLayer = ConfigDefaultLayer

  export const Keybinds = ConfigKeybinds.Keybinds
  export const PluginSpec = ConfigPlugin.Spec.zod
  export const PluginOptions = ConfigPlugin.Options.zod
  export type PluginSpec = ConfigPlugin.Spec
  export type PluginOptions = ConfigPlugin.Options
  export type PluginScope = ConfigPlugin.Scope
  export type PluginOrigin = ConfigPlugin.Origin
  export const pluginSpecifier = ConfigPlugin.pluginSpecifier
  export const pluginOptions = ConfigPlugin.pluginOptions
  export const resolvePluginSpec = ConfigPlugin.resolvePluginSpec
  export const deduplicatePluginOrigins = ConfigPlugin.deduplicatePluginOrigins

  export const Mcp = ConfigMCP.Info.zod
  export type Mcp = ConfigMCP.Info
  export const Permission = ConfigPermission.Info
  export type Permission = ConfigPermission.Info

  export const managedConfigDir = ConfigManaged.managedConfigDir
  export const parseManagedPlist = ConfigManaged.parseManagedPlist

  export const get = ConfigGet
  export const getGlobal = ConfigGetGlobal
  export const getConsoleState = ConfigGetConsoleState
  export const update = ConfigUpdate
  export const updateGlobal = ConfigUpdateGlobal
  export const seedGlobalConfig = ConfigSeedGlobalConfig
  export const globalConfigFileForRead = ConfigGlobalConfigFileForRead
  export const globalConfigFileForWrite = ConfigGlobalConfigFileForWrite
  export const configFileLockKey = ConfigConfigFileLockKey
  export const withConfigFileLock = ConfigWithConfigFileLock
  export const writeConfigTextAtomic = ConfigWriteConfigTextAtomic
  export const projectConfigFileForWrite = ConfigProjectConfigFileForWrite
  export const invalidate = ConfigInvalidate
  export const directories = ConfigDirectories
  export const waitForDependencies = ConfigWaitForDependencies
  export const installDependencies = ConfigInstallDependencies
}
