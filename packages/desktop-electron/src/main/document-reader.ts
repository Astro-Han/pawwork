import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { tmpdir } from "node:os"

export type ExtractedDocument = { name: string; text: string; pages: number | null; ocrPages: number[]; warnings: string[] }
type ReaderOptions = { executable: string; script: string; hostModules: string; onProgress?: (message: string) => void }

export function isReadableDocument(file: string) {
  return [".pdf", ".docx"].includes(extname(file).toLowerCase())
}

export async function readDocument(file: string, options: ReaderOptions): Promise<ExtractedDocument> {
  if (!isReadableDocument(file)) throw new Error("Choose a PDF or .docx document")
  const result = await new Promise<string>((resolve, reject) => {
    const child = execFile(options.executable, [options.script, file, options.hostModules], {
      windowsHide: true, timeout: 300_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    }, (error, stdout, stderr) => {
      if (error) {
        const message = /PAWWORK_ERROR:([^\r\n]+)/.exec(stderr)?.[1]
        reject(new Error(message ?? (error.killed ? "Document reading timed out. Try fewer pages." : "Document reading failed. Check that the file is a valid, unlocked PDF or Word document.")))
      } else resolve(stdout)
    })
    let pending = ""
    child.stderr?.on("data", (chunk: Buffer) => {
      pending += chunk.toString()
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (line.startsWith("PAWWORK_PROGRESS:")) {
          try { options.onProgress?.(JSON.parse(line.slice("PAWWORK_PROGRESS:".length))) } catch { /* Ignore unrelated parser diagnostics. */ }
        }
      }
    })
  })
  const line = result.split("\n").find((entry) => entry.startsWith("PAWWORK_RESULT:"))
  if (!line) throw new Error("The document reader returned no text")
  return { ...JSON.parse(line.slice("PAWWORK_RESULT:".length)), name: basename(file) }
}

export async function readUploadedDocument(name: string, bytes: Uint8Array, options: ReaderOptions) {
  if (typeof name !== "string" || !isReadableDocument(name) || !(bytes instanceof Uint8Array) || bytes.byteLength > 25 * 1024 * 1024) {
    throw new Error("Choose a PDF or .docx document smaller than 25 MB")
  }
  const directory = await mkdtemp(join(tmpdir(), "pawwork-document-"))
  try {
    const file = join(directory, `upload${extname(name).toLowerCase()}`)
    await writeFile(file, bytes, { mode: 0o600 })
    return { ...await readDocument(file, options), name: basename(name) }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
