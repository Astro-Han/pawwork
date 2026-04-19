import { realpathSync } from "node:fs"
import path from "node:path"

export function createRendererWorkspaceConfig(
  cwd: string,
  resolveRealpath: (file: string) => string = realpathSync,
) {
  const workspaceRoot = path.resolve(cwd, "../..")
  const workspaceNodeModules = resolveRealpath(path.resolve(cwd, "../../node_modules"))

  return {
    resolve: {
      dedupe: ["@opencode-ai/ui"],
    },
    server: {
      fs: {
        allow: [workspaceRoot, workspaceNodeModules],
      },
    },
  }
}
