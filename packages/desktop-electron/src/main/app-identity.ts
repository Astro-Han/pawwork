export const PAWWORK_APP = {
  dev: { id: "ai.pawwork.desktop.dev", name: "PawWork Dev" },
  beta: { id: "ai.pawwork.desktop.beta", name: "PawWork Beta" },
  prod: { id: "ai.pawwork.desktop", name: "PawWork" },
} as const

export type PawWorkChannel = keyof typeof PAWWORK_APP

// electron-builder derives the updater cache directory itself, as
// sanitizeFileName(package.json name).toLowerCase() + "-updater", and writes it
// into app-update.yml on every platform it packages. The app cannot read that
// value back at build time, so instead of restating it we pin the packaged
// package name to a stem that sanitizes to itself and derive both sides from
// the stem. Left to its default the name "@pawwork/desktop" becomes
// "@pawworkdesktop-updater", and the app would clear a pending-update directory
// the updater never writes to.
export const PAWWORK_PACKAGE_NAME = "pawwork"
export const UPDATER_CACHE_DIR_NAME = `${PAWWORK_PACKAGE_NAME}-updater`

// The set of channels is PAWWORK_APP's keys, so membership is asked here rather
// than re-spelled as a literal union at each parse site. Callers pick the policy
// for a miss: the app and the packager fall back to dev, the smoke CLI rejects.
export function isPawWorkChannel(raw: string | undefined): raw is PawWorkChannel {
  return raw !== undefined && raw in PAWWORK_APP
}
