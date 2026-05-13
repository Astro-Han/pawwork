import { readFileSync } from "node:fs"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"
import { shouldForceFullReloadForUiHmr } from "./vite.hmr.js"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  {
    name: "opencode-desktop:ui-hmr-guard",
    handleHotUpdate(ctx) {
      if (!shouldForceFullReloadForUiHmr({ file: ctx.file, modules: ctx.modules })) return
      // TODO: remove this workaround after Solid/Vite fixes the upstream
      // context/HMR edge cases tracked in
      // https://github.com/solidjs/vite-plugin-solid/issues/80 and
      // https://github.com/solidjs/vite-plugin-solid/issues/106.
      ctx.server.config.logger.info(`[hmr] full reload after high-fanout ui edit: ${ctx.file}`)
      ctx.server.ws.send({ type: "full-reload", path: "*" })
      return []
    },
  },
  tailwindcss(),
  solidPlugin(),
]
