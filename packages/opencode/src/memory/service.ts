import fs from "fs/promises"
import path from "path"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { MemoryFile } from "./memory"

export namespace MemoryService {
  export type State = {
    path: string
    disabled: boolean
    status: "ok" | "safe_mode"
    reason?: MemoryFile.SafeModeReason
    content: string
    profile?: string
    profileTooLarge?: boolean
  }

  export type ProfileState = {
    path: string
    disabled: boolean
    status: "ok" | "safe_mode"
    reason?: MemoryFile.SafeModeReason
    profile?: string
    profileTooLarge?: boolean
  }

  const writeQueues = new Map<string, Promise<void>>()

  async function enqueueWrite<T>(file: string, task: () => Promise<T>) {
    const previous = writeQueues.get(file) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(task)
    writeQueues.set(
      file,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  export function create(input?: { home?: string; workspacePath?: string }) {
    const home = input?.home ?? PawWorkHome.primary()
    const file = path.join(home, "memory", "MEMORY.md")
    const disabledFile = path.join(home, "memory", ".disabled")

    async function ensure() {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      try {
        await fs.access(file)
      } catch {
        await fs.writeFile(file, MemoryFile.defaultTemplate(), { mode: 0o600 })
      }
    }

    async function isDisabled() {
      try {
        await fs.access(disabledFile)
        return true
      } catch {
        return false
      }
    }

    async function read(): Promise<State> {
      await ensure()
      const content = await fs.readFile(file, "utf8")
      const disabled = await isDisabled()
      const parsed = MemoryFile.parse(content)
      if (parsed.status === "safe_mode") return { path: file, disabled, status: "safe_mode", reason: parsed.reason, content }
      return {
        path: file,
        disabled,
        status: "ok",
        content,
        profile: parsed.profile,
        profileTooLarge: parsed.profileTooLarge,
      }
    }

    async function readProfile(): Promise<ProfileState> {
      const disabled = await isDisabled()
      if (disabled) return { path: file, disabled, status: "ok" }

      await ensure()
      const content = await fs.readFile(file, "utf8")
      const parsed = MemoryFile.parseProfileOnly(content)
      if (parsed.status === "safe_mode") return { path: file, disabled, status: "safe_mode", reason: parsed.reason }
      return {
        path: file,
        disabled,
        status: "ok",
        profile: parsed.profile,
        profileTooLarge: parsed.profileTooLarge,
      }
    }

    async function writeAtomic(next: string) {
      await ensure()
      const previous = await fs.readFile(file, "utf8")
      await fs.writeFile(`${file}.bak`, previous, { mode: 0o600 })
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
      await fs.writeFile(tmp, next, { mode: 0o600 })
      await fs.rename(tmp, file)
    }

    async function saveRaw(next: string) {
      const parsed = MemoryFile.parse(next)
      if (parsed.status === "safe_mode") throw new Error(parsed.reason)
      await enqueueWrite(file, () => writeAtomic(next))
    }

    async function resetToTemplate() {
      await enqueueWrite(file, async () => {
        await ensure()
        const previous = await fs.readFile(file, "utf8")
        await fs.writeFile(`${file}.broken.bak`, previous, { mode: 0o600 })
        await writeAtomic(MemoryFile.defaultTemplate())
      })
    }

    async function deleteEntry(id: string) {
      await enqueueWrite(file, async () => {
        const state = await read()
        if (state.status !== "ok") throw new Error("Memory is in safe mode")
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const next = state.content.replace(
          new RegExp(`\\n?### [^\\n]*\\bid:${escaped}(?:\\s|$)[\\s\\S]*?(?=\\n### [^\\n]*\\bid:|$)`),
          "",
        )
        if (next === state.content) throw new Error(`Memory entry not found: ${id}`)
        await writeAtomic(next.trimEnd() + "\n")
      })
    }

    async function setDisabled(value: boolean) {
      await enqueueWrite(file, async () => {
        await fs.mkdir(path.dirname(disabledFile), { recursive: true, mode: 0o700 })
        if (value) await fs.writeFile(disabledFile, "disabled\n", { mode: 0o600 })
        else await fs.rm(disabledFile, { force: true })
      })
    }

    return {
      isDisabled,
      read,
      readProfile,
      saveRaw,
      resetToTemplate,
      deleteEntry,
      setDisabled,
    }
  }

  export function createForTest(input: { home: string; workspacePath: string }) {
    return create(input)
  }
}
