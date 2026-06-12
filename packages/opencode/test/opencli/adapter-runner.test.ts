import { describe, expect, mock, test } from "bun:test"
import type { CliCommand } from "@jackwener/opencli/registry"
import type { IPage } from "@jackwener/opencli/types"
import {
  AdapterRunner,
  createOpenCliAdapterPage,
  prepareOpenCliCommandArgs,
  runOpenCliAdapterCommand,
  shouldRunOpenCliPreNav,
} from "../../src/opencli/adapter-runner"

function testUrl(path: string, origin = "https://example.com") {
  return new URL(path, origin).href
}

function hasExactUrlPattern(patterns: readonly string[], expected: string) {
  return patterns.some((pattern) => {
    try {
      return new URL(pattern).href === expected
    } catch {
      return false
    }
  })
}

describe("opencli adapter runner", () => {
  test("exposes the module namespace export", () => {
    expect(AdapterRunner.runOpenCliAdapterCommand).toBe(runOpenCliAdapterCommand)
  })

  test("prepares args with defaults, type coercion, choices, and validateArgs", () => {
    const command = {
      site: "demo",
      name: "search",
      access: "read",
      description: "demo",
      browser: false,
      args: [
        { name: "query", required: true },
        { name: "limit", type: "int", default: 20 },
        { name: "draft", type: "boolean", default: false },
        { name: "sort", choices: ["relevance", "date"], default: "relevance" },
      ],
      validateArgs: (args) => {
        if (args.query === "bad") throw new Error("bad query")
      },
      func: async (args) => args,
    } satisfies CliCommand

    expect(prepareOpenCliCommandArgs(command, { query: "pawwork", limit: "5", draft: "true" })).toEqual({
      query: "pawwork",
      limit: 5,
      draft: true,
      sort: "relevance",
    })
    expect(() => prepareOpenCliCommandArgs(command, { query: "pawwork", sort: "hot" })).toThrow(
      'Argument "sort" must be one of',
    )
    expect(() => prepareOpenCliCommandArgs(command, { query: "pawwork", limit: "" })).toThrow(
      'Argument "limit" must be a valid number',
    )
    expect(() => prepareOpenCliCommandArgs(command, { query: "bad" })).toThrow("bad query")
  })

  test("routes non-browser commands without a page", async () => {
    const func = mock(async (args: Record<string, unknown>) => [{ ok: args.query }])
    const command = {
      site: "demo",
      name: "http",
      access: "read",
      description: "demo",
      browser: false,
      args: [{ name: "query", required: true }],
      func,
    } satisfies CliCommand

    await expect(runOpenCliAdapterCommand(command, null, { query: "pawwork" })).resolves.toEqual([
      { ok: "pawwork" },
    ])
    expect(func).toHaveBeenCalledWith({ query: "pawwork" }, false)
  })

  test("pre-navigates browser commands before passing the visible page to the adapter", async () => {
    const page = {
      goto: mock(async () => {}),
      getCurrentUrl: mock(async () => "about:blank"),
    }
    const typedPage = page as unknown as IPage
    const func = mock(async (_page: unknown, args: Record<string, unknown>) => ({ ok: args.query }))
    const command = {
      site: "demo",
      name: "browser",
      access: "read",
      description: "demo",
      browser: true,
      domain: "example.com",
      navigateBefore: "https://example.com",
      args: [{ name: "query", required: true }],
      func,
    } satisfies CliCommand

    expect(await shouldRunOpenCliPreNav(command, typedPage, "ephemeral", "https://example.com")).toBe(true)
    await expect(runOpenCliAdapterCommand(command, typedPage, { query: "pawwork" })).resolves.toEqual({
      ok: "pawwork",
    })
    expect(page.goto).toHaveBeenCalledWith("https://example.com")
    expect(func.mock.calls[0]?.[0]).not.toBe(page)
    expect(func).toHaveBeenCalledWith(expect.objectContaining({ goto: expect.any(Function) }), { query: "pawwork" }, false)
  })

  test("asks browser permission before adapter-initiated navigation", async () => {
    const adminUsersUrl = testUrl("/admin/users")
    const page = {
      goto: mock(async () => {}),
      getCurrentUrl: mock(async () => "https://example.com/start"),
    }
    const command = {
      site: "demo",
      name: "nav",
      access: "read",
      description: "demo",
      browser: true,
      args: [],
      func: async (adapterPage: IPage) => {
        await adapterPage.goto(adminUsersUrl)
        return "done"
      },
    } satisfies CliCommand
    const asked: string[][] = []

    await expect(
      runOpenCliAdapterCommand(command, page as unknown as IPage, {}, {
        askBrowserPermission: async (patterns) => {
          asked.push(patterns)
          if (hasExactUrlPattern(patterns, adminUsersUrl)) throw new Error("denied admin")
        },
      }),
    ).rejects.toThrow("denied admin")

    expect(page.goto).not.toHaveBeenCalledWith(adminUsersUrl)
    expect(asked).toContainEqual([adminUsersUrl])
  })

  test("rechecks browser permission after adapter actions that can move the page", async () => {
    const adminUsersUrl = testUrl("/admin/users")
    let currentUrl = "https://example.com/safe"
    const page = {
      click: mock(async () => {
        currentUrl = adminUsersUrl
        return { matches_n: 1, match_level: "exact" as const }
      }),
      getCurrentUrl: mock(async () => currentUrl),
      goto: mock(async () => {}),
    }
    const command = {
      site: "demo",
      name: "click",
      access: "write",
      description: "demo",
      browser: true,
      args: [],
      func: async (adapterPage: IPage) => {
        await adapterPage.click("button")
        return "done"
      },
    } satisfies CliCommand

    await expect(
      runOpenCliAdapterCommand(command, page as unknown as IPage, {}, {
        askBrowserPermission: async (patterns) => {
          if (hasExactUrlPattern(patterns, adminUsersUrl)) throw new Error("denied admin")
        },
      }),
    ).rejects.toThrow("denied admin")

    expect(page.click).toHaveBeenCalled()
  })

  test("asks browser permission before adapter file uploads touch CDP", async () => {
    const adminUploadUrl = testUrl("/admin/upload")
    const cdp = mock(async () => ({}))
    const page = {
      cdp,
      getCurrentUrl: mock(async () => adminUploadUrl),
      goto: mock(async () => {}),
      wait: mock(async () => {}),
    }
    const command = {
      site: "demo",
      name: "upload",
      access: "write",
      description: "demo",
      browser: true,
      args: [],
      func: async (adapterPage: IPage) => {
        await adapterPage.setFileInput?.(["/tmp/file.txt"])
        return "done"
      },
    } satisfies CliCommand

    await expect(
      runOpenCliAdapterCommand(command, page as unknown as IPage, {}, {
        askBrowserPermission: async (patterns) => {
          if (hasExactUrlPattern(patterns, adminUploadUrl)) throw new Error("denied admin")
        },
      }),
    ).rejects.toThrow("denied admin")

    expect(cdp).not.toHaveBeenCalled()
  })

  test("resets ephemeral browser commands after execution", async () => {
    const page = {
      goto: mock(async () => {}),
      getCurrentUrl: mock(async () => "https://example.com/session"),
    }
    const command = {
      site: "demo",
      name: "ephemeral",
      access: "read",
      description: "demo",
      browser: true,
      args: [],
      func: async () => "done",
    } satisfies CliCommand

    await expect(runOpenCliAdapterCommand(command, page as unknown as IPage, {})).resolves.toBe("done")

    expect(page.goto).toHaveBeenCalledWith("about:blank")
  })

  test("keeps persistent browser commands on their page after execution", async () => {
    const page = {
      goto: mock(async () => {}),
      getCurrentUrl: mock(async () => "https://example.com/session"),
    }
    const command = {
      site: "demo",
      name: "persistent",
      access: "read",
      description: "demo",
      browser: true,
      siteSession: "persistent",
      args: [],
      func: async () => "done",
    } satisfies CliCommand

    await expect(runOpenCliAdapterCommand(command, page as unknown as IPage, {})).resolves.toBe("done")

    expect(page.goto).not.toHaveBeenCalled()
  })

  test("only skips persistent root pre-navigation on the same origin", async () => {
    const command = {
      site: "demo",
      name: "persistent",
      access: "read",
      description: "demo",
      browser: true,
      domain: "example.com",
      navigateBefore: "https://example.com",
      siteSession: "persistent",
      args: [],
      func: async () => [],
    } satisfies CliCommand

    async function shouldRun(currentUrl: string) {
      const page = { getCurrentUrl: mock(async () => currentUrl) } as unknown as IPage
      return await shouldRunOpenCliPreNav(command, page, "persistent", "https://example.com")
    }

    expect(await shouldRun("https://example.com/dashboard")).toBe(false)
    expect(await shouldRun("https://admin.example.com/dashboard")).toBe(true)
    expect(await shouldRun("http://example.com/dashboard")).toBe(true)
  })

  test("adds CDP-backed upload and native text helpers when the visible page only exposes cdp", async () => {
    const cdp = mock(async (method: string) => {
      if (method === "DOM.getDocument") return { root: { nodeId: 1 } }
      if (method === "DOM.querySelector") return { nodeId: 7 }
      return {}
    })
    const page = {
      cdp,
      wait: mock(async () => {}),
      goto: mock(async () => {}),
      getCurrentUrl: mock(async () => "about:blank"),
    } as unknown as IPage
    const command = {
      site: "demo",
      name: "upload",
      access: "write",
      description: "demo",
      browser: true,
      args: [],
      func: async () => undefined,
    } satisfies CliCommand

    const adapted = createOpenCliAdapterPage(command, page)
    await adapted.setFileInput?.(["/tmp/pawwork.txt"], "input[type='file']")
    await adapted.insertText?.("hello")
    await (adapted as IPage & { nativeType?: (text: string) => Promise<void> }).nativeType?.("native")
    await (adapted as IPage & { nativeClick?: (x: number, y: number) => Promise<void> }).nativeClick?.(10, 20)
    await (adapted as IPage & { waitForTimeout?: (ms: number) => Promise<void> }).waitForTimeout?.(5000)

    expect(cdp).toHaveBeenCalledWith("DOM.enable", {})
    expect(cdp).toHaveBeenCalledWith("DOM.getDocument", {})
    expect(cdp).toHaveBeenCalledWith("DOM.querySelector", { nodeId: 1, selector: "input[type='file']" })
    expect(cdp).toHaveBeenCalledWith("DOM.setFileInputFiles", { files: ["/tmp/pawwork.txt"], nodeId: 7 })
    expect(cdp).toHaveBeenCalledWith("Input.insertText", { text: "hello" })
    expect(cdp).toHaveBeenCalledWith("Input.insertText", { text: "native" })
    expect(cdp).toHaveBeenCalledWith("Input.dispatchMouseEvent", { type: "mouseMoved", x: 10, y: 20 })
    expect(cdp).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    })
    expect(cdp).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 10,
      y: 20,
      button: "left",
      clickCount: 1,
    })
    expect(page.wait).toHaveBeenCalledWith(5)
  })

  test("does not synthesize optional network capture methods when unsupported", () => {
    const page = {
      goto: mock(async () => {}),
      getCurrentUrl: mock(async () => "about:blank"),
    } as unknown as IPage
    const command = {
      site: "demo",
      name: "read",
      access: "read",
      description: "demo",
      browser: true,
      args: [],
      func: async () => undefined,
    } satisfies CliCommand

    const adapted = createOpenCliAdapterPage(command, page)

    expect(adapted.startNetworkCapture).toBeUndefined()
    expect(adapted.readNetworkCapture).toBeUndefined()
  })
})
