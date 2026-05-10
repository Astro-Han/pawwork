import fs from "fs/promises"
import path from "path"
import { PawWorkHome } from "@opencode-ai/core/pawwork-home"
import { MemoryFile } from "./memory"
import { MemoryProposal } from "./proposal"

export namespace MemoryService {
  export type State = {
    path: string
    disabled: boolean
    status: "ok" | "safe_mode"
    reason?: MemoryFile.SafeModeReason
    content: string
    profile?: string
    profileTooLarge?: boolean
    invalidEntries?: MemoryFile.InvalidEntry[]
  }

  export function create(input?: { home?: string; workspacePath?: string }) {
    const home = input?.home ?? PawWorkHome.primary()
    const file = path.join(home, "memory", "MEMORY.md")
    const disabledFile = path.join(home, "memory", ".disabled")
    const workspacePath = input?.workspacePath ?? process.cwd()

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
        invalidEntries: parsed.invalidEntries,
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
      await writeAtomic(next)
    }

    async function resetToTemplate() {
      await ensure()
      const previous = await fs.readFile(file, "utf8")
      await fs.writeFile(`${file}.broken.bak`, previous, { mode: 0o600 })
      await writeAtomic(MemoryFile.defaultTemplate())
    }

    async function deleteEntry(id: string) {
      const state = await read()
      const parsed = MemoryFile.parse(state.content)
      if (parsed.status !== "ok") throw new Error("Memory is in safe mode")
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      const next = state.content.replace(new RegExp(`\\n?### [^\\n]* id:${escaped}(?:\\s|$)[\\s\\S]*?(?=\\n### |$)`), "")
      if (next === state.content) throw new Error(`Memory entry not found: ${id}`)
      await writeAtomic(next.trimEnd() + "\n")
    }

    async function setDisabled(value: boolean) {
      await fs.mkdir(path.dirname(disabledFile), { recursive: true, mode: 0o700 })
      if (value) await fs.writeFile(disabledFile, "disabled\n", { mode: 0o600 })
      else await fs.rm(disabledFile, { force: true })
    }

    async function appendAcceptedProposal(input: { text: string; scope: MemoryFile.Scope; tags?: string[]; source?: string }) {
      const state = await read()
      if (state.disabled) throw new Error("Memory is disabled")
      const parsed = MemoryFile.parse(state.content)
      if (parsed.status !== "ok") throw new Error("Memory is in safe mode")
      const redacted = MemoryProposal.redact(input.text)
      const entry = MemoryFile.formatEntry({
        scope: input.scope,
        appliesTo: input.scope === "project" ? workspacePath : undefined,
        tags: input.tags,
        text: redacted.text,
        source: input.source,
      })
      await writeAtomic(`${state.content.trimEnd()}\n\n${entry}`)
      return entry
    }

    return {
      read,
      saveRaw,
      resetToTemplate,
      deleteEntry,
      setDisabled,
      appendAcceptedProposal,
    }
  }

  export function createForTest(input: { home: string; workspacePath: string }) {
    return create(input)
  }
}
