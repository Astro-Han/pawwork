import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dir, "../../../../")
const expectedSmokeTests = [
  "packages/app/e2e/app/home.spec.ts:@smoke home composer shows unified single-row bar with brand orange send",
  "packages/app/e2e/app/home.spec.ts:@smoke home composer submits a slash-prefixed prompt via the fallback path",
  "packages/app/e2e/app/home.spec.ts:@smoke home hero prompt starts a session",
  "packages/app/e2e/app/home.spec.ts:@smoke home renders hero composer with updated welcome heading",
  "packages/app/e2e/app/home.spec.ts:@smoke project home status panel can open the server picker dialog",
  "packages/app/e2e/app/navigation.spec.ts:@smoke project route redirects to /session",
  "packages/app/e2e/app/root-redirect.spec.ts:@smoke root route falls back to backend project when local store is empty",
  "packages/app/e2e/app/session.spec.ts:@smoke session composer matches home structure without docktray or agent control",
  "packages/app/e2e/app/shell-frame.spec.ts:@smoke shell frame exposes stable desktop hooks",
  "packages/app/e2e/files/file-tree.spec.ts:@smoke review tab no longer renders the legacy file-tree sub-panel",
  "packages/app/e2e/model-picker-height.spec.ts:@smoke model picker height fits content, no empty bottom space",
  "packages/app/e2e/models/model-picker-thinking.spec.ts:@smoke session re-entry restores thinking variant from the last user message",
  "packages/app/e2e/models/model-picker-thinking.spec.ts:@smoke thinking option click updates variant from nested model picker",
  "packages/app/e2e/onboarding/home-suggestion-chips.spec.ts:@smoke clicking a suggestion row prefills the composer",
  "packages/app/e2e/onboarding/home-suggestion-chips.spec.ts:@smoke composer placeholder is the static home string",
  "packages/app/e2e/onboarding/home-suggestion-chips.spec.ts:@smoke home shows 3 suggestion rows for a first-time visitor",
  "packages/app/e2e/onboarding/home-suggestion-chips.spec.ts:@smoke per-row X dismisses one row and persists across reload",
  "packages/app/e2e/prompt/first-message-reply.spec.ts:@smoke first replied message in a new session renders without page errors",
  "packages/app/e2e/prompt/prompt.spec.ts:@smoke can send a prompt and receive a reply",
  "packages/app/e2e/release-notes/release-notes-toast.spec.ts:@smoke shows subtle toast when stored version is older than current",
  "packages/app/e2e/settings/settings-memory.spec.ts:@smoke memory settings exposes the raw MEMORY.md controls",
  "packages/app/e2e/settings/settings.spec.ts:@smoke PawWork settings opens as a full-pane surface, not a dialog",
  "packages/app/e2e/settings/settings.spec.ts:@smoke new installs start with the PawWork theme",
  "packages/app/e2e/settings/settings.spec.ts:@smoke settings dialog opens, switches tabs, closes",
  "packages/app/e2e/sidebar/sidebar-drag-pointer.spec.ts:@smoke real drag (pointer) round-trips Pinned ↔ All without duplicating rows",
  "packages/app/e2e/sidebar/sidebar.spec.ts:@smoke sidebar can be collapsed and expanded",
  "packages/app/e2e/terminal/terminal-init.spec.ts:@smoke terminal mounts and can create a second tab",
]

function normalizeSmokeInventoryPath(relative: string, separator = path.sep) {
  return relative.replaceAll(separator, path.posix.sep)
}

describe("e2e smoke tagging", () => {
  test("normalizes Windows smoke inventory paths", () => {
    expect(normalizeSmokeInventoryPath("packages\\app\\e2e\\settings\\settings.spec.ts", path.win32.sep)).toBe(
      "packages/app/e2e/settings/settings.spec.ts",
    )
  })

  test("uses the expected @smoke inventory without legacy smoke titles", async () => {
    const legacy: string[] = []
    const tagged: string[] = []

    for await (const file of new Bun.Glob("packages/app/e2e/**/*.spec.ts").scan({
      cwd: repoRoot,
      absolute: true,
    })) {
      const text = await fs.readFile(file, "utf8")
      const relative = normalizeSmokeInventoryPath(path.relative(repoRoot, file))

      for (const match of text.matchAll(/test(?:\.fixme)?\(\s*["']smoke\b/g)) {
        legacy.push(`${relative}:${match.index ?? 0}`)
      }

      for (const match of text.matchAll(/test(?:\.fixme)?\(\s*["']([^"']+)["']/g)) {
        const title = match[1]
        if (!title?.startsWith("@smoke ")) continue
        tagged.push(`${relative}:${title}`)
      }
    }

    expect(legacy).toEqual([])
    expect(tagged.toSorted()).toEqual(expectedSmokeTests)
  })
})
