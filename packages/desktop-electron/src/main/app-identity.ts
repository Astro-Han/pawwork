export const PAWWORK_APP = {
  dev: { id: "ai.pawwork.desktop.dev", name: "PawWork Dev", releaseRepo: undefined },
  prod: { id: "ai.pawwork.desktop", name: "PawWork", releaseRepo: "pawwork" },
} as const

export const PAWWORK_RELEASE_OWNER = "Astro-Han"

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
  // hasOwn, not `in`: `in` walks the prototype chain, so "toString" and
  // "__proto__" would answer yes and produce a build with no appId.
  return raw !== undefined && Object.hasOwn(PAWWORK_APP, raw)
}

// Everything that reads OPENCODE_CHANNEL falls back to dev, so the fallback is
// stated here too. The one exception is the smoke CLI, which rejects a channel
// it was handed explicitly rather than quietly smoking a different build.
export function parsePawWorkChannel(raw: string | undefined): PawWorkChannel {
  return isPawWorkChannel(raw) ? raw : "dev"
}

// 爪印 is the product name in Chinese; the channel suffix is not translated. The
// menu applies this at runtime to app.getName() and the packager writes it into
// InfoPlist.strings at pack time, so it is stated once rather than as a table
// per consumer. resources/installer.nsh restates it a third time and cannot
// import TypeScript — electron-builder-nsis-shortcut.test.ts pins those strings.
export function localizedPawWorkName(name: string) {
  return name.replace(/^PawWork\b/, "爪印")
}
