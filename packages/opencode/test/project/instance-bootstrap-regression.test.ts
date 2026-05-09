import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { Hono } from "hono"
import { existsSync } from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { Bus } from "../../src/bus"
import { bootstrap as cliBootstrap } from "../../src/cli/bootstrap"
import { Command } from "../../src/command"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InstanceRef } from "../../src/effect/instance-ref"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { Project } from "../../src/project/project"
import { WithInstance } from "../../src/project/with-instance"
import { InstanceMiddleware } from "../../src/server/routes/instance/middleware"
import { MessageID, SessionID } from "../../src/session/schema"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await disposeAllInstances()
})

async function bootstrapFixture() {
  return tmpdir({
    init: async (dir) => {
      const marker = path.join(dir, "config-hook-fired")
      const pluginFile = path.join(dir, "plugin.ts")
      await Bun.write(
        pluginFile,
        [
          `const MARKER = ${JSON.stringify(marker)}`,
          "export default async () => ({",
          "  config: async () => {",
          '    await Bun.write(MARKER, "ran")',
          "  },",
          "})",
          "",
        ].join("\n"),
      )
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          plugin: [pathToFileURL(pluginFile).href],
        }),
      )
      return marker
    },
  })
}

async function waitForInitialized(projectID: Project.Info["id"]) {
  for (let i = 0; i < 20; i++) {
    const project = Project.get(projectID)
    if (project?.time.initialized) return
    await Bun.sleep(10)
  }
  throw new Error("timed out waiting for project initialization marker")
}

test("legacy instance boundary runs InstanceBootstrap before callback", async () => {
  await using tmp = await bootstrapFixture()

  await WithInstance.provide({
    directory: tmp.path,
    fn: async () => "ok",
  })

  expect(existsSync(tmp.extra)).toBe(true)
})

test("CLI bootstrap runs InstanceBootstrap before callback", async () => {
  await using tmp = await bootstrapFixture()

  await cliBootstrap(tmp.path, async () => "ok")

  expect(existsSync(tmp.extra)).toBe(true)
})

test("legacy Hono instance middleware runs InstanceBootstrap before next handler", async () => {
  await using tmp = await bootstrapFixture()
  const app = new Hono().use(InstanceMiddleware()).get("/probe", (c) => c.text("ok"))

  const response = await app.request("/probe", { headers: { "x-opencode-directory": tmp.path } })

  expect(response.status).toBe(200)
  expect(existsSync(tmp.extra)).toBe(true)
})

test("InstanceRuntime.reloadInstance runs InstanceBootstrap", async () => {
  await using tmp = await bootstrapFixture()

  await InstanceRuntime.reloadInstance({ directory: tmp.path })

  expect(existsSync(tmp.extra)).toBe(true)
})

test("/init command event marks the bootstrapped project initialized", async () => {
  await using tmp = await tmpdir({ git: true })
  const ctx = await InstanceRuntime.reloadInstance({ directory: tmp.path })

  expect(Project.get(ctx.project.id)?.time.initialized).toBeUndefined()

  await AppRuntime.runPromise(
    Bus.Service.use((bus) =>
      bus.publish(Command.Event.Executed, {
        name: Command.Default.INIT,
        sessionID: SessionID.descending(),
        arguments: "",
        messageID: MessageID.ascending(),
      }),
    ).pipe(Effect.provideService(InstanceRef, ctx)),
  )

  await waitForInitialized(ctx.project.id)
})
