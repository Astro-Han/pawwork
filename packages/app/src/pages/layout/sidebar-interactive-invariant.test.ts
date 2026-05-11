import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"

const sidebarFiles = ["pawwork-sidebar.tsx", "sidebar-items.tsx", "sidebar-workspace.tsx"]

const interactiveIntrinsic = new Set(["a", "button", "input", "select", "summary", "textarea"])
const interactiveRoles = new Set(["button", "checkbox", "link", "menuitem", "radio", "switch", "tab", "textbox"])
const interactiveComponents = new Set(["Button", "IconButton"])
const nonInteractiveAsTargets = new Set(["div", "span", "section", "nav", "ul", "li"])

function jsxNameText(name: ts.JsxTagNameExpression): string {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isPropertyAccessExpression(name)) return `${jsxNameText(name.expression as ts.JsxTagNameExpression)}.${name.name.text}`
  if (ts.isJsxNamespacedName(name)) return `${name.namespace.text}:${name.name.text}`
  return name.getText()
}

function attr(node: ts.JsxOpeningLikeElement, name: string) {
  return node.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name,
  )
}

function attrText(node: ts.JsxOpeningLikeElement, name: string) {
  const value = attr(node, name)?.initializer
  if (!value) return undefined
  if (ts.isStringLiteral(value)) return value.text
  if (ts.isJsxExpression(value) && value.expression) {
    if (ts.isStringLiteral(value.expression)) return value.expression.text
    if (ts.isIdentifier(value.expression)) return value.expression.text
    if (ts.isPropertyAccessExpression(value.expression)) return value.expression.getText()
  }
  return undefined
}

function isInteractive(node: ts.JsxOpeningLikeElement) {
  const name = jsxNameText(node.tagName)
  if (interactiveIntrinsic.has(name)) return true
  if (interactiveComponents.has(name)) return true

  const role = attrText(node, "role")
  if (role && interactiveRoles.has(role)) return true

  if (name.endsWith(".Trigger")) {
    const asTarget = attrText(node, "as")
    if (!asTarget) return true
    if (nonInteractiveAsTargets.has(asTarget)) return false
    return true
  }

  return false
}

function lineOf(source: ts.SourceFile, node: ts.Node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

function nestedInteractiveViolations(file: string) {
  const sourceText = readFileSync(file, "utf8")
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const violations: string[] = []

  function visit(node: ts.Node, interactiveStack: string[]) {
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement
      const name = jsxNameText(opening.tagName)
      const interactive = isInteractive(opening)
      if (interactive && interactiveStack.length > 0) {
        violations.push(`${path.basename(file)}:${lineOf(source, opening)} ${interactiveStack.join(" > ")} > ${name}`)
      }
      const nextStack = interactive ? [...interactiveStack, name] : interactiveStack
      for (const child of node.children) visit(child, nextStack)
      return
    }

    if (ts.isJsxSelfClosingElement(node)) {
      const name = jsxNameText(node.tagName)
      if (isInteractive(node) && interactiveStack.length > 0) {
        violations.push(`${path.basename(file)}:${lineOf(source, node)} ${interactiveStack.join(" > ")} > ${name}`)
      }
      return
    }

    ts.forEachChild(node, (child) => visit(child, interactiveStack))
  }

  visit(source, [])
  return violations
}

describe("sidebar interactive invariant", () => {
  test("does not nest interactive controls inside sidebar source", () => {
    const violations = sidebarFiles.flatMap((file) => nestedInteractiveViolations(path.join(import.meta.dir, file)))
    expect(violations).toEqual([])
  })
})
