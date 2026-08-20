import { defineConfig } from "electron-vite"
import { parsePawWorkChannel } from "./src/main/app-identity"

// This is what CHANNEL resolves to inside the bundled main process, so a
// channel this misses ships as dev: dev profile, dev appId, updater off.
const channel = parsePawWorkChannel(process.env.OPENCODE_CHANNEL)

export default defineConfig({
  main: {
    define: {
      "import.meta.env.OPENCODE_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
    },
  },
})
