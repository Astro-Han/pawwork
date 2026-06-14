import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Npm } from "@opencode-ai/core/npm"
import { Effect, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Instance } from "../project/instance"
import { which } from "../util/which"
import { Flag } from "@opencode-ai/core/flag/flag"

export interface Dependencies {
  fs: AppFileSystem.Interface
  npm: Npm.Interface
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]
}

export interface Info {
  name: string
  environment?: Record<string, string>
  extensions: string[]
  enabled(deps: Dependencies): Effect.Effect<string[] | false>
}

function localCommand(command: string, ...args: string[]) {
  return Effect.sync(() => {
    const match = which(command)
    if (!match) return false
    return [match, ...args, "$FILE"]
  })
}

function npmCommand(deps: Dependencies, pkg: string, ...args: string[]) {
  return Effect.gen(function* () {
    const bin = yield* deps.npm.which(pkg)
    if (Option.isNone(bin)) return false
    return [bin.value, ...args, "$FILE"]
  })
}

function findUp(deps: Dependencies, target: string) {
  return deps.fs.findUp(target, Instance.directory, Instance.worktree).pipe(Effect.orDie)
}

function readJson<T>(deps: Dependencies, file: string) {
  return deps.fs.readJson(file).pipe(Effect.orDie) as Effect.Effect<T>
}

function probe(deps: Dependencies, command: string, args: string[]) {
  return deps.spawner
    .spawn(
      ChildProcess.make(command, args, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    )
    .pipe(
      Effect.flatMap((handle) =>
        Effect.all(
          {
            code: handle.exitCode,
            stdout: Stream.mkString(Stream.decodeText(handle.stdout)),
            stderr: Stream.mkString(Stream.decodeText(handle.stderr)),
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
    )
}

export const gofmt: Info = {
  name: "gofmt",
  extensions: [".go"],
  enabled: () => localCommand("gofmt", "-w"),
}

export const mix: Info = {
  name: "mix",
  extensions: [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"],
  enabled: () => localCommand("mix", "format"),
}

export const prettier: Info = {
  name: "prettier",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".graphql",
    ".gql",
  ],
  enabled: (deps) =>
    Effect.gen(function* () {
      const items = yield* findUp(deps, "package.json")
      for (const item of items) {
        const json = yield* readJson<{
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }>(deps, item)
        if (json.dependencies?.prettier || json.devDependencies?.prettier) {
          return yield* npmCommand(deps, "prettier", "--write")
        }
      }
      return false
    }),
}

export const oxfmt: Info = {
  name: "oxfmt",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"],
  enabled: (deps) =>
    Effect.gen(function* () {
      if (!Flag.OPENCODE_EXPERIMENTAL_OXFMT) return false
      const items = yield* findUp(deps, "package.json")
      for (const item of items) {
        const json = yield* readJson<{
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }>(deps, item)
        if (json.dependencies?.oxfmt || json.devDependencies?.oxfmt) {
          return yield* npmCommand(deps, "oxfmt")
        }
      }
      return false
    }),
}

export const biome: Info = {
  name: "biome",
  environment: {
    BUN_BE_BUN: "1",
  },
  extensions: [
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".ts",
    ".tsx",
    ".mts",
    ".cts",
    ".html",
    ".htm",
    ".css",
    ".scss",
    ".sass",
    ".less",
    ".vue",
    ".svelte",
    ".json",
    ".jsonc",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".md",
    ".mdx",
    ".graphql",
    ".gql",
  ],
  enabled: (deps) =>
    Effect.gen(function* () {
      const configs = ["biome.json", "biome.jsonc"]
      for (const config of configs) {
        const found = yield* findUp(deps, config)
        if (found.length > 0) {
          return yield* npmCommand(deps, "@biomejs/biome", "format", "--write")
        }
      }
      return false
    }),
}

export const zig: Info = {
  name: "zig",
  extensions: [".zig", ".zon"],
  enabled: () => localCommand("zig", "fmt"),
}

export const clang: Info = {
  name: "clang-format",
  extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino", ".C", ".H"],
  enabled: (deps) =>
    Effect.gen(function* () {
      const items = yield* findUp(deps, ".clang-format")
      if (items.length > 0) {
        const match = which("clang-format")
        if (match) return [match, "-i", "$FILE"]
      }
      return false
    }),
}

export const ktlint: Info = {
  name: "ktlint",
  extensions: [".kt", ".kts"],
  enabled: () => localCommand("ktlint", "-F"),
}

export const ruff: Info = {
  name: "ruff",
  extensions: [".py", ".pyi"],
  enabled: (deps) =>
    Effect.gen(function* () {
      if (!which("ruff")) return false
      const configs = ["pyproject.toml", "ruff.toml", ".ruff.toml"]
      for (const config of configs) {
        const found = yield* findUp(deps, config)
        if (found.length > 0) {
          if (config === "pyproject.toml") {
            const content = yield* deps.fs.readFileString(found[0]).pipe(Effect.orDie)
            if (content.includes("[tool.ruff]")) return ["ruff", "format", "$FILE"]
          } else {
            return ["ruff", "format", "$FILE"]
          }
        }
      }
      const dependencyFiles = ["requirements.txt", "pyproject.toml", "Pipfile"]
      for (const dep of dependencyFiles) {
        const found = yield* findUp(deps, dep)
        if (found.length > 0) {
          const content = yield* deps.fs.readFileString(found[0]).pipe(Effect.orDie)
          if (content.includes("ruff")) return ["ruff", "format", "$FILE"]
        }
      }
      return false
    }),
}

export const rlang: Info = {
  name: "air",
  extensions: [".R"],
  enabled: (deps) =>
    Effect.gen(function* () {
      const airPath = which("air")
      if (airPath == null) return false

      const result = yield* probe(deps, "air", ["--help"]).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!result) return false

      // Check for "Air: An R language server and formatter"
      const firstLine = result.stdout.split("\n")[0]
      const hasR = firstLine.includes("R language")
      const hasFormatter = firstLine.includes("formatter")
      if (hasR && hasFormatter) return ["air", "format", "$FILE"]
      return false
    }),
}

export const uvformat: Info = {
  name: "uv",
  extensions: [".py", ".pyi"],
  enabled: (deps) =>
    Effect.gen(function* () {
      if (yield* ruff.enabled(deps)) return false
      if (which("uv") !== null) {
        const result = yield* probe(deps, "uv", ["format", "--help"]).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (result?.code === 0) return ["uv", "format", "--", "$FILE"]
      }
      return false
    }),
}

export const rubocop: Info = {
  name: "rubocop",
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  enabled: () => localCommand("rubocop", "--autocorrect"),
}

export const standardrb: Info = {
  name: "standardrb",
  extensions: [".rb", ".rake", ".gemspec", ".ru"],
  enabled: () => localCommand("standardrb", "--fix"),
}

export const htmlbeautifier: Info = {
  name: "htmlbeautifier",
  extensions: [".erb", ".html.erb"],
  enabled: () => localCommand("htmlbeautifier"),
}

export const dart: Info = {
  name: "dart",
  extensions: [".dart"],
  enabled: () => localCommand("dart", "format"),
}

export const ocamlformat: Info = {
  name: "ocamlformat",
  extensions: [".ml", ".mli"],
  enabled: (deps) =>
    Effect.gen(function* () {
      if (!which("ocamlformat")) return false
      const items = yield* findUp(deps, ".ocamlformat")
      if (items.length > 0) return ["ocamlformat", "-i", "$FILE"]
      return false
    }),
}

export const terraform: Info = {
  name: "terraform",
  extensions: [".tf", ".tfvars"],
  enabled: () => localCommand("terraform", "fmt"),
}

export const latexindent: Info = {
  name: "latexindent",
  extensions: [".tex"],
  enabled: () => localCommand("latexindent", "-w", "-s"),
}

export const gleam: Info = {
  name: "gleam",
  extensions: [".gleam"],
  enabled: () => localCommand("gleam", "format"),
}

export const shfmt: Info = {
  name: "shfmt",
  extensions: [".sh", ".bash"],
  enabled: () => localCommand("shfmt", "-w"),
}

export const nixfmt: Info = {
  name: "nixfmt",
  extensions: [".nix"],
  enabled: () => localCommand("nixfmt"),
}

export const rustfmt: Info = {
  name: "rustfmt",
  extensions: [".rs"],
  enabled: () => localCommand("rustfmt"),
}

export const pint: Info = {
  name: "pint",
  extensions: [".php"],
  enabled: (deps) =>
    Effect.gen(function* () {
      const items = yield* findUp(deps, "composer.json")
      for (const item of items) {
        const json = yield* readJson<{
          require?: Record<string, string>
          "require-dev"?: Record<string, string>
        }>(deps, item)
        if (json.require?.["laravel/pint"] || json["require-dev"]?.["laravel/pint"]) return ["./vendor/bin/pint", "$FILE"]
      }
      return false
    }),
}

export const ormolu: Info = {
  name: "ormolu",
  extensions: [".hs"],
  enabled: () => localCommand("ormolu", "-i"),
}

export const cljfmt: Info = {
  name: "cljfmt",
  extensions: [".clj", ".cljs", ".cljc", ".edn"],
  enabled: () => localCommand("cljfmt", "fix", "--quiet"),
}

export const dfmt: Info = {
  name: "dfmt",
  extensions: [".d"],
  enabled: () => localCommand("dfmt", "-i"),
}
