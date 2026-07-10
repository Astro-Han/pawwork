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

  // A backslash inside double quotes is only an escape before `"` or `\`;
  // pasted Windows paths must keep their separators verbatim.
  test("keeps literal backslashes in a double-quoted argument", () => {
    expect(splitCommand('cmd "C:\\Program Files\\app.exe"')).toEqual(["cmd", "C:\\Program Files\\app.exe"])
    expect(splitCommand('cmd "a\\nb"')).toEqual(["cmd", "a\\nb"])
    expect(splitCommand('cmd "esc\\"quote and \\\\slash"')).toEqual(["cmd", 'esc"quote and \\slash'])
  })

  test("quotes only the argv that need it", () => {
    expect(joinCommand(["npx", "-y", "pkg", "/work"])).toBe("npx -y pkg /work")
    expect(joinCommand(["node", "/Users/me/My MCP/server.js"])).toBe('node "/Users/me/My MCP/server.js"')
  })

  // Windows paths keep single backslashes on display instead of doubling them.
  test("prefers single quotes for backslash args to avoid doubling", () => {
    expect(joinCommand(["cmd", "C:\\Program Files\\app.exe"])).toBe("cmd 'C:\\Program Files\\app.exe'")
    expect(joinCommand(["cmd", "\\\\server\\share"])).toBe("cmd '\\\\server\\share'")
    // An arg with a single quote can't use single quotes, so it stays double-quoted.
    expect(joinCommand(["cmd", "it's C:\\x"])).toBe('cmd "it\'s C:\\\\x"')
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
