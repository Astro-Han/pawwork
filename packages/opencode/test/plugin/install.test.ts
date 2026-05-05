import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { parse as parseJsonc } from "jsonc-parser"
import { Filesystem } from "../../src/util/filesystem"
import { createPlugTask, type PlugCtx, type PlugDeps } from "../../src/cli/cmd/plug"
import { tmpdir } from "../fixture/fixture"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"

function deps(global: string, target: string | Error): PlugDeps {
  return {
    spinner: () => ({
      start() {},
      stop() {},
    }),
    log: {
      error() {},
      info() {},
      success() {},
    },
    resolve: async () => {
      if (target instanceof Error) throw target
      return target
    },
    readText: (file) => Filesystem.readText(file),
    write: async (file, text) => {
      await Filesystem.write(file, text)
    },
    exists: (file) => Filesystem.exists(file),
    files: (dir, name) =>
      name === "pawwork"
        ? [path.join(dir, `${name}.json`), path.join(dir, `${name}.jsonc`)]
        : [path.join(dir, `${name}.jsonc`), path.join(dir, `${name}.json`)],
    global,
  }
}

function ctx(dir: string): PlugCtx {
  return {
    vcs: "git",
    worktree: dir,
    directory: dir,
  }
}

function ctxDir(dir: string, worktree: string): PlugCtx {
  return {
    vcs: "none",
    worktree,
    directory: dir,
  }
}

function ctxRoot(dir: string): PlugCtx {
  return {
    vcs: "git",
    worktree: "/",
    directory: dir,
  }
}

async function plugin(
  dir: string,
  kinds?: Array<"server" | "tui">,
  opts?: {
    server?: Record<string, unknown>
    tui?: Record<string, unknown>
  },
  themes?: string[],
) {
  // Fixture helper creates mock packages exposing server and/or legacy tui exports.
  // Used to verify server exports are processed and tui exports are rejected as unsupported targets.
  const p = path.join(dir, "plugin")
  const server = kinds?.includes("server") ?? false
  const tui = kinds?.includes("tui") ?? false
  const exports: Record<string, unknown> = {}
  if (server) {
    exports["./server"] = opts?.server
      ? {
          import: "./server.js",
          config: opts.server,
        }
      : "./server.js"
  }
  if (tui) {
    exports["./tui"] = opts?.tui
      ? {
          import: "./tui.js",
          config: opts.tui,
        }
      : "./tui.js"
  }
  await fs.mkdir(p, { recursive: true })
  await Bun.write(
    path.join(p, "package.json"),
    JSON.stringify(
      {
        name: "acme",
        version: "1.0.0",
        ...(server ? { main: "./server.js" } : {}),
        ...(Object.keys(exports).length ? { exports } : {}),
        ...(themes?.length ? { "oc-themes": themes } : {}),
      },
      null,
      2,
    ),
  )
  return p
}

async function read(file: string) {
  return Filesystem.readJson<{
    plugin?: unknown[]
  }>(file)
}

describe("plugin.install.task", () => {
  test("writes PawWork global plugin config to pawwork.json", async () => {
    await using tmp = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"

    try {
      const target = await plugin(tmp.path, ["server"])
      const run = createPlugTask(
        {
          mod: "acme@1.2.3",
          global: true,
        },
        deps(path.join(tmp.path, "global"), target),
      )

      const ok = await run(ctx(tmp.path))
      expect(ok).toBe(true)

      const config = await read(path.join(tmp.path, "global", "pawwork.json"))
      expect(config.plugin).toEqual(["acme@1.2.3"])
      expect(await Filesystem.exists(path.join(tmp.path, "global", "opencode.jsonc"))).toBe(false)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("seeds PawWork global plugin config before patching it", async () => {
    await using tmp = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"

    try {
      const target = await plugin(tmp.path, ["server"])
      const dep = deps(path.join(tmp.path, "global"), target)
      dep.seedGlobalConfig = async () => {
        await Filesystem.write(path.join(tmp.path, "global", "pawwork.json"), JSON.stringify({ username: "legacy-user" }))
      }
      const run = createPlugTask(
        {
          mod: "acme@1.2.3",
          global: true,
        },
        dep,
      )

      const ok = await run(ctx(tmp.path))
      expect(ok).toBe(true)

      const config = await Filesystem.readJson<{
        username?: string
        plugin?: unknown[]
      }>(path.join(tmp.path, "global", "pawwork.json"))
      expect(config.username).toBe("legacy-user")
      expect(config.plugin).toEqual(["acme@1.2.3"])
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("returns false when PawWork global plugin config seeding fails", async () => {
    await using tmp = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"

    try {
      const target = await plugin(tmp.path, ["server"])
      const dep = deps(path.join(tmp.path, "global"), target)
      const errors: string[] = []
      dep.log.error = (msg) => errors.push(msg)
      dep.seedGlobalConfig = async () => {
        throw new Error("seed failed")
      }
      const run = createPlugTask(
        {
          mod: "acme@1.2.3",
          global: true,
        },
        dep,
      )

      const ok = await run(ctx(tmp.path))
      expect(ok).toBe(false)
      expect(errors.some((item) => item.includes("seed failed"))).toBe(true)
      expect(await Filesystem.exists(path.join(tmp.path, "global", "pawwork.json"))).toBe(false)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("writes PawWork global plugin config to an existing pawwork.jsonc", async () => {
    await using tmp = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"

    try {
      await Filesystem.write(path.join(tmp.path, "global", "pawwork.jsonc"), "{\n  // user comment\n}\n")
      const target = await plugin(tmp.path, ["server"])
      const run = createPlugTask(
        {
          mod: "acme@1.2.3",
          global: true,
        },
        deps(path.join(tmp.path, "global"), target),
      )

      const ok = await run(ctx(tmp.path))
      expect(ok).toBe(true)

      const text = await Filesystem.readText(path.join(tmp.path, "global", "pawwork.jsonc"))
      expect(text).toContain("// user comment")
      expect(parseJsonc(text).plugin).toEqual(["acme@1.2.3"])
      expect(await Filesystem.exists(path.join(tmp.path, "global", "pawwork.json"))).toBe(false)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("writes PawWork global plugin config to PAWWORK_CONFIG_DIR when PAWWORK_HOME is unset", async () => {
    await using tmp = await tmpdir()
    await using pawworkConfig = await tmpdir()
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousHome = process.env.PAWWORK_HOME
    const previousConfigDir = process.env.PAWWORK_CONFIG_DIR
    process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
    delete process.env.PAWWORK_HOME
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path

    try {
      const target = await plugin(tmp.path, ["server"])
      const run = createPlugTask(
        {
          mod: "acme@1.2.3",
          global: true,
        },
        deps(PawWorkHome.primary(), target),
      )

      const ok = await run(ctx(tmp.path))
      expect(ok).toBe(true)

      const config = await read(path.join(pawworkConfig.path, "pawwork.json"))
      expect(config.plugin).toEqual(["acme@1.2.3"])
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousHome === undefined) delete process.env.PAWWORK_HOME
      else process.env.PAWWORK_HOME = previousHome
      if (previousConfigDir === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousConfigDir
    }
  })

  test("writes only server config for packages that expose server and tui", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server", "tui"])
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    const server = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(server.plugin).toEqual(["acme@1.2.3"])
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "tui.jsonc"))).toBe(false)
  })

  test("uses only server default options from exports config metadata", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server", "tui"], {
      server: { custom: true, other: false },
      tui: { compact: true },
    })
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    const server = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(server.plugin).toEqual([["acme@1.2.3", { custom: true, other: false }]])
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "tui.jsonc"))).toBe(false)
  })

  test("preserves JSONC comments when adding server plugin, leaves pre-existing tui config unchanged", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server", "tui"])
    const cfg = path.join(tmp.path, ".opencode")
    const server = path.join(cfg, "opencode.jsonc")
    const tui = path.join(cfg, "tui.jsonc")
    await fs.mkdir(cfg, { recursive: true })
    await Bun.write(
      server,
      `{
  // server head
  "plugin": [
    // server keep
    "seed@1.0.0"
  ],
  // server tail
  "model": "x"
}
`,
    )
    await Bun.write(
      tui,
      `{
  // tui head
  "plugin": [
    // tui keep
    "seed@1.0.0"
  ],
  // tui tail
  "theme": "opencode"
}
`,
    )

    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    const serverText = await fs.readFile(server, "utf8")
    const tuiText = await fs.readFile(tui, "utf8")
    expect(serverText).toContain("// server head")
    expect(serverText).toContain("// server keep")
    expect(serverText).toContain("// server tail")
    expect(tuiText).toContain("// tui head")
    expect(tuiText).toContain("// tui keep")
    expect(tuiText).toContain("// tui tail")

    const serverJson = parseJsonc(serverText) as { plugin?: unknown[] }
    const tuiJson = parseJsonc(tuiText) as { plugin?: unknown[] }
    expect(serverJson.plugin).toEqual(["seed@1.0.0", "acme@1.2.3"])
    expect(tuiJson.plugin).toEqual(["seed@1.0.0"])
  })

  test("preserves JSONC comments when force replacing plugin version", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(
      cfg,
      `{
  "plugin": [
    // keep this note
    "acme@1.0.0"
  ]
}
`,
    )

    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
        force: true,
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    const text = await fs.readFile(cfg, "utf8")
    expect(text).toContain("// keep this note")

    const json = parseJsonc(text) as { plugin?: unknown[] }
    expect(json.plugin).toEqual(["acme@2.0.0"])
  })

  test("supports resolver target pointing to a file", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const file = path.join(target, "index.js")
    await Bun.write(file, "export {}")
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), file),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const server = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(server.plugin).toEqual(["acme@1.2.3"])
  })

  test("does not change configured package version without force", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(cfg, JSON.stringify({ plugin: ["acme@1.0.0"] }, null, 2))

    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const json = await read(cfg)
    expect(json.plugin).toEqual(["acme@1.0.0"])
  })

  test("does not change scoped package version without force", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(cfg, JSON.stringify({ plugin: ["@scope/acme@1.0.0"] }, null, 2))

    const run = createPlugTask(
      {
        mod: "@scope/acme@2.0.0",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const json = await read(cfg)
    expect(json.plugin).toEqual(["@scope/acme@1.0.0"])
  })

  test("keeps file plugin entries and still adds npm plugin", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(cfg, JSON.stringify({ plugin: ["file:///tmp/acme.ts"] }, null, 2))

    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const json = await read(cfg)
    expect(json.plugin).toEqual(["file:///tmp/acme.ts", "acme@1.2.3"])
  })

  test("force replaces configured package version and keeps tuple options", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.json")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    await Bun.write(
      cfg,
      JSON.stringify(
        {
          plugin: [["acme@1.0.0", { mode: "safe" }], "acme@1.1.0", "other@1.0.0"],
        },
        null,
        2,
      ),
    )

    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
        force: true,
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const json = await read(cfg)
    expect(json.plugin).toEqual([["acme@2.0.0", { mode: "safe" }], "other@1.0.0"])
  })

  test("writes to global scope when global flag is set", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const global = path.join(tmp.path, "global")
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
        global: true,
      },
      deps(global, target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)

    expect(await Filesystem.exists(path.join(global, "opencode.jsonc"))).toBe(true)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("writes local scope under directory when vcs is not git", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const directory = path.join(tmp.path, "dir")
    const worktree = path.join(tmp.path, "worktree")
    await fs.mkdir(directory, { recursive: true })
    await fs.mkdir(worktree, { recursive: true })
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctxDir(directory, worktree))
    expect(ok).toBe(true)
    expect(await Filesystem.exists(path.join(directory, ".opencode", "opencode.jsonc"))).toBe(true)
    expect(await Filesystem.exists(path.join(worktree, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("writes local scope under directory when worktree is root slash", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const directory = path.join(tmp.path, "dir")
    await fs.mkdir(directory, { recursive: true })
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctxRoot(directory))
    expect(ok).toBe(true)
    expect(await Filesystem.exists(path.join(directory, ".opencode", "opencode.jsonc"))).toBe(true)
  })

  test("returns false for tui-only plugins under directory when worktree is root slash", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["tui"])
    const directory = path.join(tmp.path, "dir")
    await fs.mkdir(directory, { recursive: true })
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctxRoot(directory))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(directory, ".opencode", "tui.jsonc"))).toBe(false)
    expect(await Filesystem.exists(path.join(directory, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("returns false for tui-only plugins without writing config", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["tui"])
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "tui.jsonc"))).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("returns false for oc-themes-only packages without writing config", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, undefined, undefined, ["themes/forest.json"])
    await fs.mkdir(path.join(target, "themes"), { recursive: true })
    await Bun.write(path.join(target, "themes", "forest.json"), JSON.stringify({ theme: { text: "#fff" } }, null, 2))
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "tui.jsonc"))).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("installs server plugin when package has server target and oc-themes, ignores oc-themes", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"], undefined, ["../outside.json"])
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const server = await read(path.join(tmp.path, ".opencode", "opencode.jsonc"))
    expect(server.plugin).toEqual(["acme@1.2.3"])
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "tui.jsonc"))).toBe(false)
  })

  test("force replaces version in server config, leaves tui config unchanged", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server", "tui"])
    const server = path.join(tmp.path, ".opencode", "opencode.json")
    const tui = path.join(tmp.path, ".opencode", "tui.json")
    await fs.mkdir(path.dirname(server), { recursive: true })
    await Bun.write(server, JSON.stringify({ plugin: ["acme@1.0.0", "other@1.0.0"] }, null, 2))
    await Bun.write(tui, JSON.stringify({ plugin: [["acme@1.0.0", { mode: "safe" }], "other@1.0.0"] }, null, 2))

    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
        force: true,
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(true)
    const serverJson = await read(server)
    const tuiJson = await read(tui)
    expect(serverJson.plugin).toEqual(["acme@2.0.0", "other@1.0.0"])
    expect(tuiJson.plugin).toEqual([["acme@1.0.0", { mode: "safe" }], "other@1.0.0"])
  })

  test("returns false and keeps config unchanged for invalid JSONC", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path, ["server"])
    const cfg = path.join(tmp.path, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(cfg), { recursive: true })
    const bad = '{"plugin": ["acme@1.0.0",}'
    await Bun.write(cfg, bad)

    const run = createPlugTask(
      {
        mod: "acme@2.0.0",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await fs.readFile(cfg, "utf8")).toBe(bad)
  })

  test("returns false when manifest declares no supported targets", async () => {
    await using tmp = await tmpdir()
    const target = await plugin(tmp.path)
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "tui.jsonc"))).toBe(false)
  })

  test("returns false when manifest cannot be read", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "plugin")
    await fs.mkdir(target, { recursive: true })
    const run = createPlugTask(
      {
        mod: "acme@1.2.3",
      },
      deps(path.join(tmp.path, "global"), target),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })

  test("returns false when install fails", async () => {
    await using tmp = await tmpdir()
    const run = createPlugTask(
      {
        mod: "acme@9.9.9",
      },
      deps(path.join(tmp.path, "global"), new Error("boom")),
    )

    const ok = await run(ctx(tmp.path))
    expect(ok).toBe(false)
    expect(await Filesystem.exists(path.join(tmp.path, ".opencode", "opencode.jsonc"))).toBe(false)
  })
})
