export * as ConfigVariable from "./variable"

import path from "path"
import os from "os"
import { createScanner } from "jsonc-parser"
import { Filesystem } from "@/util"
import { InvalidError } from "./error"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  missing?: "error" | "empty"
}

const LINE_COMMENT = 12
const BLOCK_COMMENT = 13
const EOF = 17

function source(input: ParseSource) {
  return input.type === "path" ? input.path : input.source
}

function dir(input: ParseSource) {
  return input.type === "path" ? path.dirname(input.path) : input.dir
}

function tokenInComment(text: string, index: number) {
  const scanner = createScanner(text, false)
  while (scanner.scan() !== EOF) {
    const kind = scanner.getToken()
    const start = scanner.getTokenOffset()
    if (start > index) return false
    const end = start + scanner.getTokenLength()
    if (index < start || index >= end) continue
    return kind === LINE_COMMENT || kind === BLOCK_COMMENT
  }
  return false
}

/** Apply {env:VAR}, {env:VAR?}, and {file:path} substitutions to config text. */
export async function substitute(input: SubstituteInput) {
  const missing = input.missing ?? "error"
  let text = input.text.replace(/\{env:([^}]+)\}/g, (token, rawName, index) => {
    if (tokenInComment(input.text, index)) return token
    const optional = rawName.endsWith("?")
    const varName = optional ? rawName.slice(0, -1) : rawName
    const value = process.env[varName]
    if (value !== undefined) return value
    if (optional || missing === "empty") return ""
    throw new InvalidError({
      path: source(input),
      message: `missing environment variable: "${token}"`,
    })
  })

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

    if (tokenInComment(text, index)) {
      out += token
      cursor = index + token.length
      continue
    }

    let filePath = token.replace(/^\{file:/, "").replace(/\}$/, "")
    if (filePath.startsWith("~/")) {
      filePath = path.join(os.homedir(), filePath.slice(2))
    }

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(configDir, filePath)
    const fileContent = (
      await Filesystem.readText(resolvedPath).catch((error: NodeJS.ErrnoException) => {
        if (missing === "empty") return ""

        const errMsg = `bad file reference: "${token}"`
        if (error.code === "ENOENT") {
          throw new InvalidError(
            {
              path: configSource,
              message: errMsg + ` ${resolvedPath} does not exist`,
            },
            { cause: error },
          )
        }
        throw new InvalidError({ path: configSource, message: errMsg }, { cause: error })
      })
    ).trim()

    out += JSON.stringify(fileContent).slice(1, -1)
    cursor = index + token.length
  }

  out += text.slice(cursor)
  return out
}
