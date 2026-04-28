import fs from "node:fs/promises"
import path from "node:path"

const dir = process.env.OPENCODE_E2E_PROJECT_DIR ?? process.cwd()
const title = process.env.OPENCODE_E2E_SESSION_TITLE ?? "E2E Session"
const text = process.env.OPENCODE_E2E_MESSAGE ?? "Seeded for UI e2e"
const model = process.env.OPENCODE_E2E_MODEL ?? "opencode/gpt-5-nano"
const parts = model.split("/")
const providerID = parts[0] ?? "opencode"
const modelID = parts[1] ?? "gpt-5-nano"
const now = Date.now()

const prepareConfigDependencies = async () => {
  if (!process.env.OPENCODE_TEST_HOME || !process.env.XDG_CONFIG_HOME) return

  const { Global } = await import("../../core/src/global")
  const { Installation } = await import("../src/installation")

  const configDir = Global.Path.config
  const pluginDir = path.join(configDir, "node_modules", "@opencode-ai", "plugin")
  const target = Installation.isLocal() ? "*" : Installation.VERSION
  const pkgPath = path.join(configDir, "package.json")
  const pkg = await fs
    .readFile(pkgPath, "utf8")
    .then((value) => JSON.parse(value) as { dependencies?: Record<string, string> })
    .catch(() => ({ dependencies: {} }))

  pkg.dependencies = {
    ...(pkg.dependencies ?? {}),
    "@opencode-ai/plugin": target,
  }

  await fs.mkdir(pluginDir, { recursive: true })
  await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2))
  await fs.writeFile(
    path.join(configDir, ".gitignore"),
    ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
  )
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify(
      {
        name: "@opencode-ai/plugin",
        version: "0.0.0-e2e",
        type: "module",
        exports: "./index.js",
      },
      null,
      2,
    ),
  )
  await fs.writeFile(path.join(pluginDir, "index.js"), "export default {}\n")
}

const seed = async () => {
  await prepareConfigDependencies()

  const { Instance } = await import("../src/project/instance")
  const { InstanceBootstrap } = await import("../src/project/bootstrap")
  const { Config } = await import("../src/config/config")
  const { Session } = await import("../src/session")
  const { MessageID, PartID } = await import("../src/session/schema")
  const { Project } = await import("../src/project/project")
  const { ModelID, ProviderID } = await import("../src/provider/schema")

  try {
    await Instance.provide({
      directory: dir,
      init: InstanceBootstrap,
      fn: async () => {
        await Config.waitForDependencies()

        const session = await Session.create({ title })
        const messageID = MessageID.ascending()
        const partID = PartID.ascending()
        const message = {
          id: messageID,
          sessionID: session.id,
          role: "user" as const,
          time: { created: now },
          agent: "build",
          model: {
            providerID: ProviderID.make(providerID),
            modelID: ModelID.make(modelID),
          },
        }
        const part = {
          id: partID,
          sessionID: session.id,
          messageID,
          type: "text" as const,
          text,
          time: { start: now },
        }
        await Session.updateMessage(message)
        await Session.updatePart(part)
        await Project.update({ projectID: Instance.project.id, name: "E2E Project" })
      },
    })
  } finally {
    await Instance.disposeAll().catch(() => {})
  }
}

await seed()
