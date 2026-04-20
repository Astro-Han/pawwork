import { defineConfig } from "electron-vite"
import appPlugin from "@opencode-ai/app/vite"
import { existsSync, realpathSync } from "node:fs"
import * as fs from "node:fs/promises"
import path from "node:path"
import {
  embeddedServerArtifacts,
  embeddedServerMissingArtifacts,
  embeddedServerMissingArtifactsMessage,
} from "./src/main/embedded-server-contract"
import { createRendererWorkspaceConfig } from "./renderer-workspace-config"

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const OPENCODE_ROOT = path.resolve(process.cwd(), "../opencode")
const { runtimeDir: OPENCODE_SERVER_DIST, runtimeEntry: OPENCODE_SERVER_ENTRY } = embeddedServerArtifacts(OPENCODE_ROOT)
const missingArtifacts = embeddedServerMissingArtifacts(OPENCODE_ROOT, existsSync)

if (missingArtifacts.length > 0) {
  throw new Error(embeddedServerMissingArtifactsMessage(OPENCODE_ROOT, missingArtifacts))
}

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`
const rendererWorkspaceConfig = createRendererWorkspaceConfig(process.cwd(), realpathSync)

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "opencode:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "opencode:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:opencode-server") return this.resolve(OPENCODE_SERVER_ENTRY)
        },
      },
      {
        name: "opencode:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(OPENCODE_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(path.join(OPENCODE_SERVER_DIST, l)))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    ...rendererWorkspaceConfig,
    build: {
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
