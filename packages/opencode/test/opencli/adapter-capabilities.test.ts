import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "bun:test"
import ts from "typescript"
import { BLOCKED_OPENCLI_COMMANDS, type OpenCliManifestEntry } from "../../src/opencli/adapter-registry"

type CapabilityGap = {
  command: string
  modulePath: string
  kind: "browser-page-import" | "page-method"
  value: string
}

const SUPPORTED_PAGE_METHODS = new Set([
  "annotatedScreenshot",
  "autoScroll",
  "cdp",
  "click",
  "consoleMessages",
  "dblClick",
  "drag",
  "evaluate",
  "evaluateWithArgs",
  "fetchJson",
  "fillText",
  "focus",
  "getCookies",
  "getCurrentUrl",
  "getFormState",
  "getInterceptedRequests",
  "goto",
  "handleJavaScriptDialog",
  "hover",
  "insertText",
  "installInterceptor",
  "nativeClick",
  "nativeKeyPress",
  "nativeType",
  "networkRequests",
  "pressKey",
  "readNetworkCapture",
  "screenshot",
  "scroll",
  "scrollTo",
  "selectTab",
  "setChecked",
  "setFileInput",
  "snapshot",
  "startNetworkCapture",
  "tabs",
  "typeText",
  "uploadFiles",
  "wait",
  "waitForCapture",
  "waitForTimeout",
])

const ACCEPTED_CAPABILITY_GAPS: CapabilityGap[] = [
  {
    command: "instagram/post",
    modulePath: "instagram/post.js",
    kind: "page-method",
    value: "closeWindow",
  },
  {
    command: "instagram/reel",
    modulePath: "instagram/reel.js",
    kind: "browser-page-import",
    value: "@jackwener/opencli/browser/page",
  },
]

function openCliPackageRoot() {
  const cdp = fileURLToPath(import.meta.resolve("@jackwener/opencli/browser/cdp"))
  return path.resolve(path.dirname(cdp), "../../..")
}

async function loadManifest() {
  const manifestPath = path.join(openCliPackageRoot(), "cli-manifest.json")
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as OpenCliManifestEntry[]
  return parsed.filter((entry) => entry.type === "js" && typeof entry.modulePath === "string")
}

function isPageLikeReceiver(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return node.text === "page" || node.text === "activePage"
  return ts.isPropertyAccessExpression(node) && node.name.text === "page"
}

function moduleImportsBrowserPage(source: ts.SourceFile) {
  let importsBrowserPage = false
  function visit(node: ts.Node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "@jackwener/opencli/browser/page"
    ) {
      importsBrowserPage = true
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "@jackwener/opencli/browser/page"
    ) {
      importsBrowserPage = true
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return importsBrowserPage
}

function pageMethodCalls(source: ts.SourceFile) {
  const methods = new Set<string>()
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      isPageLikeReceiver(node.expression.expression)
    ) {
      methods.add(node.expression.name.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return methods
}

async function scanCapabilities(): Promise<CapabilityGap[]> {
  const root = openCliPackageRoot()
  const commandsByModule = new Map<string, string[]>()
  for (const entry of await loadManifest()) {
    const command = `${entry.site}/${entry.name}`
    const commands = commandsByModule.get(entry.modulePath) ?? []
    commands.push(command)
    commandsByModule.set(entry.modulePath, commands)
  }

  const gaps: CapabilityGap[] = []
  for (const [modulePath, commands] of commandsByModule) {
    const sourcePath = path.join(root, "clis", modulePath)
    const sourceText = await fs.readFile(sourcePath, "utf8")
    const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    if (moduleImportsBrowserPage(source)) {
      for (const command of commands) {
        gaps.push({
          command,
          modulePath,
          kind: "browser-page-import",
          value: "@jackwener/opencli/browser/page",
        })
      }
    }
    for (const method of pageMethodCalls(source)) {
      if (SUPPORTED_PAGE_METHODS.has(method)) continue
      for (const command of commands) {
        gaps.push({ command, modulePath, kind: "page-method", value: method })
      }
    }
  }
  return gaps.sort((a, b) =>
    a.command.localeCompare(b.command) || a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
  )
}

describe("opencli adapter capability guard", () => {
  test("keeps unsupported page methods and daemon Page imports pinned to an explicit baseline", async () => {
    const gaps = await scanCapabilities()

    expect(gaps).toEqual(ACCEPTED_CAPABILITY_GAPS)
    expect(gaps.filter((gap) => gap.kind === "browser-page-import").map((gap) => gap.command)).toEqual(
      [...BLOCKED_OPENCLI_COMMANDS],
    )
  })
})
