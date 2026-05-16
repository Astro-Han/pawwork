/**
 * #642 PR2 dead typography-token guard.
 *
 * Locks the migration by scanning the source tree for the old typography
 * custom properties and the Tailwind utility classes they used to emit.
 */

import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

const UI_ROOT = join(import.meta.dirname, "..")
const REPO_ROOT = join(UI_ROOT, "..", "..")
const THEME_CSS = readFileSync(join(UI_ROOT, "src/styles/theme.css"), "utf-8")
const SEARCH_ROOTS = ["packages", "docs/design/preview"].filter((path) =>
  existsSync(join(REPO_ROOT, path)),
)

const BANNED_CUSTOM_PROPERTIES = [
  "--type-display",
  "--type-h1",
  "--type-h2",
  "--type-h3",
  "--type-body",
  "--type-caption",
  "--type-mono",
  "--type-mono-small",
  "--type-kbd",
  "--font-size-x-small",
  "--font-size-small",
  "--font-size-base",
  "--font-size-hierarchy",
  "--font-size-large",
  "--font-size-x-large",
  "--font-size-2x-large",
  "--font-weight-regular",
  "--font-weight-medium",
  "--line-height-normal",
  "--line-height-large",
  "--line-height-x-large",
  "--line-height-2x-large",
  "--letter-spacing-normal",
  "--letter-spacing-tight",
  "--letter-spacing-tightest",
  "--text-sm",
  "--text-base",
  "--text-lg",
  "--text-xl",
  "--leading-lg",
  "--leading-xl",
  "--leading-2xl",
  "--tracking-normal",
  "--tracking-tight",
  "--tracking-tightest",
]

const BANNED_UTILITY_CLASSES = [
  "text-sm",
  "text-base",
  "text-lg",
  "text-xl",
  "font-regular",
  "font-medium",
  "leading-lg",
  "leading-xl",
  "leading-2xl",
  "tracking-normal",
  "tracking-tight",
  "tracking-tightest",
  "text-12-regular",
  "text-12-medium",
  "text-12-mono",
  "text-13-regular",
  "text-13-medium",
  "text-13-mono",
  "text-14-regular",
  "text-14-medium",
  "text-14-mono",
  "text-16-regular",
  "text-16-medium",
  "text-20-medium",
  "text-28-regular",
]

const REQUIRED_CUSTOM_PROPERTIES = [
  "--font-family-sans",
  "--font-family-mono",
  "--font-size-display",
  "--font-size-h1",
  "--font-size-h2",
  "--font-size-h3",
  "--font-size-body",
  "--font-size-caption",
  "--font-size-mono",
  "--font-size-mono-small",
  "--font-size-kbd",
  "--font-weight-display",
  "--font-weight-h1",
  "--font-weight-h2",
  "--font-weight-h3",
  "--font-weight-body",
  "--font-weight-caption",
  "--font-weight-mono",
  "--font-weight-mono-small",
  "--font-weight-kbd",
  "--line-height-display",
  "--line-height-h1",
  "--line-height-h2",
  "--line-height-h3",
  "--line-height-body",
  "--line-height-caption",
  "--line-height-mono",
  "--line-height-mono-small",
  "--line-height-kbd",
  "--letter-spacing-display",
  "--letter-spacing-h1",
]

function expectNoRgMatches(patterns: string[], extraGlobs: string[] = []) {
  const args = [
    "--pcre2",
    "-n",
    "--color=never",
    ...patterns.flatMap((pattern) => ["-e", pattern]),
    "-g",
    "!packages/ui/test/no-dead-tokens.test.ts",
    ...extraGlobs.flatMap((glob) => ["-g", glob]),
    ...SEARCH_ROOTS,
  ]
  const result = spawnSync("rg", args, { cwd: REPO_ROOT, encoding: "utf8" })
  if (result.error) throw result.error
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n")

  expect(result.status, output).toBe(1)
}

describe("#642 PR2 no dead typography tokens", () => {
  test("old custom-property names are absent from source", () => {
    expectNoRgMatches(BANNED_CUSTOM_PROPERTIES.map((token) => `${token}\\b`), [
      "!packages/ui/scripts/**",
    ])
  })

  test("old typography utility classes are absent from class-bearing source", () => {
    expectNoRgMatches(
      BANNED_UTILITY_CLASSES.map((className) => `\\b${className}\\b`),
      [
        "!packages/ui/src/theme/**",
        "!packages/ui/scripts/**",
        "!packages/ui/src/assets/**",
      ],
    )
  })

  test("new role typography tokens remain declared in theme.css", () => {
    for (const token of REQUIRED_CUSTOM_PROPERTIES) {
      expect(THEME_CSS, `theme.css must declare ${token}`).toContain(`${token}:`)
    }
  })
})
