import { describe, expect, test } from "bun:test"
import { classifyLayoutShiftSource } from "./runtime-cls-probe"

function elementFromHtml(html: string, selector: string) {
  const root = document.createElement("div")
  root.innerHTML = html
  const element = root.querySelector(selector)
  if (!(element instanceof HTMLElement)) throw new Error(`Missing fixture element for ${selector}`)
  return element
}

describe("runtime CLS source classifier", () => {
  test("classifies assistant-message descendants as residual even inside a message wrapper", () => {
    const source = elementFromHtml(
      `<div data-message-id="msg_1">
        <div data-component="session-turn">
          <div data-slot="session-turn-assistant-content"><p data-source>answer</p></div>
        </div>
      </div>`,
      "[data-source]",
    )

    expect(classifyLayoutShiftSource(source)).toEqual({
      kind: "residual-assistant-message",
      selector: '[data-slot="session-turn-assistant-content"]',
    })
  })

  test("keeps legacy assistant-message content-visibility sources as residual", () => {
    const source = elementFromHtml(
      `<div data-message-id="msg_1">
        <div data-component="session-turn">
          <div data-component="assistant-message"><p data-source>answer</p></div>
        </div>
      </div>`,
      "[data-source]",
    )

    expect(classifyLayoutShiftSource(source)).toEqual({
      kind: "residual-assistant-message",
      selector: '[data-component="assistant-message"]',
    })
  })

  test("classifies session-turn root as a primary target", () => {
    const source = elementFromHtml(
      `<div data-message-id="msg_1"><div data-component="session-turn"></div></div>`,
      '[data-component="session-turn"]',
    )

    expect(classifyLayoutShiftSource(source)).toEqual({
      kind: "primary-turn",
      selector: '[data-component="session-turn"]',
    })
  })

  test("classifies session-turn descendants outside assistant-message as primary", () => {
    const source = elementFromHtml(
      `<div data-message-id="msg_1">
        <div data-component="session-turn"><div data-source>turn chrome</div></div>
      </div>`,
      "[data-source]",
    )

    expect(classifyLayoutShiftSource(source)).toEqual({
      kind: "primary-turn",
      selector: '[data-component="session-turn"]',
    })
  })

  test("classifies message wrappers as primary targets", () => {
    const source = elementFromHtml(`<div data-message-id="msg_1"></div>`, "[data-message-id]")

    expect(classifyLayoutShiftSource(source)).toEqual({
      kind: "primary-message-wrapper",
      selector: "[data-message-id]",
    })
  })

  test("classifies question dock descendants outside the timeline as dock shifts", () => {
    const source = elementFromHtml(
      `<div data-component="session-prompt-dock">
        <div data-component="dock-prompt" data-kind="question"><button data-source>Continue</button></div>
      </div>`,
      "[data-source]",
    )

    expect(classifyLayoutShiftSource(source)).toEqual({
      kind: "dock-or-scroll-recovery",
      selector: '[data-component="dock-prompt"]',
    })
  })
})
