/** @jsxImportSource @opentui/solid */
import { CliRenderEvents } from "@opentui/core"
import { testRender, useRenderer } from "@opentui/solid"
import { describe, expect, spyOn, test } from "bun:test"
import { onMount } from "solid-js"
import { KVProvider } from "../../../src/cli/cmd/tui/context/kv"
import { ThemeProvider, useTheme } from "../../../src/cli/cmd/tui/context/theme"
import { TuiConfigProvider } from "../../../src/cli/cmd/tui/context/tui-config"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

describe("ThemeProvider renderer sync", () => {
  test("subscribes to renderer theme mode changes", async () => {
    let onCalls: unknown[][] = []
    let mode!: ReturnType<typeof useTheme>["mode"]

    const App = () => {
      const renderer = useRenderer() as any
      spyOn(renderer, "on").mockImplementation((...args: unknown[]) => {
        onCalls.push(args)
        return renderer
      })
      spyOn(renderer, "getPalette").mockResolvedValue({ palette: [] })
      spyOn(renderer, "setBackgroundColor").mockImplementation(() => {})
      spyOn(renderer, "clearPaletteCache").mockImplementation(() => {})

      const Probe = () => {
        const theme = useTheme()
        onMount(() => {
          mode = theme.mode
        })
        return <box />
      }

      return (
        <KVProvider>
          <TuiConfigProvider config={{} as any}>
            <ThemeProvider mode="dark">
              <Probe />
            </ThemeProvider>
          </TuiConfigProvider>
        </KVProvider>
      )
    }

    const app = await testRender(() => <App />)

    try {
      await wait(() => onCalls.length > 0)
      const hit = onCalls.find((call) => call[0] === CliRenderEvents.THEME_MODE)
      expect(hit).toBeDefined()
      expect(typeof hit?.[1]).toBe("function")
      ;(hit?.[1] as (next: "dark" | "light") => void)("light")
      expect(mode()).toBe("light")
    } finally {
      app.renderer.destroy()
    }
  })
})
