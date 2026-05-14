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
