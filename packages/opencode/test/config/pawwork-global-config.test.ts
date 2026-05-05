import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Option } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Account } from "../../src/account"
import { Auth } from "../../src/auth"
import { Config, ConfigManaged } from "../../src/config"
import { ConfigPlugin } from "../../src/config/plugin"
import { ConfigPaths } from "../../src/config/paths"
import * as CrossSpawnSpawner from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Filesystem } from "../../src/util/filesystem"
import { tmpdir } from "../fixture/fixture"
import { resolveConfigPath } from "../../src/cli/cmd/mcp"

const infra = CrossSpawnSpawner.defaultLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
)

const emptyAccount = Layer.mock(Account.Service)({
  active: () => Effect.succeed(Option.none()),
  activeOrg: () => Effect.succeed(Option.none()),
})

const emptyAuth = Layer.mock(Auth.Service)({
  all: () => Effect.succeed({}),
})

const layer = Config.layer.pipe(
  Layer.provide(AppFileSystem.defaultLayer),
  Layer.provide(emptyAuth),
  Layer.provide(emptyAccount),
  Layer.provideMerge(infra),
)

const load = () => Effect.runPromise(Config.Service.use((svc) => svc.get()).pipe(Effect.scoped, Effect.provide(layer)))
const save = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.update(config)).pipe(Effect.scoped, Effect.provide(layer)))
const saveGlobal = (config: Config.Info) =>
  Effect.runPromise(Config.Service.use((svc) => svc.updateGlobal(config)).pipe(Effect.scoped, Effect.provide(layer)))
const clear = (wait = false) =>
  Effect.runPromise(Config.Service.use((svc) => svc.invalidate(wait)).pipe(Effect.scoped, Effect.provide(layer)))
const listConfigDirs = (directory: string, worktree: string) =>
  Effect.runPromise(ConfigPaths.directories(directory, worktree).pipe(Effect.provide(AppFileSystem.defaultLayer)))

const originalRuntimeNamespace = process.env.PAWWORK_RUNTIME_NAMESPACE
const originalPawWorkHome = process.env.PAWWORK_HOME
const originalPawWorkConfigDir = process.env.PAWWORK_CONFIG_DIR
const originalTestHome = process.env.OPENCODE_TEST_HOME

beforeEach(async () => {
  process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
  await clear(true)
})

afterEach(async () => {
  await Instance.disposeAll()
  await clear(true)
  if (originalRuntimeNamespace === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
  else process.env.PAWWORK_RUNTIME_NAMESPACE = originalRuntimeNamespace
  if (originalPawWorkHome === undefined) delete process.env.PAWWORK_HOME
  else process.env.PAWWORK_HOME = originalPawWorkHome
  if (originalPawWorkConfigDir === undefined) delete process.env.PAWWORK_CONFIG_DIR
  else process.env.PAWWORK_CONFIG_DIR = originalPawWorkConfigDir
  if (originalTestHome === undefined) delete process.env.OPENCODE_TEST_HOME
  else process.env.OPENCODE_TEST_HOME = originalTestHome
})

describe("default OpenCode config compatibility", () => {
  test("keeps OPENCODE_CONFIG_DIR outside PawWork runtime mode", async () => {
    await using opencodeConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR

    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig.path

    try {
      const dirs = await listConfigDirs(project.path, project.path)
      expect(dirs).toContain(opencodeConfig.path)
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
    }
  })

  test("keeps OpenCode managed config defaults outside PawWork runtime mode", () => {
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousManaged = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR

    try {
      const managed = ConfigManaged.managedConfigDir()
      expect(path.basename(managed)).toBe("opencode")
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
      if (previousManaged === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previousManaged
    }
  })

  test("PawWork runtime mode computes Global config under PawWork before module load", async () => {
    await using root = await tmpdir()
    const project = path.join(root.path, "project")
    const script = `
      process.env.PAWWORK_RUNTIME_NAMESPACE = "pawwork"
      process.env.XDG_CONFIG_HOME = ${JSON.stringify(root.path)}
      const { Global } = await import("@opencode-ai/core/global")
      console.log(JSON.stringify(Global.Path.config))
    `
    const result = Bun.spawnSync({
      cmd: [process.execPath, "--eval", script],
      cwd: path.join(import.meta.dir, "..", ".."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    })

    if (result.exitCode !== 0) throw new Error(Buffer.from(result.stderr).toString())
    expect(JSON.parse(Buffer.from(result.stdout).toString())).toBe(path.join(root.path, "pawwork"))
  })

  test("keeps legacy project .opencode config.json compatibility", async () => {
    await using project = await tmpdir({ git: true })

    const configDir = path.join(project.path, ".opencode")
    await fs.mkdir(configDir, { recursive: true })
    await Filesystem.write(path.join(configDir, "config.json"), JSON.stringify({ model: "compat/config" }))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const config = await load()
        expect(config.model).toBe("compat/config")
      },
    })
  })

  test("OpenCode runtime ignores PawWork project config aliases", async () => {
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    delete process.env.PAWWORK_RUNTIME_NAMESPACE

    try {
      await Filesystem.write(path.join(project.path, "pawwork.json"), JSON.stringify({ model: "leaked/root" }))
      await fs.mkdir(path.join(project.path, ".pawwork"), { recursive: true })
      await Filesystem.write(
        path.join(project.path, ".pawwork", "pawwork.json"),
        JSON.stringify({ model: "leaked/directory" }),
      )

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/root")
          expect(config.model).not.toBe("leaked/directory")
        },
      })
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("OpenCode runtime ignores PawWork global config aliases", async () => {
    await using global = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    const previousConfig = Global.Path.config
    delete process.env.PAWWORK_RUNTIME_NAMESPACE
    ;(Global.Path as { config: string }).config = global.path

    try {
      await Filesystem.write(path.join(global.path, "pawwork.json"), JSON.stringify({ model: "leaked/global" }))
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/global")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })

  test("OpenCode MCP local resolver ignores PawWork project config aliases", async () => {
    await using project = await tmpdir({ git: true })
    const previousRuntime = process.env.PAWWORK_RUNTIME_NAMESPACE
    delete process.env.PAWWORK_RUNTIME_NAMESPACE

    try {
      await Filesystem.write(path.join(project.path, "pawwork.json"), JSON.stringify({ model: "leaked/project" }))
      await Filesystem.write(path.join(project.path, "opencode.json"), JSON.stringify({ model: "expected/project" }))

      expect(await resolveConfigPath(project.path)).toBe(path.join(project.path, "opencode.json"))
    } finally {
      if (previousRuntime === undefined) delete process.env.PAWWORK_RUNTIME_NAMESPACE
      else process.env.PAWWORK_RUNTIME_NAMESPACE = previousRuntime
    }
  })
})

describe("PawWork global config isolation", () => {
  test("defaults primary PawWork Home to ~/.pawwork", async () => {
    await using home = await tmpdir()
    const previousHome = process.env.OPENCODE_TEST_HOME
    const previousPawWorkHome = process.env.PAWWORK_HOME
    const previousPawWorkConfig = process.env.PAWWORK_CONFIG_DIR
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR

    try {
      expect(PawWorkHome.primary()).toBe(path.join(home.path, ".pawwork"))
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
      if (previousPawWorkHome === undefined) delete process.env.PAWWORK_HOME
      else process.env.PAWWORK_HOME = previousPawWorkHome
      if (previousPawWorkConfig === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWorkConfig
    }
  })

  test("prefers PAWWORK_HOME over PAWWORK_CONFIG_DIR", async () => {
    await using home = await tmpdir()
    await using legacyEnv = await tmpdir()
    process.env.PAWWORK_HOME = path.join(home.path, "custom-home")
    process.env.PAWWORK_CONFIG_DIR = legacyEnv.path

    expect(PawWorkHome.primary()).toBe(path.join(home.path, "custom-home"))
    expect(PawWorkHome.candidates().slice(0, 2)).toEqual([path.join(home.path, "custom-home"), legacyEnv.path])
  })

  test("treats blank PawWork Home env vars as unset", async () => {
    await using home = await tmpdir()
    process.env.OPENCODE_TEST_HOME = home.path
    process.env.PAWWORK_HOME = ""
    process.env.PAWWORK_CONFIG_DIR = "   "

    expect(PawWorkHome.primary()).toBe(path.join(home.path, ".pawwork"))
    expect(PawWorkHome.candidates()[0]).toBe(path.join(home.path, ".pawwork"))
  })

  test("expands Windows-style tilde in PAWWORK_HOME", async () => {
    await using home = await tmpdir()
    process.env.OPENCODE_TEST_HOME = home.path
    process.env.PAWWORK_HOME = "~\\PawWorkHome"
    delete process.env.PAWWORK_CONFIG_DIR

    expect(PawWorkHome.primary()).toBe(path.join(home.path, "PawWorkHome"))
  })

  test("resolves relative PAWWORK_HOME to an absolute path", () => {
    process.env.PAWWORK_HOME = "relative-pawwork-home"
    delete process.env.PAWWORK_CONFIG_DIR

    expect(PawWorkHome.primary()).toBe(path.resolve("relative-pawwork-home"))
  })

  test("deduplicates equivalent PawWork Home candidates", async () => {
    await using home = await tmpdir()
    process.env.OPENCODE_TEST_HOME = home.path
    process.env.PAWWORK_HOME = "~/same"
    process.env.PAWWORK_CONFIG_DIR = path.join(home.path, "same")

    const candidates = PawWorkHome.candidates()
    expect(candidates.filter((candidate) => candidate === path.join(home.path, "same"))).toHaveLength(1)
  })

  test("global config reads PAWWORK_HOME before PAWWORK_CONFIG_DIR and legacy config", async () => {
    await using primary = await tmpdir()
    await using envLegacy = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.PAWWORK_HOME = primary.path
    process.env.PAWWORK_CONFIG_DIR = envLegacy.path
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await Filesystem.write(path.join(primary.path, "pawwork.json"), JSON.stringify({ model: "home/model" }))
      await Filesystem.write(path.join(envLegacy.path, "pawwork.json"), JSON.stringify({ model: "env/model" }))
      await Filesystem.write(path.join(platformLegacy.path, "pawwork.json"), JSON.stringify({ model: "legacy/model" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("home/model")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("Home config wins over legacy TOML config", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.PAWWORK_HOME = home.path
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await Filesystem.write(
        path.join(home.path, "pawwork.json"),
        JSON.stringify({ model: "home/model", username: "home-user" }),
      )
      await Filesystem.write(
        path.join(platformLegacy.path, "config"),
        ['provider = "legacy"', 'model = "model"', 'username = "legacy-user"'].join("\n"),
      )

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("home/model")
          expect(config.username).toBe("home-user")
          expect(await Bun.file(path.join(platformLegacy.path, "config")).exists()).toBeFalse()
          const migrated = JSON.parse(await Bun.file(path.join(platformLegacy.path, "pawwork.json")).text())
          expect(migrated.model).toBe("legacy/model")
          expect(migrated.username).toBe("legacy-user")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("legacy fallback JSON config is read without schema or default_agent writeback", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.PAWWORK_HOME = home.path
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      const legacy = path.join(platformLegacy.path, "pawwork.json")
      const original = JSON.stringify({ model: "legacy/model", default_agent: "build" }, null, 2)
      await Filesystem.write(legacy, original)

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("legacy/model")
          expect(await Bun.file(legacy).text()).toBe(original)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("PAWWORK_CONFIG_DIR fallback config is read without schema or default_agent writeback", async () => {
    await using primary = await tmpdir()
    await using fallback = await tmpdir()
    await using project = await tmpdir({ git: true })
    process.env.PAWWORK_HOME = primary.path
    process.env.PAWWORK_CONFIG_DIR = fallback.path

    const configFile = path.join(fallback.path, "pawwork.json")
    const original = JSON.stringify({ model: "fallback/model", default_agent: "build" }, null, 2)
    await Filesystem.write(configFile, original)

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const config = await load()
        expect(config.model).toBe("fallback/model")
        expect(await Bun.file(configFile).text()).toBe(original)
      },
    })
  })

  test("first global update writes primary Home without dropping legacy effective config", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await Filesystem.write(
        path.join(platformLegacy.path, "pawwork.json"),
        JSON.stringify({ model: "legacy/model", username: "legacy-user" }),
      )

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await saveGlobal({ username: "updated-user" })
          const primaryFile = path.join(home.path, ".pawwork", "pawwork.json")
          const saved = JSON.parse(await Bun.file(primaryFile).text())
          expect(saved.model).toBe("legacy/model")
          expect(saved.username).toBe("updated-user")
          expect(await Bun.file(path.join(platformLegacy.path, "pawwork.json")).text()).toContain("legacy-user")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("seedGlobalConfig writes primary Home without dropping legacy effective config", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    await using platformLegacy = await tmpdir()
    const previousConfig = Global.Path.config
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      const legacy = path.join(platformLegacy.path, "pawwork.json")
      const original = JSON.stringify({ default_agent: "build", username: "legacy-user" })
      await Filesystem.write(legacy, original)
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await Config.seedGlobalConfig()
          const saved = JSON.parse(await Bun.file(path.join(home.path, ".pawwork", "pawwork.json")).text())
          expect(saved.username).toBe("legacy-user")
          expect(saved.default_agent).toBeUndefined()
          expect(await Bun.file(legacy).text()).toBe(original)
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("global config write resolver ignores OpenCode filenames in PawWork Home", async () => {
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path
    delete process.env.PAWWORK_CONFIG_DIR

    await Filesystem.write(path.join(home.path, "opencode.jsonc"), JSON.stringify({ model: "leaked/model" }))
    expect(Config.globalConfigFileForWrite()).toBe(path.join(home.path, "pawwork.json"))

    await Filesystem.write(path.join(home.path, "pawwork.jsonc"), JSON.stringify({ model: "pawwork/model" }))
    expect(Config.globalConfigFileForWrite()).toBe(path.join(home.path, "pawwork.jsonc"))
  })

  test("global config load ignores directories named pawwork config files", async () => {
    await using home = await tmpdir()
    process.env.PAWWORK_HOME = home.path
    delete process.env.PAWWORK_CONFIG_DIR

    await fs.mkdir(path.join(home.path, "pawwork.jsonc"), { recursive: true })
    expect(PawWorkHome.configFilesToLoad()).toEqual([])
    expect(() => Config.globalConfigFileForWrite()).toThrow("PawWork config path exists but is not a file")
  })

  test("first global update preserves merged legacy json and jsonc config", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await Filesystem.write(path.join(platformLegacy.path, "pawwork.json"), JSON.stringify({ model: "legacy/model" }))
      await Filesystem.write(path.join(platformLegacy.path, "pawwork.jsonc"), JSON.stringify({ username: "jsonc-user" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await saveGlobal({ username: "updated-user" })
          const saved = JSON.parse(await Bun.file(path.join(home.path, ".pawwork", "pawwork.json")).text())
          expect(saved.model).toBe("legacy/model")
          expect(saved.username).toBe("updated-user")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("PawWork Home global plugin origin points at the Home config file", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    process.env.PAWWORK_HOME = home.path

    await Filesystem.write(
      path.join(home.path, "pawwork.json"),
      JSON.stringify({
        plugin: ["./plugin.ts"],
      }),
    )

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const config = await load()
        const origin = config.plugin_origins?.find((item) =>
          ConfigPlugin.pluginSpecifier(item.spec).endsWith("/plugin.ts"),
        )
        expect(origin?.source).toBe(path.join(home.path, "pawwork.json"))
      },
    })
  })

  test("global resource directories load legacy before PawWork Home so Home wins conflicts", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await fs.mkdir(path.join(home.path, ".pawwork"), { recursive: true })
      const dirs = await listConfigDirs(project.path, project.path)
      expect(dirs.indexOf(path.join(home.path, ".pawwork"))).toBeGreaterThanOrEqual(0)
      expect(dirs.indexOf(platformLegacy.path)).toBeGreaterThanOrEqual(0)
      expect(dirs.indexOf(platformLegacy.path)).toBeLessThan(dirs.indexOf(path.join(home.path, ".pawwork")))
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("global resource directories ignore PawWork Home candidates that are files", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    const fileHome = path.join(home.path, "not-a-directory")
    process.env.PAWWORK_HOME = fileHome
    delete process.env.PAWWORK_CONFIG_DIR

    await Filesystem.write(fileHome, "not a directory")

    const dirs = await listConfigDirs(project.path, project.path)
    expect(dirs).not.toContain(fileHome)
  })

  test("legacy global resource directory stays read-only for generated dependency files", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await fs.mkdir(path.join(home.path, ".pawwork"), { recursive: true })
      await fs.mkdir(path.join(platformLegacy.path, "command"), { recursive: true })
      await Filesystem.write(path.join(platformLegacy.path, "command", "hello.md"), "legacy command")

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.command?.hello.template).toBe("legacy command")
          expect(await Bun.file(path.join(platformLegacy.path, ".gitignore")).exists()).toBeFalse()
          expect(await Bun.file(path.join(platformLegacy.path, "package.json")).exists()).toBeFalse()
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("PawWork Home command overrides same-name legacy global command", async () => {
    await using home = await tmpdir()
    await using platformLegacy = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousConfig = Global.Path.config
    process.env.OPENCODE_TEST_HOME = home.path
    delete process.env.PAWWORK_HOME
    delete process.env.PAWWORK_CONFIG_DIR
    ;(Global.Path as { config: string }).config = platformLegacy.path

    try {
      await Filesystem.write(
        path.join(platformLegacy.path, "command", "hello.md"),
        `---
description: Legacy command
---
legacy command`,
      )
      await Filesystem.write(
        path.join(home.path, ".pawwork", "command", "hello.md"),
        `---
description: Home command
---
home command`,
      )

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.command?.hello.template).toBe("home command")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("does not discover home-level .opencode config implicitly", async () => {
    await using home = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousHome = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = home.path

    try {
      const homeConfigDir = path.join(home.path, ".opencode")
      await fs.mkdir(homeConfigDir, { recursive: true })
      await Filesystem.write(path.join(homeConfigDir, "opencode.json"), JSON.stringify({ model: "leaked/model" }))

      const dirs = await listConfigDirs(project.path, project.path)

      expect(dirs).not.toContain(homeConfigDir)

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/model")
        },
      })
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODE_TEST_HOME
      else process.env.OPENCODE_TEST_HOME = previousHome
    }
  })

  test("ignores OPENCODE_CONFIG_DIR as an implicit OpenCode global config path", async () => {
    await using opencodeConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR
    const previousPawWork = process.env.PAWWORK_CONFIG_DIR
    process.env.OPENCODE_CONFIG_DIR = opencodeConfig.path
    delete process.env.PAWWORK_CONFIG_DIR

    try {
      await Filesystem.write(path.join(opencodeConfig.path, "opencode.json"), JSON.stringify({ model: "leaked/env" }))

      const dirs = await listConfigDirs(project.path, project.path)
      expect(dirs).not.toContain(opencodeConfig.path)

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/env")
        },
      })
    } finally {
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
      if (previousPawWork === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWork
    }
  })

  test("PAWWORK_CONFIG_DIR reads PawWork filenames and ignores OpenCode filenames", async () => {
    await using pawworkConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR
    const previousPawWork = process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path

    try {
      await Filesystem.write(path.join(pawworkConfig.path, "opencode.json"), JSON.stringify({ model: "leaked/env" }))
      await Filesystem.write(path.join(pawworkConfig.path, "pawwork.json"), JSON.stringify({ model: "expected/model" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("expected/model")
        },
      })
    } finally {
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
      if (previousPawWork === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWork
    }
  })

  test("PAWWORK_CONFIG_DIR with only opencode.json does not affect config", async () => {
    await using pawworkConfig = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previousOpenCode = process.env.OPENCODE_CONFIG_DIR
    const previousPawWork = process.env.PAWWORK_CONFIG_DIR
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.PAWWORK_CONFIG_DIR = pawworkConfig.path

    try {
      await Filesystem.write(path.join(pawworkConfig.path, "opencode.json"), JSON.stringify({ model: "leaked/env" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).not.toBe("leaked/env")
        },
      })
    } finally {
      if (previousOpenCode === undefined) delete process.env.OPENCODE_CONFIG_DIR
      else process.env.OPENCODE_CONFIG_DIR = previousOpenCode
      if (previousPawWork === undefined) delete process.env.PAWWORK_CONFIG_DIR
      else process.env.PAWWORK_CONFIG_DIR = previousPawWork
    }
  })

  test("loads project .pawwork config directories", async () => {
    await using project = await tmpdir({ git: true })
    const pawworkDir = path.join(project.path, ".pawwork")
    await fs.mkdir(pawworkDir, { recursive: true })
    await Filesystem.write(path.join(pawworkDir, "pawwork.json"), JSON.stringify({ model: "project/pawwork" }))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const dirs = await listConfigDirs(project.path, project.path)
        expect(dirs).toContain(pawworkDir)

        const config = await load()
        expect(config.model).toBe("project/pawwork")
      },
    })
  })

  test("project .opencode directories stay read-only for dependency installs", async () => {
    await using project = await tmpdir({ git: true })
    const opencodeDir = path.join(project.path, ".opencode")
    await fs.mkdir(opencodeDir, { recursive: true })
    await Filesystem.write(path.join(opencodeDir, "opencode.json"), JSON.stringify({ model: "compat/model" }))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const config = await load()
        expect(config.model).toBe("compat/model")

        expect(await Bun.file(path.join(opencodeDir, "package.json")).exists()).toBeFalse()
        expect(await Bun.file(path.join(opencodeDir, ".gitignore")).exists()).toBeFalse()
      },
    })
  })

  test("project config update writes pawwork.json and reloads it", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await save({ model: "project/model" })

        expect(await Bun.file(path.join(project.path, "config.json")).exists()).toBeFalse()
        expect(await Bun.file(path.join(project.path, "pawwork.json")).exists()).toBeTrue()

        const after = await load()
        expect(after.model).toBe("project/model")
      },
    })
  })

  test("project config update writes to the active PawWork jsonc file", async () => {
    await using project = await tmpdir({ git: true })

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await Filesystem.write(path.join(project.path, "pawwork.json"), JSON.stringify({ model: "json/model" }))
        await Filesystem.write(path.join(project.path, "pawwork.jsonc"), JSON.stringify({ model: "jsonc/model" }))

        const before = await load()
        expect(before.model).toBe("jsonc/model")

        await save({ model: "updated/project" })
        const after = await load()
        expect(after.model).toBe("updated/project")
        expect(JSON.parse(await Bun.file(path.join(project.path, "pawwork.jsonc")).text()).model).toBe(
          "updated/project",
        )
      },
    })
  })

  test("PawWork local write resolver reuses existing .opencode pawwork.jsonc", async () => {
    await using project = await tmpdir({ git: true })
    const configDir = path.join(project.path, ".opencode")
    await fs.mkdir(configDir, { recursive: true })
    await Filesystem.write(path.join(configDir, "pawwork.jsonc"), JSON.stringify({ model: "directory/model" }))

    expect(await resolveConfigPath(project.path)).toBe(path.join(configDir, "pawwork.jsonc"))

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await save({ model: "updated/model" })
        expect(JSON.parse(await Bun.file(path.join(configDir, "pawwork.jsonc")).text()).model).toBe("updated/model")
        expect(await Bun.file(path.join(project.path, "pawwork.json")).exists()).toBeFalse()
      },
    })
  })

  test("global config update writes pawwork.json and ignores app-level opencode.json", async () => {
    await using project = await tmpdir({ git: true })
    await using global = await tmpdir()
    const globalDir = global.path
    const previousConfig = Global.Path.config
    process.env.PAWWORK_HOME = globalDir
    ;(Global.Path as { config: string }).config = globalDir

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await Filesystem.write(path.join(globalDir, "opencode.json"), JSON.stringify({ model: "leaked/global" }))

          const before = await load()
          expect(before.model).not.toBe("leaked/global")

          await saveGlobal({ model: "test/model" })
          const configPath = path.join(globalDir, "pawwork.json")
          expect(await Bun.file(configPath).exists()).toBeTrue()
          expect(JSON.parse(await Bun.file(configPath).text()).model).toBe("test/model")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("global config update preserves existing file permissions", async () => {
    await using project = await tmpdir({ git: true })
    await using global = await tmpdir()
    process.env.PAWWORK_HOME = global.path

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const configPath = path.join(global.path, "pawwork.json")
        await Filesystem.write(configPath, JSON.stringify({ model: "test/model" }))
        await fs.chmod(configPath, 0o600)

        await saveGlobal({ username: "secure-user" })

        const mode = (await fs.stat(configPath)).mode & 0o777
        expect(mode).toBe(0o600)
        expect(JSON.parse(await Bun.file(configPath).text()).username).toBe("secure-user")
      },
    })
  })

  test("global config update reports file PawWork Home before taking the write lock", async () => {
    await using project = await tmpdir({ git: true })
    await using home = await tmpdir()
    const fileHome = path.join(home.path, "not-a-directory")
    process.env.PAWWORK_HOME = fileHome
    await Filesystem.write(fileHome, "not a directory")

    await Instance.provide({
      directory: project.path,
      fn: async () => {
        await expect(saveGlobal({ username: "blocked" })).rejects.toThrow(/not a directory|directory/i)
      },
    })
  })

  test("global config update writes to the active PawWork config file", async () => {
    await using project = await tmpdir({ git: true })
    await using global = await tmpdir()
    const globalDir = global.path
    const previousConfig = Global.Path.config
    process.env.PAWWORK_HOME = globalDir
    ;(Global.Path as { config: string }).config = globalDir

    try {
      await Instance.provide({
        directory: project.path,
        fn: async () => {
          await Filesystem.write(path.join(globalDir, "pawwork.json"), JSON.stringify({ model: "json/model" }))
          await Filesystem.write(path.join(globalDir, "pawwork.jsonc"), JSON.stringify({ model: "jsonc/model" }))

          const before = await load()
          expect(before.model).toBe("jsonc/model")

          await saveGlobal({ model: "updated/model" })
          const after = await load()
          expect(after.model).toBe("updated/model")
          expect(JSON.parse(await Bun.file(path.join(globalDir, "pawwork.jsonc")).text()).model).toBe("updated/model")
        },
      })
    } finally {
      ;(Global.Path as { config: string }).config = previousConfig
    }
  })

  test("managed config defaults use PawWork-owned locations", () => {
    const previous = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR

    try {
      const managed = ConfigManaged.managedConfigDir()
      expect(path.basename(managed)).toBe("pawwork")
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previous
    }
  })

  test("managed config ignores opencode.json in PawWork runtime mode", async () => {
    await using managed = await tmpdir()
    await using project = await tmpdir({ git: true })
    const previous = process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
    process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = managed.path

    try {
      await Filesystem.write(path.join(managed.path, "opencode.json"), JSON.stringify({ model: "leaked/managed" }))
      await Filesystem.write(path.join(managed.path, "pawwork.json"), JSON.stringify({ model: "expected/managed" }))

      await Instance.provide({
        directory: project.path,
        fn: async () => {
          const config = await load()
          expect(config.model).toBe("expected/managed")
        },
      })
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR
      else process.env.OPENCODE_TEST_MANAGED_CONFIG_DIR = previous
    }
  })
})
