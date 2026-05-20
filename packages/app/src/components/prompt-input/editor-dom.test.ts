import { describe, expect, test } from "bun:test"
import { createTextFragment, getCursorPosition, getNodeLength, getTextLength, setCursorPosition } from "./editor-dom"

describe("prompt-input editor dom", () => {
  test("createTextFragment preserves newlines with consecutive br nodes", () => {
    const fragment = createTextFragment("foo\n\nbar")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(4)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
    expect((container.childNodes[2] as HTMLElement).tagName).toBe("BR")
    expect(container.childNodes[3]?.textContent).toBe("bar")
  })

  test("createTextFragment keeps trailing newline as terminal break", () => {
    const fragment = createTextFragment("foo\n")
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe("foo")
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("createTextFragment avoids break-node explosion for large multiline content", () => {
    const content = Array.from({ length: 220 }, () => "line").join("\n")
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(1)
    expect(container.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE)
    expect(container.textContent).toBe(content)
  })

  test("createTextFragment keeps terminal break in large multiline fallback", () => {
    const content = `${Array.from({ length: 220 }, () => "line").join("\n")}\n`
    const fragment = createTextFragment(content)
    const container = document.createElement("div")
    container.appendChild(fragment)

    expect(container.childNodes.length).toBe(2)
    expect(container.childNodes[0]?.textContent).toBe(content.slice(0, -1))
    expect((container.childNodes[1] as HTMLElement).tagName).toBe("BR")
  })

  test("length helpers treat breaks as one char and ignore zero-width chars", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("ab\u200B"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))

    expect(getNodeLength(container.childNodes[0]!)).toBe(2)
    expect(getNodeLength(container.childNodes[1]!)).toBe(1)
    expect(getTextLength(container)).toBe(5)
  })

  test("setCursorPosition and getCursorPosition round-trip with pills and breaks", () => {
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.type = "file"
    pill.textContent = "@file"
    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 7)
    expect(getCursorPosition(container)).toBe(7)

    setCursorPosition(container, 8)
    expect(getCursorPosition(container)).toBe(8)

    container.remove()
  })

  test("setCursorPosition and getCursorPosition round-trip across blank lines", () => {
    const container = document.createElement("div")
    container.appendChild(document.createTextNode("a"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createElement("br"))
    container.appendChild(document.createTextNode("b"))
    document.body.appendChild(container)

    setCursorPosition(container, 2)
    expect(getCursorPosition(container)).toBe(2)

    setCursorPosition(container, 3)
    expect(getCursorPosition(container)).toBe(3)

    container.remove()
  })

  test("getNodeLength returns 1 + name.length for a cmd-mark pill", () => {
    // A slash-command pill has data-cmd-mark="true" and textContent equal to the command name.
    // Logical length is 1 (for the slash trigger) + name.length, which is asymmetric to textContent.
    const pill = document.createElement("span")
    pill.dataset.cmdMark = "true"
    pill.dataset.name = "summarize"
    pill.textContent = "summarize"

    expect(getNodeLength(pill)).toBe(1 + "summarize".length) // 10
  })

  test("getNodeLength cmd-mark branch fires BEFORE textContent fallback", () => {
    // If the textContent fallback ran first it would return 9, not 10.
    const pill = document.createElement("span")
    pill.dataset.cmdMark = "true"
    pill.dataset.name = "run"
    pill.textContent = "run"

    expect(getNodeLength(pill)).toBe(4) // 1 + 3
    expect(pill.textContent!.length).toBe(3) // confirm asymmetry
  })

  test("setCursorPosition treats cmd-mark pill as a pill (cursor snaps around it)", () => {
    // Layout: "ab" + [/go] + "cd"
    // Logical offsets: a=0,b=1, pill occupies [2,4) (length 1+2=3? — "/go" name is "go" length 2 so 1+2=3)
    // position 2 → before pill, position 4 (after pill) → after pill
    const container = document.createElement("div")
    const pill = document.createElement("span")
    pill.dataset.cmdMark = "true"
    pill.dataset.name = "go"
    pill.textContent = "go"

    container.appendChild(document.createTextNode("ab"))
    container.appendChild(pill)
    container.appendChild(document.createTextNode("cd"))
    document.body.appendChild(container)

    // Position 2 = just before the cmd-mark pill → cursor before pill node
    setCursorPosition(container, 2)
    const sel2 = window.getSelection()!
    // The range should be positioned before the pill (startContainer is parent, offset = pill index)
    expect(sel2.rangeCount).toBe(1)

    // Position 5 (2 + 3) = just after the cmd-mark pill → cursor after pill node
    setCursorPosition(container, 5)
    const sel5 = window.getSelection()!
    expect(sel5.rangeCount).toBe(1)

    container.remove()
  })
})
