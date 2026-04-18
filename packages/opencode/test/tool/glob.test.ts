import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import path from "path"
import { GlobTool } from "../../src/tool/glob"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Ripgrep } from "../../src/file/ripgrep"
import { AppFileSystem } from "../../src/filesystem"
import type { Permission } from "../../src/permission"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(AppFileSystem.defaultLayer, Ripgrep.defaultLayer, Truncate.defaultLayer, Agent.defaultLayer),
)

function initGlob() {
  return runtime.runPromise(GlobTool.pipe(Effect.flatMap((info) => info.init())))
}

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

describe("tool.glob", () => {
  test("lists matching files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "a.ts"), "export const a = 1\n")
        await Bun.write(path.join(dir, "b.ts"), "export const b = 2\n")
        await Bun.write(path.join(dir, "c.txt"), "ignore\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await initGlob()
        const result = await Effect.runPromise(
          glob.execute(
            {
              pattern: "*.ts",
              path: tmp.path,
            },
            ctx,
          ),
        )

        expect(result.metadata.count).toBe(2)
        expect(result.output).toContain(path.join(tmp.path, "a.ts"))
        expect(result.output).toContain(path.join(tmp.path, "b.ts"))
        expect(result.output).not.toContain(path.join(tmp.path, "c.txt"))
      },
    })
  })

  test("sorts newer files first", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const older = path.join(dir, "older.ts")
        const newer = path.join(dir, "newer.ts")
        await Bun.write(older, "export const older = true\n")
        await new Promise((resolve) => setTimeout(resolve, 20))
        await Bun.write(newer, "export const newer = true\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await initGlob()
        const result = await Effect.runPromise(
          glob.execute(
            {
              pattern: "*.ts",
              path: tmp.path,
            },
            ctx,
          ),
        )

        const lines = result.output.split("\n").filter(Boolean)
        expect(lines[0]).toBe(path.join(tmp.path, "newer.ts"))
        expect(lines[1]).toBe(path.join(tmp.path, "older.ts"))
      },
    })
  })

  test("rejects file path as search root", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "single.ts"), "export const single = true\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await initGlob()
        await expect(
          Effect.runPromise(
            glob.execute(
              {
                pattern: "*.ts",
                path: path.join(tmp.path, "single.ts"),
              },
              ctx,
            ),
          ),
        ).rejects.toThrow("glob path must be a directory")
      },
    })
  })

  test("asks for external_directory permission when searching outside project", async () => {
    await using tmp = await tmpdir()
    await using outer = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "external.ts"), "export const ext = true\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await initGlob()
        const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
        await Effect.runPromise(
          glob.execute(
            {
              pattern: "*.ts",
              path: outer.path,
            },
            {
              ...ctx,
              ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
                Effect.sync(() => {
                  requests.push(req)
                }),
            },
          ),
        )

        const ext = requests.find((item) => item.permission === "external_directory")
        expect(ext).toBeDefined()
        expect(ext!.patterns[0]).toContain("*")
      },
    })
  })

  test("honors an aborted signal before starting ripgrep", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "match.ts"), "export const match = true\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const glob = await initGlob()
        const controller = new AbortController()
        controller.abort()

        await expect(
          Effect.runPromise(
            glob.execute(
              {
                pattern: "*.ts",
                path: tmp.path,
              },
              {
                ...ctx,
                abort: controller.signal,
              },
            ),
          ),
        ).rejects.toThrow(/abort/i)
      },
    })
  })
})
