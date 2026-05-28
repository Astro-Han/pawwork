import { $ } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
  await resetDatabase()
})

describe("VCS routes", () => {
  const measureUntrackedPatch = async (cwd: string, file: string) => {
    const text =
      await $`git diff --no-index --patch --binary --no-ext-diff --no-renames --unified=${2_147_483_647} -- /dev/null ${file}`
        .cwd(cwd)
        .nothrow()
        .text()
    return Buffer.byteLength(text)
  }

  test("documents apply failure reasons in OpenAPI", async () => {
    const spec = await Server.openapi()
    const response = spec.paths?.["/vcs/apply"]?.post?.responses?.["400"]
    if (!response || "$ref" in response) throw new Error("expected inline apply failure response")
    const schema = response.content?.["application/json"]?.schema

    expect(schema).toEqual({
      $ref: "#/components/schemas/VcsApplyFailure",
    })
    expect(spec.components?.schemas?.VcsApplyFailure).toMatchObject({
      properties: {
        error: {
          const: "vcs_apply_failed",
        },
        reason: {
          enum: ["non-git", "not-clean"],
        },
        message: {
          type: "string",
        },
      },
      required: ["error", "reason", "message"],
    })
  })

  test("documents raw diff size failures in OpenAPI", async () => {
    const spec = await Server.openapi()
    const response = spec.paths?.["/vcs/diff/raw"]?.get?.responses?.["413"]
    if (!response || "$ref" in response) throw new Error("expected inline raw diff failure response")
    const schema = response.content?.["application/json"]?.schema

    expect(schema).toEqual({
      $ref: "#/components/schemas/VcsDiffRawFailure",
    })
    expect(spec.components?.schemas?.VcsDiffRawFailure).toMatchObject({
      properties: {
        error: {
          const: "vcs_diff_raw_failed",
        },
        reason: {
          const: "too-large",
        },
        message: {
          type: "string",
        },
      },
      required: ["error", "reason", "message"],
    })
  })

  test("returns working tree status summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")
    await fs.writeFile(path.join(tmp.path, "untracked.txt"), "new\n", "utf-8")

    const response = await Server.Default().app.request("/vcs/status", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { file: "tracked.txt", additions: 1, deletions: 1, status: "modified" },
      { file: "untracked.txt", additions: 1, deletions: 0, status: "added" },
    ])
  })

  test("returns subdirectory untracked files in status summaries", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.mkdir(path.join(tmp.path, "sub"))
    await fs.writeFile(path.join(tmp.path, "sub", "untracked.txt"), "one\ntwo\n", "utf-8")

    const response = await Server.Default().app.request("/vcs/status", {
      headers: {
        "x-opencode-directory": path.join(tmp.path, "sub"),
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual([
      { file: "sub/untracked.txt", additions: 2, deletions: 0, status: "added" },
    ])
  })

  test("returns raw patch text", async () => {
    await using tmp = await tmpdir({ git: true })
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(tmp.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "tracked.txt"), "changed\n", "utf-8")

    const response = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/plain")
    expect(await response.text()).toContain("diff --git a/tracked.txt b/tracked.txt")
  })

  test("returns staged files before the first commit in raw patch text", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()
    await fs.writeFile(path.join(tmp.path, "first.txt"), "first\n", "utf-8")
    await $`git add first.txt`.cwd(tmp.path).quiet()

    const response = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": tmp.path,
      },
    })

    expect(response.status).toBe(200)
    const patch = await response.text()
    expect(patch).toContain("diff --git a/first.txt b/first.txt")
    expect(patch).toContain("+first")
  })

  test("round-trips staged then modified files before the first commit", async () => {
    await using source = await tmpdir()
    await $`git init`.cwd(source.path).quiet()
    await fs.writeFile(path.join(source.path, "first.txt"), "staged\n", "utf-8")
    await $`git add first.txt`.cwd(source.path).quiet()
    await fs.writeFile(path.join(source.path, "first.txt"), "final\n", "utf-8")

    const diff = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": source.path,
      },
    })
    expect(diff.status).toBe(200)
    const patch = await diff.text()

    await using target = await tmpdir()
    await $`git init`.cwd(target.path).quiet()
    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    await expect(fs.readFile(path.join(target.path, "first.txt"), "utf-8")).resolves.toBe("final\n")
  })

  test("round-trips subdirectory untracked files through raw diff and apply", async () => {
    await using source = await tmpdir({ git: true })
    await fs.mkdir(path.join(source.path, "sub"))
    await fs.writeFile(path.join(source.path, "sub", "untracked.txt"), "new\n", "utf-8")

    const diff = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": path.join(source.path, "sub"),
      },
    })
    expect(diff.status).toBe(200)
    const patch = await diff.text()
    expect(patch).toContain("diff --git a/sub/untracked.txt b/sub/untracked.txt")

    await using target = await tmpdir()
    await $`git init`.cwd(target.path).quiet()
    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    await expect(fs.readFile(path.join(target.path, "sub", "untracked.txt"), "utf-8")).resolves.toBe("new\n")
  })

  test("round-trips subdirectory staged then modified files before the first commit", async () => {
    await using source = await tmpdir()
    await $`git init`.cwd(source.path).quiet()
    await fs.mkdir(path.join(source.path, "sub"))
    await fs.writeFile(path.join(source.path, "sub", "first.txt"), "staged\n", "utf-8")
    await $`git add sub/first.txt`.cwd(source.path).quiet()
    await fs.writeFile(path.join(source.path, "sub", "first.txt"), "final\n", "utf-8")

    const diff = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": path.join(source.path, "sub"),
      },
    })
    expect(diff.status).toBe(200)
    const patch = await diff.text()

    await using target = await tmpdir()
    await $`git init`.cwd(target.path).quiet()
    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    await expect(fs.readFile(path.join(target.path, "sub", "first.txt"), "utf-8")).resolves.toBe("final\n")
  })

  test(
    "rejects raw tracked diffs beyond the patch budget",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await fs.writeFile(path.join(tmp.path, "large.txt"), "small\n", "utf-8")
      await $`git add large.txt`.cwd(tmp.path).quiet()
      await $`git commit --no-gpg-sign -m "add file"`.cwd(tmp.path).quiet()
      await fs.writeFile(path.join(tmp.path, "large.txt"), `${"x".repeat(10_100_000)}\n`, "utf-8")

      const response = await Server.Default().app.request("/vcs/diff/raw", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: "vcs_diff_raw_failed",
        reason: "too-large",
        message: "Raw VCS diff exceeds the 10 MB output limit",
      })
    },
    20_000,
  )

  test(
    "rejects raw untracked diffs beyond the patch budget",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await fs.writeFile(path.join(tmp.path, "large.txt"), `${"x".repeat(10_100_000)}\n`, "utf-8")

      const response = await Server.Default().app.request("/vcs/diff/raw", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: "vcs_diff_raw_failed",
        reason: "too-large",
        message: "Raw VCS diff exceeds the 10 MB output limit",
      })
    },
    20_000,
  )

  test(
    "rejects raw diffs beyond the combined patch budget",
    async () => {
      await using tmp = await tmpdir({ git: true })
      await fs.writeFile(path.join(tmp.path, "one.txt"), `${"x".repeat(5_100_000)}\n`, "utf-8")
      await fs.writeFile(path.join(tmp.path, "two.txt"), `${"y".repeat(5_100_000)}\n`, "utf-8")

      const response = await Server.Default().app.request("/vcs/diff/raw", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: "vcs_diff_raw_failed",
        reason: "too-large",
        message: "Raw VCS diff exceeds the 10 MB output limit",
      })
    },
    20_000,
  )

  test(
    "rejects raw diffs when patch separators exceed the combined budget",
    async () => {
      const maxPatchBytes = 10_000_000
      await using tmp = await tmpdir({ git: true })
      const first = "first.txt"
      const second = "second.txt"

      await fs.writeFile(path.join(tmp.path, first), "x\n", "utf-8")
      await fs.writeFile(path.join(tmp.path, second), "y\n", "utf-8")
      const firstOverhead = (await measureUntrackedPatch(tmp.path, first)) - Buffer.byteLength("x\n")
      const secondOverhead = (await measureUntrackedPatch(tmp.path, second)) - Buffer.byteLength("y\n")

      const firstPatchBytes = 5_000_000
      const firstContentBytes = firstPatchBytes - firstOverhead
      const secondContentBytes = maxPatchBytes - firstPatchBytes - secondOverhead
      await fs.writeFile(path.join(tmp.path, first), `${"x".repeat(firstContentBytes - 1)}\n`, "utf-8")
      await fs.writeFile(path.join(tmp.path, second), `${"y".repeat(secondContentBytes - 1)}\n`, "utf-8")

      expect((await measureUntrackedPatch(tmp.path, first)) + (await measureUntrackedPatch(tmp.path, second))).toBe(
        maxPatchBytes,
      )

      const response = await Server.Default().app.request("/vcs/diff/raw", {
        headers: {
          "x-opencode-directory": tmp.path,
        },
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: "vcs_diff_raw_failed",
        reason: "too-large",
        message: "Raw VCS diff exceeds the 10 MB output limit",
      })
    },
    20_000,
  )

  test("applies a patch and reports apply failures", async () => {
    await using source = await tmpdir({ git: true })
    await fs.writeFile(path.join(source.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(source.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(source.path).quiet()
    await fs.writeFile(path.join(source.path, "tracked.txt"), "changed\n", "utf-8")
    const sourcePatch = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": source.path,
      },
    })
    const patch = await sourcePatch.text()

    await using target = await tmpdir({ git: true })
    await fs.writeFile(path.join(target.path, "tracked.txt"), "original\n", "utf-8")
    await $`git add tracked.txt`.cwd(target.path).quiet()
    await $`git commit --no-gpg-sign -m "add file"`.cwd(target.path).quiet()

    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    expect(await applied.json()).toEqual({ applied: true })
    await expect(fs.readFile(path.join(target.path, "tracked.txt"), "utf-8")).resolves.toBe("changed\n")

    const failed = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(failed.status).toBe(400)
    expect(await failed.json()).toMatchObject({
      error: "vcs_apply_failed",
      reason: "not-clean",
    })
  })

  test("round-trips binary file changes through raw diff and apply", async () => {
    const original = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7])
    const changed = Buffer.from([0, 1, 2, 9, 10, 11, 12, 13])

    await using source = await tmpdir({ git: true })
    await fs.writeFile(path.join(source.path, "binary.dat"), original)
    await $`git add binary.dat`.cwd(source.path).quiet()
    await $`git commit --no-gpg-sign -m "add binary"`.cwd(source.path).quiet()
    await fs.writeFile(path.join(source.path, "binary.dat"), changed)

    const diff = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": source.path,
      },
    })
    expect(diff.status).toBe(200)
    const patch = await diff.text()
    expect(patch).toContain("GIT binary patch")

    await using target = await tmpdir({ git: true })
    await fs.writeFile(path.join(target.path, "binary.dat"), original)
    await $`git add binary.dat`.cwd(target.path).quiet()
    await $`git commit --no-gpg-sign -m "add binary"`.cwd(target.path).quiet()

    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    expect(Buffer.from(await fs.readFile(path.join(target.path, "binary.dat")))).toEqual(changed)
  })

  test("round-trips added binary files through raw diff and apply", async () => {
    const content = Buffer.from([0, 8, 16, 24, 32, 40, 48, 56])

    await using source = await tmpdir({ git: true })
    await fs.writeFile(path.join(source.path, "binary.dat"), content)

    const diff = await Server.Default().app.request("/vcs/diff/raw", {
      headers: {
        "x-opencode-directory": source.path,
      },
    })
    expect(diff.status).toBe(200)
    const patch = await diff.text()
    expect(patch).toContain("GIT binary patch")

    await using target = await tmpdir({ git: true })
    const applied = await Server.Default().app.request("/vcs/apply", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": target.path,
      },
      body: JSON.stringify({ patch }),
    })

    expect(applied.status).toBe(200)
    expect(Buffer.from(await fs.readFile(path.join(target.path, "binary.dat")))).toEqual(content)
  })
})
