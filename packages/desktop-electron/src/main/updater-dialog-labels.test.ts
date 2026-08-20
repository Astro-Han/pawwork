import { describe, expect, test } from "vitest"
import { updaterDialogLabels } from "./updater-dialog-labels"

// Every field is required by the Labels type, so pinning the copy here only
// restated the table. What the type cannot say is that the Chinese table was
// actually translated: a string left in English typechecks, and so does a table
// swapped wholesale between the two locales.
function copyIn(labels: unknown): string[] {
  if (typeof labels === "string") return [labels]
  if (typeof labels === "function") return copyIn((labels as (version?: string) => string)("1.2.3"))
  if (Array.isArray(labels)) return labels.flatMap(copyIn)
  if (labels && typeof labels === "object") return Object.values(labels).flatMap(copyIn)
  return []
}

const hasChinese = (copy: string) => /[一-鿿]/.test(copy)

describe("updater dialog labels", () => {
  test("translates every label into Simplified Chinese", () => {
    expect(copyIn(updaterDialogLabels("zh")).filter((copy) => !hasChinese(copy))).toEqual([])
  })

  test("leaves no Chinese in the English labels", () => {
    expect(copyIn(updaterDialogLabels("en")).filter(hasChinese)).toEqual([])
  })

  // The one label that is computed rather than written down.
  test("names the version in the restart prompt when the updater knows it", () => {
    for (const locale of ["en", "zh"] as const) {
      const { message } = updaterDialogLabels(locale).ready
      expect(message("0.2.5")).toContain("0.2.5")
      expect(message(undefined)).not.toContain("undefined")
    }
  })
})
