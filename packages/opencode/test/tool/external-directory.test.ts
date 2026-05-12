import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect } from "effect"
import { Global } from "@opencode-ai/core/global"
import type * as Tool from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { assertExternalDirectory, resolveExternalPathForPermission } from "../../src/tool/external-directory"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { SessionID, MessageID } from "../../src/session/schema"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

const glob = (p: string) =>
  process.platform === "win32" ? Filesystem.normalizePathPattern(p) : p.replaceAll("\\", "/")

function withWin32Platform(fn: () => Promise<void>) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "win32", configurable: true })
  return fn().finally(() => {
    if (descriptor) Object.defineProperty(process, "platform", descriptor)
  })
}

function makeCtx() {
  const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
  const ctx: Tool.Context = {
    ...baseCtx,
    ask: (req) =>
      Effect.sync(() => {
        requests.push(req)
      }),
  }
  return { requests, ctx }
}

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        await assertExternalDirectory(ctx)
      },
    })

    expect(requests.length).toBe(0)
  })

  test("no-ops for paths inside Instance.directory", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, path.join("/tmp/project", "file.txt"))
      },
    })

    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob", async () => {
    const { requests, ctx } = makeCtx()

    const directory = "/tmp/project"
    const target = "/tmp/outside/file.txt"
    const realTmp = process.platform === "win32" ? "/tmp" : await fs.realpath("/tmp")
    const expected = glob(path.join(realTmp, "outside", "*"))

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  if (process.platform !== "win32") {
    test("asks for the real target when a tmp child is a symlink", async () => {
      const { requests, ctx } = makeCtx()

      await using outside = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "secret.txt"), "secret")
        },
      })
      await using tmp = await tmpdir({ git: true })

      const link = path.join(Global.Path.tmp, `external-directory-${process.pid}-${Date.now()}`)
      await fs.rm(link, { recursive: true, force: true })
      await fs.symlink(outside.path, link, "dir")
      try {
        const target = path.join(link, "secret.txt")
        const realTarget = path.join(await fs.realpath(outside.path), "secret.txt")
        const expected = glob(path.join(path.dirname(realTarget), "*"))

        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            await assertExternalDirectory(ctx, target)
          },
        })

        const req = requests.find((r) => r.permission === "external_directory")
        expect(req).toBeDefined()
        expect(req!.patterns).toEqual([expected])
        expect(req!.always).toEqual([expected])
        expect(req!.metadata.filepath).toBe(target)
        expect(req!.metadata.realpath).toBe(realTarget)
      } finally {
        await fs.rm(link, { recursive: true, force: true })
      }
    })

    test("asks for the real parent when a new tmp symlink child does not exist yet", async () => {
      const { requests, ctx } = makeCtx()

      await using outside = await tmpdir()
      await using tmp = await tmpdir({ git: true })

      const link = path.join(Global.Path.tmp, `external-directory-new-${process.pid}-${Date.now()}`)
      await fs.rm(link, { recursive: true, force: true })
      await fs.symlink(outside.path, link, "dir")
      try {
        const target = path.join(link, "new.txt")
        const realTarget = path.join(await fs.realpath(outside.path), "new.txt")
        const expected = glob(path.join(path.dirname(realTarget), "*"))

        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            await assertExternalDirectory(ctx, target)
          },
        })

        const req = requests.find((r) => r.permission === "external_directory")
        expect(req).toBeDefined()
        expect(req!.patterns).toEqual([expected])
        expect(req!.always).toEqual([expected])
        expect(req!.metadata.filepath).toBe(target)
        expect(req!.metadata.realpath).toBe(realTarget)
      } finally {
        await fs.rm(link, { recursive: true, force: true })
      }
    })

    test("preserves symlink traversal before dot-dot normalization", async () => {
      const { requests, ctx } = makeCtx()

      await using outside = await tmpdir()
      await using tmp = await tmpdir({ git: true })

      const link = path.join(tmp.path, "link")
      await fs.symlink(outside.path, link, "dir")

      const target = `${link}/../external-directory-${process.pid}-${Date.now()}.txt`
      const realTarget = path.join(path.dirname(await fs.realpath(outside.path)), path.basename(target))
      const expected = glob(path.join(path.dirname(realTarget), "*"))

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, target)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
      expect(req!.metadata.filepath).toBe(target)
      expect(req!.metadata.realpath).toBe(realTarget)
    })
  }

  test("uses target directory when kind=directory", async () => {
    const { requests, ctx } = makeCtx()

    const directory = "/tmp/project"
    const target = "/tmp/outside"
    const realTmp = process.platform === "win32" ? "/tmp" : await fs.realpath("/tmp")
    const expected = glob(path.join(realTmp, "outside", "*"))

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target, { kind: "directory" })
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("skips prompting when bypass=true", async () => {
    const { requests, ctx } = makeCtx()

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, "/tmp/outside/file.txt", { bypass: true })
      },
    })

    expect(requests.length).toBe(0)
  })

  test("returns the canonical Windows target used for permission metadata", async () => {
    await withWin32Platform(async () => {
      const { requests, ctx } = makeCtx()

      await Instance.provide({
        directory: "D:\\project",
        fn: async () => {
          const target = await assertExternalDirectory(ctx, "\\\\?\\D:\\outside\\file.txt")
          expect(target).toBe("D:\\outside\\file.txt")
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.metadata.filepath).toBe("D:\\outside\\file.txt")
    })
  })

  test("returns the canonical UNC target used for permission metadata", async () => {
    await withWin32Platform(async () => {
      const { requests, ctx } = makeCtx()

      await Instance.provide({
        directory: "D:\\project",
        fn: async () => {
          const target = await assertExternalDirectory(ctx, "\\\\?\\UNC\\server\\share\\outside\\file.txt")
          expect(target).toBe("\\\\server\\share\\outside\\file.txt")
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual(["\\\\server\\share\\outside\\*"])
      expect(req!.always).toEqual(["\\\\server\\share\\outside\\*"])
      expect(req!.metadata.filepath).toBe("\\\\server\\share\\outside\\file.txt")
      expect(req!.metadata.realpath).toBe("\\\\server\\share\\outside\\file.txt")
    })
  })

  test("resolves Windows junction traversal before dot-dot normalization", async () => {
    await withWin32Platform(async () => {
      const junction = "C:\\project\\tmp\\link"
      const outside = "D:\\outside"
      const missing = "D:\\secret.txt"
      const missingError = Object.assign(new Error("missing"), { code: "ENOENT" })
      const resolved = resolveExternalPathForPermission("C:\\project\\tmp\\link\\..\\secret.txt", "C:\\project", {
        lstat: (candidate) => {
          if (candidate.toLowerCase() === missing.toLowerCase()) throw missingError
          return {
            isSymbolicLink: () => candidate.toLowerCase() === junction.toLowerCase(),
          } as ReturnType<typeof import("fs").lstatSync>
        },
        realpath: (candidate) => (candidate.toLowerCase() === junction.toLowerCase() ? outside : candidate),
      })

      expect(resolved).toBe(missing)
    })
  })

  test("resolves Windows drive-relative paths against the base path", async () => {
    await withWin32Platform(async () => {
      const expected = "C:\\project\\outside.txt"
      const missingError = Object.assign(new Error("missing"), { code: "ENOENT" })
      const resolved = resolveExternalPathForPermission("C:..\\outside.txt", "C:\\project\\child", {
        lstat: (candidate) => {
          if (candidate.toLowerCase() === expected.toLowerCase()) throw missingError
          return {
            isSymbolicLink: () => false,
          } as ReturnType<typeof import("fs").lstatSync>
        },
        realpath: (candidate) => candidate,
      })

      expect(resolved).toBe(expected)
    })
  })

  test("resolves extended UNC share paths without dropping the share root", async () => {
    await withWin32Platform(async () => {
      const resolved = resolveExternalPathForPermission("\\\\?\\UNC\\server\\share\\dir\\file.txt", "D:\\project", {
        lstat: (_candidate) =>
          ({
            isSymbolicLink: () => false,
          }) as ReturnType<typeof import("fs").lstatSync>,
        realpath: (candidate) => candidate,
      })

      expect(resolved).toBe("\\\\server\\share\\dir\\file.txt")
    })
  })

  if (process.platform === "win32") {
    test("normalizes Windows path variants to one glob", async () => {
      const { requests, ctx } = makeCtx()

      await using outerTmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "outside.txt"), "x")
        },
      })
      await using tmp = await tmpdir({ git: true })

      const target = path.join(outerTmp.path, "outside.txt")
      const alt = target
        .replace(/^[A-Za-z]:/, "")
        .replaceAll("\\", "/")
        .toLowerCase()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, alt)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      const expected = glob(path.join(outerTmp.path, "*"))
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })

    test("uses drive root glob for root files", async () => {
      const { requests, ctx } = makeCtx()

      await using tmp = await tmpdir({ git: true })
      const root = path.parse(tmp.path).root
      const target = path.join(root, "boot.ini")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await assertExternalDirectory(ctx, target)
        },
      })

      const req = requests.find((r) => r.permission === "external_directory")
      const expected = path.join(root, "*")
      expect(req).toBeDefined()
      expect(req!.patterns).toEqual([expected])
      expect(req!.always).toEqual([expected])
    })
  }
})
