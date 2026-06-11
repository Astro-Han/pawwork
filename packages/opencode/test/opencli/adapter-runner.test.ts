import { describe, expect, mock, test } from "bun:test"
import type { CliCommand } from "@jackwener/opencli/registry"
import type { IPage } from "@jackwener/opencli/types"
import {
  prepareOpenCliCommandArgs,
  runOpenCliAdapterCommand,
  shouldRunOpenCliPreNav,
} from "../../src/opencli/adapter-runner"

describe("opencli adapter runner", () => {
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
    expect(func).toHaveBeenCalledWith(page, { query: "pawwork" }, false)
  })
})
