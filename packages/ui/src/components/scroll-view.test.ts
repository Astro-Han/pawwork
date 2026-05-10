import { describe, expect, test } from "bun:test"
import { scrollKey, scrollViewKeyboardIntent, scrollViewMetrics } from "./scroll-view"

describe("scrollKey", () => {
  test("maps plain navigation keys", () => {
    expect(scrollKey({ key: "PageDown", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe(
      "page-down",
    )
    expect(scrollKey({ key: "ArrowUp", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false })).toBe("up")
  })

  test("ignores modified keybinds", () => {
    expect(
      scrollKey({ key: "ArrowDown", altKey: false, ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toBeUndefined()
    expect(scrollKey({ key: "PageUp", altKey: false, ctrlKey: true, metaKey: false, shiftKey: false })).toBeUndefined()
    expect(scrollKey({ key: "End", altKey: false, ctrlKey: false, metaKey: false, shiftKey: true })).toBeUndefined()
  })
})

describe("scrollViewKeyboardIntent", () => {
  test("reports the key before ScrollView performs mechanical scrolling", () => {
    expect(scrollViewKeyboardIntent({ key: "Home", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }))
      .toEqual({
        type: "keyboard_scroll",
        key: "Home",
      })
    expect(
      scrollViewKeyboardIntent({ key: "ArrowDown", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }),
    ).toEqual({
      type: "keyboard_scroll",
      key: "ArrowDown",
    })
  })

  test("does not report modified navigation keys", () => {
    expect(
      scrollViewKeyboardIntent({ key: "Home", altKey: false, ctrlKey: false, metaKey: true, shiftKey: false }),
    ).toBeUndefined()
  })
})

describe("scrollViewMetrics", () => {
  test("captures viewport metrics for scrollbar drag intents", () => {
    const viewport = {
      scrollTop: 120,
      scrollHeight: 900,
      clientHeight: 400,
    } as HTMLElement

    expect(scrollViewMetrics(viewport)).toEqual({
      scrollTop: 120,
      scrollHeight: 900,
      clientHeight: 400,
    })
  })
})
