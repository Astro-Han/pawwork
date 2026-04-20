import { spyOn } from "bun:test"
import path from "path"
import { TuiConfig } from "../../../src/config/tui"

type PluginSpec = string | [string, Record<string, unknown>]

export function mockTuiRuntime(dir: string, plugin: PluginSpec[]) {
  const previousPluginMetaFile = process.env.OPENCODE_PLUGIN_META_FILE
  process.env.OPENCODE_PLUGIN_META_FILE = path.join(dir, "plugin-meta.json")
  const plugin_origins = plugin.map((spec) => ({
    spec,
    scope: "local" as const,
    source: path.join(dir, "tui.json"),
  }))
  const config = {
    plugin,
    plugin_origins,
  }
  const get = spyOn(TuiConfig, "get").mockResolvedValue({
    ...config,
  })
  const wait = spyOn(TuiConfig, "waitForDependencies").mockResolvedValue()
  const cwd = spyOn(process, "cwd").mockImplementation(() => dir)

  return {
    config,
    restore() {
      cwd.mockRestore()
      get.mockRestore()
      wait.mockRestore()
      if (previousPluginMetaFile === undefined) delete process.env.OPENCODE_PLUGIN_META_FILE
      else process.env.OPENCODE_PLUGIN_META_FILE = previousPluginMetaFile
    },
  }
}
