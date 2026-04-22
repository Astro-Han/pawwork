export * as ConfigPaths from "./paths"

import path from "path"
import os from "os"
import { type ParseError as JsoncParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser"
import { Filesystem } from "@/util"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { unique } from "remeda"
import { JsonError } from "./error"
import * as Effect from "effect/Effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"

/** Find project config files while preserving root-to-leaf config precedence and per-directory alias order. */
export const files = Effect.fn("ConfigPaths.projectFiles")(function* (
  name: string | readonly string[],
  directory: string,
  worktree?: string,
) {
  const afs = yield* AppFileSystem.Service
  const names = Array.isArray(name) ? name : [name]
  const targets = [...names].reverse().flatMap((item) => [`${item}.jsonc`, `${item}.json`])
  return (yield* afs.up({
    targets,
    start: directory,
    stop: worktree,
  })).toReversed()
})

/** Return every config directory that can contribute files, commands, agents, plugins, or config dependencies. */
export const directories = Effect.fn("ConfigPaths.directories")(function* (directory: string, worktree?: string) {
  const afs = yield* AppFileSystem.Service
  return unique([
    Global.Path.config,
    ...(!Flag.OPENCODE_DISABLE_PROJECT_CONFIG
      ? yield* afs.up({
          targets: [".opencode"],
          start: directory,
          stop: worktree,
        })
      : []),
    ...(yield* afs.up({
      targets: [".opencode"],
      start: Global.Path.home,
      stop: Global.Path.home,
    })),
    ...(Flag.OPENCODE_CONFIG_DIR ? [Flag.OPENCODE_CONFIG_DIR] : []),
  ])
})

/** Return the JSON and JSONC config file candidates for a named config inside a directory. */
export function fileInDirectory(dir: string, name: string) {
  return [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
}

/** Compatibility wrapper for callers that still expect the older promise-based project-file lookup. */
export async function projectFiles(name: string | readonly string[], directory: string, worktree: string) {
  const names = Array.isArray(name) ? name : [name]
  const targets = names.flatMap((item) => [`${item}.json`, `${item}.jsonc`])
  return Filesystem.findUp(targets, directory, worktree, { rootFirst: true })
}

/** Read a config file, returning undefined for missing files and throwing JsonError for other failures. */
export async function readFile(filepath: string) {
  return Filesystem.readText(filepath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return
    throw new JsonError({ path: filepath }, { cause: err })
  })
}

type ParseSource = string | { source: string; dir: string }

function source(input: ParseSource) {
  return typeof input === "string" ? input : input.source
}

function dir(input: ParseSource) {
  return typeof input === "string" ? path.dirname(input) : input.dir
}

async function substitute(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
  text = text.replace(/\{env:([^}]+)\}/g, (_, varName) => process.env[varName] || "")

  const fileMatches = Array.from(text.matchAll(/\{file:[^}]+\}/g))
  if (!fileMatches.length) return text

  const configDir = dir(input)
  const configSource = source(input)
  let out = ""
  let cursor = 0

  for (const match of fileMatches) {
    const token = match[0]
    const index = match.index!
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) filePath = path.join(os.homedir(), filePath.slice(2))

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    const fileContent = (
      await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (missing === "empty") return ""
        const errMsg = `bad file reference: "${token}"`
        if (error.code === "ENOENT") {
          throw new JsonError({ path: configSource, message: errMsg + ` ${resolvedPath} does not exist` }, { cause: error })
        }
        throw new JsonError({ path: configSource, message: errMsg }, { cause: error })
      })
    ).trim()

    out += JSON.stringify(fileContent).slice(1, -1)
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}

/** Substitute config tokens and parse JSONC, preserving rich location details for syntax errors. */
export async function parseText(text: string, input: ParseSource, missing: "error" | "empty" = "error") {
  const configSource = source(input)
  text = await substitute(text, input, missing)

  const errors: JsoncParseError[] = []
  const data = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length) {
    const lines = text.split("\n")
    const errorDetails = errors
      .map((e) => {
        const beforeOffset = text.substring(0, e.offset).split("\n")
        const line = beforeOffset.length
        const column = beforeOffset[beforeOffset.length - 1].length + 1
        const problemLine = lines[line - 1]
        const error = `${printParseErrorCode(e.error)} at line ${line}, column ${column}`
        if (!problemLine) return error
        return `${error}\n   Line ${line}: ${problemLine}\n${"".padStart(column + 9)}^`
      })
      .join("\n")
    throw new JsonError({
      path: configSource,
      message: `\n--- JSONC Input ---\n${text}\n--- Errors ---\n${errorDetails}\n--- End ---`,
    })
  }

  return data
}
