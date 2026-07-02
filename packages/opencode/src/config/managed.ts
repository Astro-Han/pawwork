export * as ConfigManaged from "./managed"

import { existsSync } from "fs"
import os from "os"
import path from "path"
import { Log, Process } from "../util"
import { Runtime } from "@opencode-ai/core/runtime"

const log = Log.create({ service: "config" })

function managedPlistDomain() {
  return Runtime.isPawWork() ? "ai.pawwork.managed" : "ai.opencode.managed"
}

// Keys injected by macOS/MDM into the managed plist that are not OpenCode config
const PLIST_META = new Set([
  "PayloadDisplayName",
  "PayloadIdentifier",
  "PayloadType",
  "PayloadUUID",
  "PayloadVersion",
  "_manualProfile",
])

function systemManagedConfigDir(): string {
  const app = Runtime.appName()
  switch (process.platform) {
    case "darwin":
      return `/Library/Application Support/${app}`
    case "win32":
      return path.join(process.env.ProgramData || "C:\\ProgramData", app)
    default:
      return `/etc/${app}`
  }
}

export function managedConfigDir() {
  return process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR || systemManagedConfigDir()
}

export function parseManagedPlist(json: string): string {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(json)
  } catch (error) {
    log.warn("failed to parse managed preferences JSON", { error })
    throw new Error("failed to parse managed preferences JSON", { cause: error })
  }
  for (const key of Object.keys(raw)) {
    if (PLIST_META.has(key)) delete raw[key]
  }
  return JSON.stringify(raw)
}

export async function readManagedPreferences() {
  if (process.platform !== "darwin") return

  const user = (() => {
    try {
      return os.userInfo().username || "user"
    } catch (err) {
      log.warn("failed to read system username, using fallback", { err })
      return "user"
    }
  })()
  const domain = managedPlistDomain()
  const paths = [
    path.join("/Library/Managed Preferences", user, `${domain}.plist`),
    path.join("/Library/Managed Preferences", `${domain}.plist`),
  ]

  for (const plist of paths) {
    if (!existsSync(plist)) continue
    log.info("reading macOS managed preferences", { path: plist })
    const result = await Process.run(["plutil", "-convert", "json", "-o", "-", plist], { nothrow: true })
    if (result.code !== 0) {
      log.warn("failed to convert managed preferences plist", { path: plist })
      continue
    }
    return {
      source: `mobileconfig:${plist}`,
      text: parseManagedPlist(result.stdout.toString()),
    }
  }

  return
}
