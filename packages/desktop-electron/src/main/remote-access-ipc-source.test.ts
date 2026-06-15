import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const mainIpc = readFileSync(resolve(import.meta.dir, "ipc.ts"), "utf8")
const preload = readFileSync(resolve(import.meta.dir, "../preload/index.ts"), "utf8")
const preloadTypes = readFileSync(resolve(import.meta.dir, "../preload/types.ts"), "utf8")
const mainIndex = readFileSync(resolve(import.meta.dir, "index.ts"), "utf8")
const prebuild = readFileSync(resolve(import.meta.dir, "../../scripts/prebuild.ts"), "utf8")
const buildScript = readFileSync(resolve(import.meta.dir, "../../scripts/build-remote-bridge.ts"), "utf8")
const builderConfig = readFileSync(resolve(import.meta.dir, "../../electron-builder.config.ts"), "utf8")

describe("remote access IPC source contract", () => {
  test("exposes remote bridge config and lifecycle channels", () => {
    for (const channel of [
      "remote-access:config",
      "remote-access:save-config",
      "remote-access:status",
      "remote-access:start",
      "remote-access:stop",
    ]) {
      expect(mainIpc).toContain(`"${channel}"`)
      expect(preload).toContain(`"${channel}"`)
    }

    for (const method of [
      "remoteAccessConfig",
      "remoteAccessSaveConfig",
      "remoteAccessStatus",
      "remoteAccessStart",
      "remoteAccessStop",
    ]) {
      expect(preloadTypes).toContain(method)
    }
  })

  test("stops remote bridge with the desktop sidecar", () => {
    expect(mainIndex).toContain("async function killSidecar")
    expect(mainIndex).toContain("await remoteAccess.stop()")
    expect(mainIndex).toContain("createRemoteBridgeController")
  })

  test("auto-starts enabled remote access after the server is ready", () => {
    expect(mainIndex).toContain("autoStartRemoteAccess")
    expect(mainIndex).toContain("serverReady.promise")
    expect(mainIndex).toContain("remoteAccess.start()")
  })

  test("marks the desktop server ready after the sidecar health wait", () => {
    const healthWait = mainIndex.indexOf("health.wait")
    const serverReadyResolve = mainIndex.indexOf("serverReady.resolve")

    expect(healthWait).toBeGreaterThan(-1)
    expect(serverReadyResolve).toBeGreaterThan(healthWait)
  })

  test("builds and packages the remote bridge binary", () => {
    expect(prebuild).toContain("build-remote-bridge.ts")
    expect(buildScript).toContain("go")
    expect(buildScript).toContain("pawwork-remote-bridge")
    expect(builderConfig).toContain('from: "resources/tools/"')
    expect(builderConfig).toContain('to: "tools/"')
  })
})
