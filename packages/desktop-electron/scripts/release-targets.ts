// One statement of what a PawWork release ships. Every script that names a
// release asset, an updater metadata file, a download-manifest key, or a
// per-target CI artifact derives it from here. Before, the verifier, the
// auto-publisher, the R2 mirror and the metadata finalizer each restated a
// different slice of the same matrix, and build.yml restated it a fifth time.
export const RELEASE_TARGETS = [
  {
    os: "mac",
    arch: "arm64",
    installerExt: "dmg",
    updaterExt: "zip",
    metadata: "latest-mac.yml",
    // Rust-triple names, because that is what the CI artifacts are keyed by.
    metadataArtifact: "latest-yml-aarch64-apple-darwin",
    manifestKey: "macArm64",
  },
  {
    os: "mac",
    arch: "x64",
    installerExt: "dmg",
    updaterExt: "zip",
    metadata: "latest-mac.yml",
    metadataArtifact: "latest-yml-x86_64-apple-darwin",
    manifestKey: "macX64",
  },
  {
    os: "win",
    arch: "x64",
    installerExt: "exe",
    updaterExt: "exe",
    metadata: "latest.yml",
    metadataArtifact: "latest-yml-x86_64-pc-windows-msvc",
    manifestKey: "winX64",
  },
] as const

export type ReleaseTarget = (typeof RELEASE_TARGETS)[number]
export type MetadataFile = ReleaseTarget["metadata"]

export const METADATA_FILES: MetadataFile[] = [...new Set(RELEASE_TARGETS.map((target) => target.metadata))]

export function releaseAssetName(target: { os: string; arch: string }, version: string, ext: string) {
  return `pawwork-${target.os}-${target.arch}-${version}.${ext}`
}

export function releaseTarget(os: string, arch: string): ReleaseTarget {
  const target = RELEASE_TARGETS.find((entry) => entry.os === os && entry.arch === arch)
  if (!target) throw new Error(`unsupported release target: ${os}-${arch}`)
  return target
}
