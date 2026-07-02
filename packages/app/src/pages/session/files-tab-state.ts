export type SessionArtifactFile = {
  file: string
  kind: "added" | "modified"
}

export type FilesTabEntry = SessionArtifactFile & {
  path: string
}

function isAbsolutePath(path: string) {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)
}

export function deriveArtifactFiles(baseDir: string, artifacts: SessionArtifactFile[]): FilesTabEntry[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    path: isAbsolutePath(artifact.file)
      ? artifact.file
      : `${baseDir.replace(/[\\/]+$/, "")}/${artifact.file.replace(/^[\\/]+/, "")}`,
  }))
}

// Normalise a path for keyed comparisons only (e.g. matching an artifact row
// against per-file diff stats). Server-side openPath and locally-joined
// FilesTabEntry.path can mix backslashes and forward slashes on Windows, so
// exact string equality is unsafe. Do not use the return value for native
// shell calls (openPath / showItemInFolder) — those expect the OS-native
// separator and the original path should be passed through unchanged.
export function normalizeArtifactPathKey(path: string): string {
  return path.replace(/\\/g, "/")
}
