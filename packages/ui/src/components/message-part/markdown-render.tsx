import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { getDirectory as _getDirectory } from "@opencode-ai/core/util/path"
import { useData } from "../../context"
import { Markdown } from "../markdown"

const TEXT_RENDER_PACE_MS = 24
const TEXT_RENDER_SNAP = /[\s.,!?;:)\]]/

function step(size: number) {
  if (size <= 12) return 2
  if (size <= 48) return 4
  if (size <= 96) return 8
  return Math.min(24, Math.ceil(size / 8))
}

function next(text: string, start: number) {
  const end = Math.min(text.length, start + step(text.length - start))
  const max = Math.min(text.length, end + 8)
  for (let i = end; i < max; i++) {
    if (TEXT_RENDER_SNAP.test(text[i] ?? "")) return i + 1
  }
  return end
}

export function createPacedValue(getValue: () => string, live?: () => boolean) {
  const [value, setValue] = createSignal(getValue())
  let shown = getValue()
  let timeout: ReturnType<typeof setTimeout> | undefined

  const clear = () => {
    if (!timeout) return
    clearTimeout(timeout)
    timeout = undefined
  }

  const sync = (text: string) => {
    shown = text
    setValue(text)
  }

  const run = () => {
    timeout = undefined
    const text = getValue()
    if (!live?.()) {
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length <= shown.length) {
      sync(text)
      return
    }
    const end = next(text, shown.length)
    sync(text.slice(0, end))
    if (end < text.length) timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  }

  createEffect(() => {
    const text = getValue()
    if (!live?.()) {
      clear()
      sync(text)
      return
    }
    if (!text.startsWith(shown) || text.length < shown.length) {
      clear()
      sync(text)
      return
    }
    if (text.length === shown.length || timeout) return
    timeout = setTimeout(run, TEXT_RENDER_PACE_MS)
  })

  onCleanup(() => {
    clear()
  })

  return value
}

function isAbsoluteLikePath(p: string): boolean {
  return (
    p.startsWith("/") ||
    /^[A-Za-z]:[\\/]/.test(p) ||
    // Windows UNC roots: \\server\share\file.txt
    p.startsWith("\\\\")
  )
}

function joinWorkspacePath(directory: string, relative: string): string {
  const sep = directory.includes("\\") ? "\\" : "/"
  const trimmed = directory.replace(/[\\/]+$/, "")
  // Drop a leading `./` (or `.\`) so the joined path doesn't end up as
  // `/dir/./foo.ts`. `..` segments stay verbatim — both POSIX and
  // Win32 shell.showItemInFolder resolve them at the OS layer.
  const cleaned = relative.replace(/^\.[/\\]/, "")
  return `${trimmed}${sep}${cleaned}`
}

export function MessageMarkdown(props: {
  text: string
  cacheKey?: string
  streaming?: boolean
  class?: string
}) {
  const data = useData()
  const desktop =
    typeof window !== "undefined"
      ? (window as unknown as { api?: { showItemInFolder?: (path: string) => unknown } }).api
      : undefined
  return (
    <Markdown
      text={props.text}
      cacheKey={props.cacheKey}
      streaming={props.streaming ?? false}
      class={props.class}
      onLinkRevealPath={(p) => {
        const directory = data.directory
        const absolute = isAbsoluteLikePath(p) || !directory ? p : joinWorkspacePath(directory, p)
        if (desktop?.showItemInFolder) void desktop.showItemInFolder(absolute)
      }}
    />
  )
}

export function PacedMarkdown(props: { text: string; cacheKey: string; streaming: boolean }) {
  const value = createPacedValue(
    () => props.text,
    () => props.streaming,
  )

  return (
    <Show when={value()}>
      <MessageMarkdown text={value()} cacheKey={props.cacheKey} streaming={props.streaming} />
    </Show>
  )
}

export function relativizeProjectPath(path: string, directory?: string) {
  if (!path) return ""
  if (!directory) return path
  if (directory === "/") return path
  if (directory === "\\") return path
  if (path === directory) return ""

  const separator = directory.includes("\\") ? "\\" : "/"
  const prefix = directory.endsWith(separator) ? directory : directory + separator
  if (!path.startsWith(prefix)) return path
  return path.slice(directory.length)
}

export function getDirectory(path: string | undefined) {
  const data = useData()
  return relativizeProjectPath(_getDirectory(path), data.directory)
}
