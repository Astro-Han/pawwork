import { readdirSync } from "node:fs"
import path from "node:path"

const REQUIRED_WASM_ARTIFACTS = [
  {
    globSuffix: "tree-sitter-*.wasm",
    matches(file: string) {
      return /^tree-sitter-[^-]+\.wasm$/.test(file)
    },
  },
  {
    globSuffix: "tree-sitter-bash-*.wasm",
    matches(file: string) {
      return /^tree-sitter-bash-.+\.wasm$/.test(file)
    },
  },
  {
    globSuffix: "tree-sitter-powershell-*.wasm",
    matches(file: string) {
      return /^tree-sitter-powershell-.+\.wasm$/.test(file)
    },
  },
] as const

export function embeddedServerArtifacts(opencodeRoot: string) {
  const runtimeDir = path.join(opencodeRoot, "dist", "node")
  return {
    runtimeDir,
    runtimeEntry: path.join(runtimeDir, "node.js"),
    requiredWasmGlobs: REQUIRED_WASM_ARTIFACTS.map((artifact) => path.join(runtimeDir, artifact.globSuffix)),
  }
}

export function embeddedServerMissingArtifacts(opencodeRoot: string, exists: (file: string) => boolean) {
  const { runtimeDir, runtimeEntry, requiredWasmGlobs } = embeddedServerArtifacts(opencodeRoot)
  const missing = exists(runtimeEntry) ? [] : [runtimeEntry]
  try {
    const entries = readdirSync(runtimeDir)
    for (const [index, artifact] of REQUIRED_WASM_ARTIFACTS.entries()) {
      if (!entries.some((file) => artifact.matches(file))) {
        missing.push(requiredWasmGlobs[index])
      }
    }
  } catch {
    missing.push(...requiredWasmGlobs)
  }
  return missing
}

export function embeddedServerMissingArtifactsMessage(opencodeRoot: string, missing: string[]) {
  return [
    "Embedded server runtime bundle is incomplete.",
    `Expected under ${opencodeRoot}:`,
    ...missing.map((file) => `- ${file}`),
    "From packages/desktop-electron run `bun ./scripts/prepare-embedded-server.ts` and retry.",
  ].join("\n")
}
