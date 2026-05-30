import { app } from "electron"
import { PAWWORK_RUNTIME } from "./runtime-namespace"
export { FEEDBACK_FORM_URL } from "./support-links"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.OPENCODE_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = PAWWORK_RUNTIME.settingsStore
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const UPDATER_ENABLED = app.isPackaged && CHANNEL !== "dev"

// Opt-in dev switch to exercise the real updater feed (R2 + GitHub fallback)
// against dl.pawwork.ai under `bun run dev:desktop`. Off unless explicitly set,
// so normal dev runs never hit the network or forceDevUpdateConfig.
export const DEV_UPDATER = !app.isPackaged && process.env.PAWWORK_DEV_UPDATER === "1"
export const UPDATER_ACTIVE = UPDATER_ENABLED || DEV_UPDATER

// In-app update feed (#219). Prod releases are mirrored to Cloudflare R2 for
// mainland China reach; GitHub is the global fallback. Beta has no R2 mirror.
export const UPDATE_CHANNEL = "latest"
export const UPDATE_GITHUB_OWNER = "Astro-Han"
export const UPDATE_GITHUB_REPO = CHANNEL === "beta" ? "pawwork-beta" : "pawwork"
export const DOWNLOAD_PUBLIC_BASE = "https://dl.pawwork.ai"
export const UPDATE_R2_ENABLED = CHANNEL === "prod" || DEV_UPDATER
