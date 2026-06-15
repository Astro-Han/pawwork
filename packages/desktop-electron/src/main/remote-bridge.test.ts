import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createRemoteBridgeController } from "./remote-bridge"

class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = {
    written: "",
    end: (data: string) => {
      this.stdin.written += data
    },
  }
  killed = false

  kill() {
    this.killed = true
    this.emit("exit", 0, null)
    return true
  }
}

function defer<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

async function waitFor(condition: () => boolean) {
  for (let index = 0; index < 20; index++) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error("condition was not met")
}

describe("remote bridge controller", () => {
  test("surfaces malformed user config instead of silently resetting it", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const configPath = join(root, "remote-access", "config.json")
    mkdirSync(join(root, "remote-access"), { recursive: true })
    writeFileSync(configPath, "{not json", "utf8")
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => {
        throw new Error("unexpected spawn")
      },
    })

    await expect(controller.getConfig()).rejects.toThrow()
  })

  test("saves user config without starting the bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => {
        throw new Error("unexpected spawn")
      },
    })

    await controller.saveConfig({
      enabled: true,
      platform: "feishu",
      options: { appID: "id", nested: { channel: "ops" }, tags: ["mobile"] },
    })

    expect(await controller.getConfig()).toEqual({
      enabled: true,
      platform: "feishu",
      options: { appID: "id", nested: { channel: "ops" }, tags: ["mobile"] },
    })
    expect(controller.status().state).toBe("idle")
  })

  test("starts bridge with sidecar credentials through stdin without leaving runtime config on disk", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const child = new FakeChild()
    const spawns: Array<{ command: string; args: string[]; cwd?: string }> = []
    const staleConfigPath = join(root, "remote-access", "runtime-config.json")
    mkdirSync(join(root, "remote-access"), { recursive: true })
    writeFileSync(staleConfigPath, '{"pawWorkPassword":"old-secret"}', "utf8")
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: (command, args, options) => {
        spawns.push({ command, args, cwd: options.cwd })
        return child
      },
    })
    await controller.saveConfig({ enabled: true, platform: "slack", options: { botToken: "xoxb", allow_from: "U123" } })

    const status = await controller.start()

    expect(status.state).toBe("running")
    expect(spawns[0].args.slice(-2)).toEqual(["-config", "-"])
    expect(existsSync(staleConfigPath)).toBe(false)
    const runtimeConfig = JSON.parse(child.stdin.written)
    expect(runtimeConfig).toMatchObject({
      pawWorkBaseURL: "http://127.0.0.1:4090",
      pawWorkUsername: "PawWork",
      pawWorkPassword: "secret",
      platforms: [{ name: "slack", enabled: true, options: { botToken: "xoxb", allow_from: "U123" } }],
    })
    expect(runtimeConfig.statePath).toContain("sessions.json")
  })

  test("uses the built dev bridge binary when it is available", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const bridgeSource = join(root, "packages", "remote-bridge")
    const resourcesPath = join(root, "packages", "desktop-electron", "resources")
    const binary = process.platform === "win32" ? "pawwork-remote-bridge.exe" : "pawwork-remote-bridge"
    const bridgeBinary = join(resourcesPath, "tools", binary)
    mkdirSync(bridgeSource, { recursive: true })
    mkdirSync(join(resourcesPath, "tools"), { recursive: true })
    writeFileSync(join(bridgeSource, "go.mod"), "module fake\n", "utf8")
    writeFileSync(bridgeBinary, "", "utf8")
    const child = new FakeChild()
    const spawns: Array<{ command: string; args: string[] }> = []
    const controller = createRemoteBridgeController({
      userDataPath: join(root, "user-data"),
      appPath: join(root, "packages", "desktop-electron", "dist", "main.js"),
      resourcesPath,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: (command, args) => {
        spawns.push({ command, args })
        return child
      },
    })
    await controller.saveConfig({ enabled: true, platform: "slack", options: { allow_from: "U123" } })

    const status = await controller.start()

    expect(status.state).toBe("running")
    expect(spawns[0]).toEqual({ command: bridgeBinary, args: ["-config", "-"] })
  })

  test("cancels an older start while a newer start is waiting", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const children: FakeChild[] = []
    const firstReady = defer<{ url: string; username: string; password: string }>()
    const secondReady = defer<{ url: string; username: string; password: string }>()
    const ready = [firstReady, secondReady]
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: () => {
        const next = ready.shift()
        if (!next) throw new Error("unexpected serverReady")
        return next.promise
      },
      spawn: () => {
        const child = new FakeChild()
        children.push(child)
        return child
      },
    })
    await controller.saveConfig({ enabled: true, platform: "slack", options: { allow_from: "U123" } })

    const first = controller.start()
    await waitFor(() => ready.length === 1)
    const second = controller.start()
    await waitFor(() => ready.length === 0)
    firstReady.resolve({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" })
    secondReady.resolve({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" })
    await Promise.all([first, second])

    expect(children).toHaveLength(1)
    expect(children[0].killed).toBe(false)
    expect(controller.status().state).toBe("running")
  })

  test("saving a disabled config stops the running bridge", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const child = new FakeChild()
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => child,
    })
    await controller.saveConfig({ enabled: true, platform: "slack", options: { allow_from: "U123" } })
    await controller.start()

    await controller.saveConfig({ enabled: false, platform: "slack", options: { allow_from: "U123" } })

    expect(child.killed).toBe(true)
    expect(controller.status().state).toBe("idle")
    expect(controller.status().configured).toBe(false)
  })

  test("refuses to start without an explicit remote audience", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => {
        throw new Error("unexpected spawn")
      },
    })
    await controller.saveConfig({ enabled: true, platform: "slack", options: { botToken: "xoxb" } })

    const status = await controller.start()

    expect(status.state).toBe("error")
    expect(status.lastError).toContain("allow_from")
  })

  test("refuses wildcard remote audiences", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => {
        throw new Error("unexpected spawn")
      },
    })

    const status = await controller.start({
      enabled: true,
      platform: "slack",
      options: { botToken: "xoxb", allow_from: "*" },
    })

    expect(status.state).toBe("error")
    expect(status.lastError).toContain("specific allow_from")
  })

  test("refuses wildcard Feishu chat audiences", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => {
        throw new Error("unexpected spawn")
      },
    })

    const status = await controller.start({
      enabled: true,
      platform: "feishu",
      options: { app_id: "cli", app_secret: "secret", allow_chat: "*", group_only: true },
    })

    expect(status.state).toBe("error")
    expect(status.lastError).toContain("specific allow_from")
  })

  test("does not treat Feishu chat allowlists as generic platform audience controls", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const child = new FakeChild()
    const spawns: Array<{ command: string; args: string[] }> = []
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: (command, args) => {
        spawns.push({ command, args })
        return child
      },
    })

    let status = await controller.start({
      enabled: true,
      platform: "slack",
      options: { botToken: "xoxb", allow_chat: "C123", group_only: true },
    })
    expect(status.state).toBe("error")
    expect(spawns).toHaveLength(0)

    status = await controller.start({
      enabled: true,
      platform: "feishu",
      options: { app_id: "cli", app_secret: "secret", allow_chat: "oc_123", group_only: true },
    })
    expect(status.state).toBe("running")
    expect(spawns).toHaveLength(1)
  })

  test("marks bridge spawn errors without crashing the controller", async () => {
    const root = mkdtempSync(join(tmpdir(), "pawwork-remote-bridge-"))
    const child = new FakeChild()
    const controller = createRemoteBridgeController({
      userDataPath: root,
      appPath: process.cwd(),
      resourcesPath: root,
      isPackaged: false,
      serverReady: async () => ({ url: "http://127.0.0.1:4090", username: "PawWork", password: "secret" }),
      spawn: () => child,
    })
    await controller.saveConfig({ enabled: true, platform: "slack", options: { allow_from: "U123" } })

    await controller.start()
    child.emit("error", new Error("spawn go ENOENT"))

    expect(controller.status().state).toBe("error")
    expect(controller.status().lastError).toBe("spawn go ENOENT")

    const stopped = await controller.stop()
    expect(stopped.state).toBe("idle")
    expect(stopped.lastError).toBeUndefined()
  })
})
