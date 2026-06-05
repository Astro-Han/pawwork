import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test } from "../fixtures"
import { openSidebar } from "../actions"
import { composeGrid, snapOutputPath, type Shot } from "./_compose"

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })

// Seed project-scoped skills (.agents/skills/<name>/SKILL.md) so the gallery has
// real installed capabilities to render in a clean env. Descriptions mirror the
// long machine-facing trigger text the real officecli/morph skills carry, since
// reading well against that text is the design risk the gallery has to clear.
type Seed = { name: string; description: string; body: string }

const SEEDS: Seed[] = [
  {
    name: "officecli-docx",
    description:
      "Use this skill any time a .docx Word document needs to be created, edited, or inspected. Trigger on requests to draft letters, reports, contracts, or any formatted prose that should ship as Word.",
    body: ["## Overview", "", "Build and edit Word documents from the command line.", "", "```bash", "officecli docx build report.md --out report.docx", "```"].join("\n"),
  },
  {
    name: "officecli-xlsx",
    description:
      "Use this skill when a spreadsheet is involved: creating, reading, or modifying .xlsx files, computing tables, or turning data into a workbook the user can open in Excel.",
    body: ["## Overview", "", "Generate and edit spreadsheets.", "", "```bash", "officecli xlsx build data.csv --out book.xlsx", "```"].join("\n"),
  },
  {
    name: "officecli-pptx",
    description:
      "Use this skill to produce slide decks. Trigger on any request to build, edit, or restructure a .pptx PowerPoint presentation from an outline or notes.",
    body: ["## Overview", "", "Assemble slide decks from an outline.", "", "```bash", "officecli pptx build outline.md --out deck.pptx", "```"].join("\n"),
  },
  {
    name: "morph-apply",
    description:
      "Use this skill to apply a fast, surgical edit to a single file given a patch description, when a full rewrite would be wasteful and the change is localized.",
    body: ["## Overview", "", "Apply a localized edit without rewriting the whole file."].join("\n"),
  },
  {
    name: "pdf-extract",
    description:
      "Use this skill when text or tables need to be pulled out of a PDF: invoices, scanned reports, forms, or any document delivered as .pdf.",
    body: ["## Overview", "", "Extract text and tables from PDF files."].join("\n"),
  },
  {
    name: "web-research",
    description:
      "Use this skill to gather current information from the web: news, prices, documentation, or any fact that may have changed since training.",
    body: ["## Overview", "", "Search the web and summarize findings with sources."].join("\n"),
  },
]

async function seedSkill(directory: string, seed: Seed) {
  const skillDir = join(directory, ".agents", "skills", seed.name)
  await mkdir(skillDir, { recursive: true })
  await writeFile(
    join(skillDir, "SKILL.md"),
    ["---", `name: ${seed.name}`, `description: ${seed.description}`, "---", "", seed.body, ""].join("\n"),
  )
}

test("skills-surface", async ({ page, project }) => {
  test.setTimeout(180_000)

  await project.open({
    setup: async (directory) => {
      for (const seed of SEEDS) await seedSkill(directory, seed)
    },
  })
  await openSidebar(page)

  await page.locator('[data-action="pawwork-skills-open"]').click()
  const surface = page.locator('[data-component="skills-page"]')
  await surface.waitFor({ state: "visible", timeout: 30_000 })

  const rows = surface.locator('[data-action="skill-open"]')
  await rows.first().waitFor({ state: "visible", timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-action="skill-open"]').length >= 6)
  const gallery = await page.screenshot()

  // Open one capability to read its detail modal: humanized title, verbatim
  // description, and the full SKILL.md markdown body with a copyable code block.
  await surface.locator('[data-action="skill-open"][data-skill="officecli-docx"]').click()
  const detail = page.locator('[data-component="skill-detail"]')
  await detail.waitFor({ state: "visible", timeout: 30_000 })
  const detailShot = await page.screenshot()

  // Close and filter: the search box narrows the grid to matching capabilities.
  // "xlsx" keeps the spreadsheet skill (and any whose description mentions it)
  // and drops the unrelated ones, e.g. the seeded web-research capability.
  await page.locator('[data-action="skill-detail-close"]').click()
  await surface.locator('[data-action="skill-search"]').fill("xlsx")
  await surface.locator('[data-action="skill-open"][data-skill="officecli-xlsx"]').waitFor({ state: "visible", timeout: 10_000 })
  await page.waitForFunction(
    () => document.querySelectorAll('[data-action="skill-open"][data-skill="web-research"]').length === 0,
  )
  const filtered = await page.screenshot()

  const shots: Shot[] = [
    { name: "gallery", buf: gallery },
    { name: "detail", buf: detailShot },
    { name: "search", buf: filtered },
  ]
  const out = snapOutputPath("skills-surface")
  await composeGrid(shots, out)
  process.stdout.write(`\n[snap] skills-surface grid -> ${out}\n\n`)
})
