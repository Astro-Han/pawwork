import * as fs from "node:fs/promises"
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser"
import { Log } from "@opencode-ai/core/util/log"

const defaultLogger = Log.create({ service: "config.migrate-default-agent" })

export type MigrationLogger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
}

const failedPaths = new Set<string>()

export function _resetFailedPaths(): void {
  failedPaths.clear()
}
export function _hasFailedPath(p: string): boolean {
  return failedPaths.has(p)
}

export function stripDefaultAgent(text: string): { text: string; oldValue: unknown | undefined } {
  const parsed = parseJsonc(text, [], { allowTrailingComma: true })
  if (parsed === undefined || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text, oldValue: undefined }
  }
  const obj = parsed as Record<string, unknown>
  if (!("default_agent" in obj)) return { text, oldValue: undefined }
  const oldValue = obj.default_agent

  const edits = modify(text, ["default_agent"], undefined, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  const rewritten = applyEdits(text, edits)
  return { text: rewritten, oldValue }
}

export async function migrateDefaultAgent(
  filepath: string,
  options?: { logger?: MigrationLogger },
): Promise<{ rewritten: boolean; sanitizedText?: string }> {
  const log = options?.logger ?? defaultLogger

  let raw: string
  try {
    raw = await fs.readFile(filepath, "utf8")
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { rewritten: false }
    failedPaths.add(filepath)
    log.warn("could not read user config; skipping migration", { path: filepath, error: String(err) })
    return { rewritten: false }
  }

  const { text: sanitized, oldValue } = stripDefaultAgent(raw)
  if (oldValue === undefined) return { rewritten: false }

  if (failedPaths.has(filepath)) {
    log.debug("skipping disk rewrite; previous attempt failed in this process", { path: filepath })
    return { rewritten: false, sanitizedText: sanitized }
  }

  const tmpPath = filepath + ".migrate.tmp"
  try {
    // Preserve the original file mode so users who chmod 0600 their config
    // (e.g. configs containing apiKey) don't get downgraded to umask defaults.
    const original = await fs.stat(filepath)
    await fs.writeFile(tmpPath, sanitized, "utf8")
    await fs.chmod(tmpPath, original.mode)
    await fs.rename(tmpPath, filepath)
  } catch (err: unknown) {
    failedPaths.add(filepath)
    try {
      await fs.unlink(tmpPath)
    } catch {
      /* ignore */
    }
    log.warn("could not rewrite user config; in-memory sanitization only", {
      path: filepath,
      error: String(err),
    })
    return { rewritten: false, sanitizedText: sanitized }
  }

  log.info("migrated deprecated default_agent", { path: filepath, oldValue })
  return { rewritten: true, sanitizedText: sanitized }
}
