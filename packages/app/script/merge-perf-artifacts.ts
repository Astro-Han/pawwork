import fs from "node:fs/promises"
import path from "node:path"
import type { PerfScenarioSummary } from "../src/testing/perf-metrics"

function readArg(flag: string) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return undefined
  const value = process.argv[index + 1]
  if (!value || value.startsWith("--")) return undefined
  return value
}

async function readPerfFile(filePath: string, required: boolean) {
  try {
    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as PerfScenarioSummary[]
    if (!Array.isArray(payload)) {
      throw new Error(`Expected an array of perf scenarios in ${filePath}`)
    }
    return payload
  } catch (error) {
    if (!required && (error as NodeJS.ErrnoException).code === "ENOENT") return []
    throw error
  }
}

async function main() {
  const outputPath = readArg("--output")
  const requiredPath = readArg("--required")
  const optionalPath = readArg("--optional")

  if (!outputPath || !requiredPath) {
    throw new Error("Usage: bun script/merge-perf-artifacts.ts --required <path> [--optional <path>] --output <path>")
  }

  const merged = [...(await readPerfFile(requiredPath, true)), ...(optionalPath ? await readPerfFile(optionalPath, false) : [])]
  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, `${JSON.stringify(merged, null, 2)}\n`)
}

await main()
