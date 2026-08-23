import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type PrepareDshToolsEnvironmentOptions = {
  dshBin: string
  env: NodeJS.ProcessEnv
  executable: string
  home: string
  hostToken: string
  platform?: NodeJS.Platform
  pnpmBin: string
  productToolsDir: string
}

function withToolsPath(env: NodeJS.ProcessEnv, directories: string[], separator: string) {
  const result = { ...env }
  const keys = Object.keys(result).filter((key) => key.toLowerCase() === "path")
  const key = keys[0] ?? "PATH"
  const current = result[key]
  for (const duplicate of keys.slice(1)) delete result[duplicate]
  result[key] = [...directories, current].filter(Boolean).join(separator)
  return result
}

function prepareCommandShims(home: string, windows: boolean) {
  const tools = join(home, ".tools")
  mkdirSync(tools, { mode: 0o700, recursive: true })
  if (windows) {
    writeFileSync(join(tools, "node.cmd"), '@"%PAWWORK_NODE_EXECUTABLE%" %*\r\n')
    writeFileSync(join(tools, "pnpm.cmd"), '@"%PAWWORK_NODE_EXECUTABLE%" "%PAWWORK_PNPM_CLI%" %*\r\n')
  } else {
    writeFileSync(join(tools, "node"), '#!/bin/sh\nexec "$PAWWORK_NODE_EXECUTABLE" "$@"\n', { mode: 0o700 })
    writeFileSync(
      join(tools, "pnpm"),
      '#!/bin/sh\nexec "$PAWWORK_NODE_EXECUTABLE" "$PAWWORK_PNPM_CLI" "$@"\n',
      { mode: 0o700 },
    )
  }
  return tools
}

export function prepareDshToolsEnvironment(options: PrepareDshToolsEnvironmentOptions) {
  const windows = (options.platform ?? process.platform) === "win32"
  const privateTools = prepareCommandShims(options.home, windows)
  const environment = withToolsPath(
    options.env,
    [privateTools, options.productToolsDir],
    windows ? ";" : ":",
  )
  return {
    ...environment,
    DSH_HOME: options.home,
    ELECTRON_RUN_AS_NODE: "1",
    PAWWORK_DSH_BIN: options.dshBin,
    PAWWORK_DSH_PROFILE_DIR: join(options.home, "profiles", "web"),
    PAWWORK_HOST_TOKEN: options.hostToken,
    PAWWORK_NODE_EXECUTABLE: options.executable,
    PAWWORK_PNPM_CLI: options.pnpmBin,
  }
}
