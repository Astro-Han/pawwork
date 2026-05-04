import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  rendererHost,
  rendererOrigin,
  rendererProtocol,
  rendererUrl,
  resolveRendererFile,
} from "./renderer-protocol"

describe("desktop renderer protocol", () => {
  test("uses a dedicated privileged origin for packaged renderer HTML", () => {
    expect(rendererProtocol).toBe("pawwork-renderer")
    expect(rendererHost).toBe("renderer")
    expect(rendererOrigin).toBe("pawwork-renderer://renderer")
    expect(rendererUrl("index.html")).toBe("pawwork-renderer://renderer/index.html")
    expect(() => rendererUrl("../main/index.html")).toThrow("Invalid renderer HTML path")
    expect(() => rendererUrl("/index.html")).toThrow("Invalid renderer HTML path")
  })

  test("resolves only files under the renderer output root", () => {
    // `resolveRendererFile` calls `path.resolve` internally, which on Windows
    // prepends the CWD's drive letter to a drive-less posix path. Run the
    // fixture root through `resolve` once so the expected and received forms
    // match on every platform.
    const root = resolve("/Applications/PawWork.app/Contents/Resources/app.asar/out/renderer")

    expect(resolveRendererFile(root, "pawwork-renderer://renderer/index.html")).toBe(join(root, "index.html"))
    expect(resolveRendererFile(root, "pawwork-renderer://renderer/assets/app.js")).toBe(
      join(root, "assets/app.js"),
    )
    expect(resolveRendererFile(root, "pawwork-renderer://renderer/..%2Fmain%2Findex.js")).toBeNull()
    expect(resolveRendererFile(root, "pawwork-renderer://renderer/..%5Cmain%5Cindex.js")).toBeNull()
    expect(resolveRendererFile(root, "pawwork-renderer://renderer/assets/")).toBeNull()
    expect(resolveRendererFile(root, "pawwork-renderer://renderer/%zz")).toBeNull()
    expect(resolveRendererFile(root, "pawwork-renderer://renderer/index.html%00.js")).toBeNull()
    expect(resolveRendererFile(root, "pawwork-renderer://renderer")).toBe(join(root, "index.html"))
    expect(resolveRendererFile(root, "not-a-valid-url")).toBeNull()
    expect(resolveRendererFile(root, "pawwork-renderer://wrong/index.html")).toBeNull()
    expect(resolveRendererFile(root, pathToFileURL(join(root, "index.html")).toString())).toBeNull()
  })
})
