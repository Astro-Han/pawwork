import { expect, test } from "vitest"
import { documentPrompt } from "./document-analysis"

test("page actions keep the selected page and revision explicit", () => {
  expect(documentPrompt("ocr", "C:\\Work\\drawing.pdf", 2)).toContain("page 2")
  expect(documentPrompt("drawing", "C:\\Work\\drawing.pdf", 4)).toContain("technical drawing")
  expect(documentPrompt("compare", "old.pdf", 3, "new.pdf")).toContain("new.pdf")
  expect(() => documentPrompt("compare", "old.pdf", 3)).toThrow("second revision")
  expect(() => documentPrompt("ocr", "old.pdf", 0)).toThrow("Invalid PDF page")
})
