import type { StorybookConfig } from "storybook-solidjs-vite"
import tailwindcss from "@tailwindcss/vite"

const config: StorybookConfig = {
  framework: "storybook-solidjs-vite",
  // message-part / session-turn / timeline-playground stories are suffixed
  // *.stories.tsx.skip (storybook's stories glob ignores `!` negation, so files
  // must be renamed to drop out): app-level components needing runtime data
  // (sdk messages, tool registry, server context), not previewable in isolation.
  stories: ["../src/components/*.stories.tsx"],
  addons: ["@storybook/addon-docs"],
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
