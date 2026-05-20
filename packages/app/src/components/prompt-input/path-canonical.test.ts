import { describe, expect, test } from "bun:test"
import { compactFilePath, isAbsoluteLike, isUnderDirectory, toAbsoluteFilePath } from "./path-canonical"

describe("isAbsoluteLike", () => {
  test("returns true for POSIX absolute", () => {
    expect(isAbsoluteLike("/home/user/project")).toBe(true)
  })

  test("returns true for Windows drive with forward slash", () => {
    expect(isAbsoluteLike("C:/Users/test")).toBe(true)
  })

  test("returns true for Windows drive with backslash", () => {
    expect(isAbsoluteLike("C:\\Users\\test")).toBe(true)
  })

  test("returns true for Windows drive alone (C:)", () => {
    expect(isAbsoluteLike("C:")).toBe(true)
  })

  test("returns true for UNC backslash style", () => {
    expect(isAbsoluteLike("\\\\server\\share")).toBe(true)
  })

  test("returns true for UNC forward slash style", () => {
    expect(isAbsoluteLike("//server/share")).toBe(true)
  })

  test("returns false for relative path", () => {
    expect(isAbsoluteLike("src/foo.ts")).toBe(false)
  })

  test("returns false for relative path with dot prefix", () => {
    expect(isAbsoluteLike("./src/foo.ts")).toBe(false)
  })
})

describe("toAbsoluteFilePath", () => {
  test("passes through POSIX absolute unchanged", () => {
    expect(toAbsoluteFilePath("/repo", "/home/user/file.ts")).toBe("/home/user/file.ts")
  })

  test("passes through Windows drive absolute (both slash styles) unchanged", () => {
    expect(toAbsoluteFilePath("C:\\project", "D:\\other\\file.ts")).toBe("D:\\other\\file.ts")
    expect(toAbsoluteFilePath("/repo", "C:/Users/file.ts")).toBe("C:/Users/file.ts")
  })

  test("passes through UNC unchanged", () => {
    expect(toAbsoluteFilePath("C:\\project", "\\\\server\\share\\file.ts")).toBe("\\\\server\\share\\file.ts")
    expect(toAbsoluteFilePath("/repo", "//server/share/file.ts")).toBe("//server/share/file.ts")
  })

  test("joins relative POSIX path with single separator", () => {
    expect(toAbsoluteFilePath("/repo", "src/foo.ts")).toBe("/repo/src/foo.ts")
  })

  test("joins relative path against directory with trailing slash", () => {
    expect(toAbsoluteFilePath("/repo/", "src/foo.ts")).toBe("/repo/src/foo.ts")
  })

  test("joins relative path against directory with trailing backslash", () => {
    expect(toAbsoluteFilePath("C:\\project\\", "src\\foo.ts")).toBe("C:\\project/src\\foo.ts")
  })

  test("joins Windows relative path keeps backslashes in input", () => {
    // mirrors exact behavior of current absolute() in build-request-parts.ts
    expect(toAbsoluteFilePath("D:\\workspace\\app", "src\\utils\\helper.ts")).toBe(
      "D:\\workspace\\app/src\\utils\\helper.ts",
    )
  })
})

describe("isUnderDirectory", () => {
  test("true when path is exact match", () => {
    expect(isUnderDirectory("/repo", "/repo")).toBe(true)
  })

  test("true when path inside", () => {
    expect(isUnderDirectory("/repo/src/foo.ts", "/repo")).toBe(true)
  })

  test("false when path is sibling with shared prefix segment", () => {
    // /repo-A2/file.ts should NOT be under /repo-A
    expect(isUnderDirectory("/repo-A2/file.ts", "/repo-A")).toBe(false)
  })

  test("false when paths are unrelated", () => {
    expect(isUnderDirectory("/other/file.ts", "/repo")).toBe(false)
  })

  test("case-insensitive on Windows drive root", () => {
    expect(isUnderDirectory("C:\\Project\\file.ts", "c:\\project")).toBe(true)
  })

  test("case-sensitive on POSIX root", () => {
    expect(isUnderDirectory("/Repo/file.ts", "/repo")).toBe(false)
  })

  test("true when source dir has a trailing slash", () => {
    expect(isUnderDirectory("/repo/foo", "/repo/")).toBe(true)
    expect(isUnderDirectory("/repo", "/repo/")).toBe(true)
  })

  test("true for anything under POSIX root", () => {
    expect(isUnderDirectory("/a", "/")).toBe(true)
    expect(isUnderDirectory("/", "/")).toBe(true)
  })

  test("UNC forward-slash root is recognised as case-insensitive", () => {
    expect(isUnderDirectory("//Server/Share/foo", "//server/share")).toBe(true)
  })

  test("handles backslashes in inputs by normalizing for comparison", () => {
    expect(isUnderDirectory("C:\\project\\src\\file.ts", "C:\\project")).toBe(true)
  })
})

describe("compactFilePath", () => {
  test("strips directory prefix when path is under source dir", () => {
    expect(compactFilePath("/repo/src/foo.ts", "/repo")).toBe("src/foo.ts")
  })

  test("returns last segment when path is unrelated to source dir", () => {
    expect(compactFilePath("/other/place/bar.ts", "/repo")).toBe("bar.ts")
  })

  test("returns last segment when source dir is undefined", () => {
    expect(compactFilePath("/repo/src/foo.ts")).toBe("foo.ts")
  })

  test("truncates long segment with ellipsis while preserving extension", () => {
    // "very-long-filename-here.tsx" = 26 chars, maxSegmentLen=18
    expect(compactFilePath("/repo/very-long-filename-here.tsx", undefined, 18)).toBe("very-long…here.tsx")
  })

  test("does not truncate when within maxSegmentLen", () => {
    expect(compactFilePath("/repo/short.ts", undefined, 24)).toBe("short.ts")
  })

  test("handles backslash-separated path", () => {
    expect(compactFilePath("C:\\project\\src\\component.tsx")).toBe("component.tsx")
  })

  test("falls back to directory basename when path equals source dir", () => {
    expect(compactFilePath("/repo/foo", "/repo/foo")).toBe("foo")
    expect(compactFilePath("/repo/foo/", "/repo/foo")).toBe("foo")
  })
})
