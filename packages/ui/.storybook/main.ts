import type { StorybookConfig } from "storybook-solidjs-vite"
import tailwindcss from "@tailwindcss/vite"

const config: StorybookConfig = {
  framework: "storybook-solidjs-vite",
  // App-level components (message-part, session-turn, timeline-playground) that
  // need runtime data (sdk messages, tool registry, server context) are not
  // previewable in isolation; their fork stories were removed rather than kept
  // as dead .skip files.
  stories: ["../src/components/*.stories.tsx"],
  viteFinal: async (viteConfig) => {
    const drop = (name?: string) =>
      name?.startsWith("icon-spritesheet-generator") || name === "provider-icons-plugin"
    const kept = (viteConfig.plugins ?? []).flatMap(function walk(p: unknown): unknown[] {
      if (Array.isArray(p)) return p.flatMap(walk)
      if (p === false || p == null) return []
      const name = (p as { name?: string })?.name
      return drop(name) ? [] : [p]
    })
    viteConfig.plugins = [tailwindcss(), ...kept]
    return viteConfig
  },
}

export default config
