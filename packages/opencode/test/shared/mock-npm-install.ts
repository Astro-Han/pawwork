import fs from "node:fs/promises"
import path from "node:path"
import { Filesystem } from "../../src/util/filesystem"

async function writePackage(dir: string, pkg: string, files: { packageJson: object; indexJs?: string }) {
  const pkgDir = path.join(dir, "node_modules", ...pkg.split("/"))
  await fs.mkdir(pkgDir, { recursive: true })
  await Filesystem.write(path.join(pkgDir, "package.json"), JSON.stringify(files.packageJson))
  if (files.indexJs) {
    await Filesystem.write(path.join(pkgDir, "index.js"), files.indexJs)
  }
}

export async function writeMockConfigInstall(dir: string) {
  await writePackage(dir, "@opencode-ai/plugin", {
    packageJson: {
      name: "@opencode-ai/plugin",
      version: "1.0.0",
      type: "module",
      exports: "./index.js",
    },
    indexJs: "export default {}\n",
  })
  await writePackage(dir, "late-dep", {
    packageJson: {
      name: "late-dep",
      type: "module",
      exports: "./index.js",
    },
    indexJs: 'export const ready = "hello"\n',
  })
}

export async function writeInstalledConfigDeps(dir: string, dependencies: Record<string, string> = {}) {
  await fs.mkdir(dir, { recursive: true })
  await Filesystem.write(
    path.join(dir, "package.json"),
    JSON.stringify({
      dependencies: {
        "@opencode-ai/plugin": "*",
        ...dependencies,
      },
    }),
  )
  await Filesystem.write(
    path.join(dir, ".gitignore"),
    ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
  )
  await writeMockConfigInstall(dir)
}
