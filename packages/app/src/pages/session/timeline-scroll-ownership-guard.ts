import { lstat, readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import ts from "typescript"

export type TimelineScrollOwnershipAllowlistEntry = {
  filePath: string
  symbol: string
  reason: string
  owner: string
  removal: string
}

export type TimelineScrollOwnershipViolation = {
  filePath: string
  symbol: string
  line: number
  column: number
  reason: string
  snippet: string
}

type ScanTextInput = {
  filePath: string
  sourceText: string
  allowlist?: TimelineScrollOwnershipAllowlistEntry[]
}

type ScanInput = {
  files?: string[]
  roots: string[]
  allowlist?: TimelineScrollOwnershipAllowlistEntry[]
  exclude?: RegExp[]
  include?: RegExp[]
  rootLabel?: string
}

const forbiddenPropertyCalls = new Set(["scrollTo", "scrollIntoView", "scrollToIndex"])
const forbiddenImportedHelpers = new Set([
  "forceScrollToBottom",
  "revealTimelineRow",
  "scrollTimelineViewport",
  "scrollToTimelineViewport",
  "scrollVirtualTimelineRow",
])

const assignmentOperators = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
])

function lineSnippet(sourceText: string, line: number) {
  return sourceText.split(/\r?\n/)[line - 1]?.trim() ?? ""
}

function location(source: ts.SourceFile, node: ts.Node) {
  const pos = source.getLineAndCharacterOfPosition(node.getStart(source))
  return { line: pos.line + 1, column: pos.character + 1 }
}

function nearestSymbol(node: ts.Node) {
  let current: ts.Node | undefined = node
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current)) && current.name)
      return current.name.text
    if (ts.isMethodDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) return current.name.text
    current = current.parent
  }
  return "<module>"
}

function isAllowed(filePath: string, symbol: string, allowlist: TimelineScrollOwnershipAllowlistEntry[]) {
  return allowlist.some((entry) => entry.filePath === filePath && entry.symbol === symbol)
}

function propertyName(node: ts.Expression) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text
  if (ts.isElementAccessExpression(node)) {
    const argument = node.argumentExpression
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) return argument.text
  }
  return undefined
}

function isScrollTopMutation(node: ts.Node) {
  if (ts.isBinaryExpression(node) && assignmentOperators.has(node.operatorToken.kind)) {
    return propertyName(node.left) === "scrollTop"
  }
  if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
    const operator = node.operator
    return (
      (operator === ts.SyntaxKind.PlusPlusToken || operator === ts.SyntaxKind.MinusMinusToken) &&
      propertyName(node.operand) === "scrollTop"
    )
  }
  return false
}

function isDomScrollCall(node: ts.CallExpression, prop: string | undefined) {
  if (prop !== "scroll") return false
  if (node.arguments.length >= 2) return true
  const [firstArgument] = node.arguments
  if (!firstArgument) return false
  if (ts.isNumericLiteral(firstArgument)) return true
  if (!ts.isObjectLiteralExpression(firstArgument)) return false
  return firstArgument.properties.some((property) => {
    if (ts.isShorthandPropertyAssignment(property)) return property.name.text === "top" || property.name.text === "left"
    if (ts.isSpreadAssignment(property)) return true
    if (!ts.isPropertyAssignment(property)) return false
    const name = property.name
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text === "top" || name.text === "left"
    return false
  })
}

function isTimelineScrollCommandSinkCall(node: ts.CallExpression, sinkIdentifiers: ReadonlySet<string>) {
  if (!ts.isPropertyAccessExpression(node.expression)) return false
  const method = node.expression.name.text
  if (method !== "scrollTo" && method !== "setScrollTop") return false
  const receiver = node.expression.expression
  if (ts.isIdentifier(receiver)) return sinkIdentifiers.has(receiver.text)
  if (ts.isPropertyAccessExpression(receiver)) return receiver.name.text === "scrollCommandSink"
  if (ts.isElementAccessExpression(receiver)) {
    const argument = receiver.argumentExpression
    if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
      return argument.text === "scrollCommandSink"
    }
  }
  if (ts.isCallExpression(receiver) && ts.isIdentifier(receiver.expression)) {
    return receiver.expression.text === "scrollCommandSink"
  }
  return false
}

export function scanTimelineScrollOwnershipText(input: ScanTextInput) {
  const source = ts.createSourceFile(input.filePath, input.sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const allowlist = input.allowlist ?? []
  const forbiddenIdentifiers = new Set<string>()
  const sinkIdentifiers = new Set<string>()
  const violations: TimelineScrollOwnershipViolation[] = []

  const addViolation = (node: ts.Node, reason: string) => {
    const symbol = nearestSymbol(node)
    if (isAllowed(input.filePath, symbol, allowlist)) return
    const pos = location(source, node)
    violations.push({
      filePath: input.filePath,
      symbol,
      line: pos.line,
      column: pos.column,
      reason,
      snippet: lineSnippet(input.sourceText, pos.line),
    })
  }

  const visit = (node: ts.Node) => {
    if (ts.isImportSpecifier(node)) {
      const local = node.name.text
      const imported = node.propertyName?.text ?? local
      if (forbiddenImportedHelpers.has(imported)) forbiddenIdentifiers.add(local)
    }

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (
        ts.isCallExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression) &&
        node.initializer.expression.text === "createTimelineScrollCommandSink"
      ) {
        sinkIdentifiers.add(node.name.text)
      }
      const prop = propertyName(node.initializer)
      if (prop && forbiddenPropertyCalls.has(prop)) forbiddenIdentifiers.add(node.name.text)
      if (ts.isIdentifier(node.initializer) && forbiddenIdentifiers.has(node.initializer.text)) {
        forbiddenIdentifiers.add(node.name.text)
      }
    }

    if (isScrollTopMutation(node)) {
      addViolation(node, "direct scrollTop write bypasses TimelineScrollCommandSink")
    }

    if (ts.isCallExpression(node)) {
      if (isTimelineScrollCommandSinkCall(node, sinkIdentifiers)) {
        ts.forEachChild(node, visit)
        return
      }
      const prop = propertyName(node.expression)
      if (isDomScrollCall(node, prop)) {
        addViolation(node, "direct scroll call bypasses TimelineScrollCommandSink")
      } else if (prop && forbiddenPropertyCalls.has(prop)) {
        addViolation(node, `direct ${prop} call bypasses TimelineScrollCommandSink`)
      } else if (ts.isIdentifier(node.expression) && forbiddenIdentifiers.has(node.expression.text)) {
        addViolation(node, `indirect ${node.expression.text} call bypasses TimelineScrollCommandSink`)
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)
  return { violations }
}

async function listFiles(root: string, input: Required<Pick<ScanInput, "exclude" | "include">>) {
  const out: string[] = []
  const walk = async (dir: string) => {
    const stat = await lstat(dir)
    if (!stat.isDirectory()) {
      if (input.include.some((pattern) => pattern.test(dir)) && !input.exclude.some((pattern) => pattern.test(dir))) {
        out.push(dir)
      }
      return
    }
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!input.include.some((pattern) => pattern.test(path))) continue
      if (input.exclude.some((pattern) => pattern.test(path))) continue
      out.push(path)
    }
  }
  await walk(root)
  return out
}

export async function scanTimelineScrollOwnership(input: ScanInput) {
  const violations: TimelineScrollOwnershipViolation[] = []
  const include = input.include ?? [/\.tsx?$/]
  const exclude = input.exclude ?? []
  for (const root of input.roots) {
    const files = input.files?.length
      ? input.files.map((file) => join(root, file))
      : await listFiles(root, { include, exclude })
    for (const file of files) {
      const filePath = input.rootLabel ? join(input.rootLabel, relative(root, file)) : file
      const sourceText = await readFile(file, "utf8")
      violations.push(
        ...scanTimelineScrollOwnershipText({
          filePath,
          sourceText,
          allowlist: input.allowlist,
        }).violations,
      )
    }
  }
  return { violations }
}
