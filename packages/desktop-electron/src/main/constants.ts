import { app } from "electron"
import { PAWWORK_APP, PAWWORK_RELEASE_OWNER, parsePawWorkChannel } from "./app-identity"

export const CHANNEL = parsePawWorkChannel(import.meta.env.OPENCODE_CHANNEL)

// Opt-in dev switch to exercise the real updater feed (R2 + GitHub fallback)
// against dl.pawwork.ai under `pnpm dev:desktop`. Off unless explicitly set,
// so normal dev runs never hit the network or forceDevUpdateConfig.
export const DEV_UPDATER = !app.isPackaged && process.env.PAWWORK_DEV_UPDATER === "1"
export const UPDATER_ACTIVE = (app.isPackaged && CHANNEL !== "dev") || DEV_UPDATER

// In-app update feed (#219). The feed is the channel's own release repository,
// except for a dev build under PAWWORK_DEV_UPDATER, which has no release of its
// own and exercises prod's. R2 mirrors the prod releases for mainland China
// reach and GitHub is the global fallback, so R2 applies exactly when the feed
// is prod's — beta has no mirror there.
export const UPDATE_CHANNEL = "latest"
export const UPDATE_GITHUB_OWNER = PAWWORK_RELEASE_OWNER
export const UPDATE_GITHUB_REPO = PAWWORK_APP[CHANNEL].releaseRepo ?? PAWWORK_APP.prod.releaseRepo
export const DOWNLOAD_PUBLIC_BASE = "https://dl.pawwork.ai"
export const UPDATE_R2_ENABLED = UPDATE_GITHUB_REPO === PAWWORK_APP.prod.releaseRepo
