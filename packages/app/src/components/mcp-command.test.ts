import { test, expect, describe } from "bun:test"
import { joinCommand, splitCommand } from "./mcp-command"

describe("mcp-command split/join", () => {
  test("splits a plain command on whitespace", () => {
    expect(splitCommand("npx -y @modelcontextprotocol/server-filesystem /work")).toEqual([
      "npx",
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/work",
    ])
  })

  test("keeps a quoted argument with spaces as one token", () => {
    expect(splitCommand('node "/Users/me/My MCP/server.js"')).toEqual(["node", "/Users/me/My MCP/server.js"])
    expect(splitCommand("node '/Users/me/My MCP/server.js'")).toEqual(["node", "/Users/me/My MCP/server.js"])
  })

  test("collapses runs of whitespace and ignores leading/trailing space", () => {
    expect(splitCommand("  npx   -y   pkg  ")).toEqual(["npx", "-y", "pkg"])
  })

  test("quotes only the argv that need it", () => {
    expect(joinCommand(["npx", "-y", "pkg", "/work"])).toBe("npx -y pkg /work")
    expect(joinCommand(["node", "/Users/me/My MCP/server.js"])).toBe('node "/Users/me/My MCP/server.js"')
  })

  // The round-trip is the actual contract that fixes the edit-corruption bug:
  // whatever argv the config holds must reappear unchanged after join → split,
  // for EVERY argv — including payloads that mix both quote characters.
  test.each([
    [["npx", "-y", "@modelcontextprotocol/server-filesystem", "/work"]],
    [["node", "/Users/me/My MCP/server.js"]],
    [["cmd", "a b c", "d"]],
    [["cmd", 'has"double']],
    [["cmd", "has'single"]],
    [["cmd", "spaced 'single' arg"]],
    [["node", "-e", "console.log(\"it's ok\")"]],
    [["sh", "-c", "echo \"a 'b' c\" && ls"]],
    [["cmd", "back\\slash"]],
    [["cmd", 'esc\\"quote']],
    [["cmd", "C:\\Program Files\\app.exe"]],
    [["only-one"]],
    [["cmd", ""]],
  ])("round-trips %j", (argv) => {
    expect(splitCommand(joinCommand(argv))).toEqual(argv)
  })
})
