import { statSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"

export function validWorkspaceDirectory(value: unknown): string | undefined {
  if (typeof value !== "string" || !isAbsolute(value)) return undefined
  try {
    return statSync(value).isDirectory() ? resolve(value) : undefined
  } catch {
    return undefined
  }
}

export function launchWorkspaceFromArgs(argv: string[]): string | undefined {
  const flag = argv.lastIndexOf("--workspace")
  return flag < 0 ? undefined : validWorkspaceDirectory(argv[flag + 1])
}

export function validWorkspaceFile(value: unknown): string | undefined {
  if (typeof value !== "string" || !isAbsolute(value)) return undefined
  try {
    return statSync(value).isFile() ? resolve(value) : undefined
  } catch {
    return undefined
  }
}

export function launchFileFromArgs(argv: string[]): string | undefined {
  const flag = argv.lastIndexOf("--note-file")
  return flag < 0 ? undefined : validWorkspaceFile(argv[flag + 1])
}

export function launchFolderFromArgs(argv: string[]): string | undefined {
  const file = launchFileFromArgs(argv)
  return file ? dirname(file) : launchWorkspaceFromArgs(argv)
}
