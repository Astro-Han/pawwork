import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { ensureWorktreesIgnored } from "../../src/worktree/gitignore-guard"
import { tmpdir } from "../fixture/fixture"

describe("worktree gitignore guard", () => {
  test("creates .gitignore with .worktrees entry when missing", async () => {
    await using tmp = await tmpdir({ git: true })

    const result = await ensureWorktreesIgnored(tmp.path)

    expect(result.changed).toBe(true)
    expect(await fs.readFile(path.join(tmp.path, ".gitignore"), "utf8")).toBe(".worktrees/\n")
  })

  test("does not duplicate existing .worktrees entry", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, ".gitignore"), "node_modules\n/.worktrees/\n")
    await $`git add .gitignore && git commit -m ignore-worktrees`.cwd(tmp.path).quiet()

    const result = await ensureWorktreesIgnored(tmp.path)

    expect(result.changed).toBe(false)
    expect(await fs.readFile(path.join(tmp.path, ".gitignore"), "utf8")).toBe("node_modules\n/.worktrees/\n")
  })

  test("refuses to append when .gitignore has local changes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, ".gitignore"), "node_modules\n")
    await $`git add .gitignore && git commit -m initial-gitignore`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, ".gitignore"), "node_modules\ndist\n")

    await expect(ensureWorktreesIgnored(tmp.path)).rejects.toThrow("WorktreeGitignoreGuardError")
  })

  test("refuses to append when untracked .gitignore is hidden by git config", async () => {
    await using tmp = await tmpdir({ git: true })
    await $`git config status.showUntrackedFiles no`.cwd(tmp.path).quiet()
    await Bun.write(path.join(tmp.path, ".gitignore"), "node_modules\n")

    await expect(ensureWorktreesIgnored(tmp.path)).rejects.toThrow("WorktreeGitignoreGuardError")
  })

  test("refuses to recreate a locally deleted tracked .gitignore", async () => {
    await using tmp = await tmpdir({ git: true })
    const file = path.join(tmp.path, ".gitignore")
    await Bun.write(file, "node_modules\n")
    await $`git add .gitignore && git commit -m initial-gitignore`.cwd(tmp.path).quiet()
    await fs.unlink(file)

    await expect(ensureWorktreesIgnored(tmp.path)).rejects.toThrow("WorktreeGitignoreGuardError")
  })
})
