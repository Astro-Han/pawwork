import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

import {
  commandPolicyFailures,
  countOutOfBoundsShapes,
  htmlFeatureFailures,
  qualityBand,
  scoreFromFindings,
  taskGateInstructions,
} from "./eval"

describe("ppt quality eval harness", () => {
  test("enforces native route tool boundaries", () => {
    expect(commandPolicyFailures("pptxgenjs", [{ tool: "bash", command: "node build.mjs" }])).toEqual([])
    expect(commandPolicyFailures("pptxgenjs", [{ tool: "bash", command: "uv run python build.py" }])).toContain(
      "PptxGenJS route did not call node.",
    )

    expect(commandPolicyFailures("python-pptx", [{ tool: "bash", command: "uv run python build.py" }])).toEqual([])
    expect(commandPolicyFailures("python-pptx", [{ tool: "bash", command: "officecli create out.pptx" }])).toContain(
      "Python PPTX route did not call uv.",
    )

    expect(commandPolicyFailures("svg-pptx", [{ tool: "bash", command: "uv run python scripts/svg_to_pptx.py deck" }])).toEqual([])
    expect(commandPolicyFailures("svg-pptx", [{ tool: "bash", command: "officecli create out.pptx" }])).toContain(
      "SVG PPTX route did not call uv.",
    )
  })

  test("keeps html showcase separate from native pptx scoring", () => {
    expect(commandPolicyFailures("html-showcase", [{ tool: "bash", command: "python3 build_html.py" }])).toEqual([])
    expect(commandPolicyFailures("html-showcase", [{ tool: "bash", command: "officecli create out.pptx" }])).toContain(
      "HTML showcase route called officecli.",
    )
  })

  test("counts content overflow but tolerates decorative edge bleed", () => {
    const inBounds = `<p:sp><a:off x="100" y="100"/><a:ext cx="1000" cy="1000"/></p:sp>`
    const textOverflow = `<p:sp><a:off x="647700" y="303848"/><a:ext cx="15229119" cy="962025"/><a:t>long single-line title</a:t></p:sp>`
    const decorativeBleed = `<p:sp><a:off x="8667750" y="-381000"/><a:ext cx="3238500" cy="3238500"/></p:sp>`
    const decorativeGone = `<p:sp><a:off x="12500000" y="0"/><a:ext cx="3238500" cy="3238500"/></p:sp>`
    const picOverflow = `<p:pic><a:off x="12000000" y="0"/><a:ext cx="1000000" cy="1000000"/></p:pic>`
    expect(countOutOfBoundsShapes([inBounds + textOverflow + decorativeBleed])).toBe(1)
    expect(countOutOfBoundsShapes([decorativeGone])).toBe(1)
    expect(countOutOfBoundsShapes([picOverflow])).toBe(1)
    expect(countOutOfBoundsShapes([inBounds])).toBe(0)
  })

  test("maps quality scores into stable report bands", () => {
    expect(qualityBand(92)).toBe("excellent")
    expect(qualityBand(74)).toBe("usable")
    expect(qualityBand(58)).toBe("weak")
    expect(qualityBand(31)).toBe("failed")
  })

  test("caps failed runs below excellent", () => {
    expect(scoreFromFindings(["hard failure"], [])).toBeLessThan(85)
    expect(qualityBand(scoreFromFindings(["hard failure"], []))).toBe("usable")
  })

  test("requires evidence objects in html showcase decks when the task asks for them", () => {
    expect(htmlFeatureFailures("<section data-layout='x'><svg></svg></section>", { requiresChart: true })).toEqual([])
    expect(htmlFeatureFailures("<section data-layout='x'></section>", { requiresChart: true })).toContain(
      "HTML deck has no chart-like evidence object for a data-backed task.",
    )
    expect(htmlFeatureFailures("<section data-layout='x'><img src='shot.png'></section>", { requiresImage: true })).toEqual([])
    expect(htmlFeatureFailures("<section data-layout='x'></section>", { requiresImage: true })).toContain(
      "HTML deck has no image evidence object for the image task.",
    )
  })

  test("makes task-specific evidence gates explicit in the model prompt", () => {
    const native = taskGateInstructions(
      { requiredText: ["8-12 hours"], requiresImage: true, requiresChart: true },
      "pptxgenjs",
    )
    expect(native).toContain("8-12 hours")
    expect(native).toContain("ppt/media")
    expect(native).toContain("chart XML")

    const html = taskGateInstructions({ requiredText: ["8-12 hours"], requiresImage: true }, "html-showcase")
    expect(html).toContain("8-12 hours")
    expect(html).toContain("<img")
  })

  test("native route skills make the title-size floor concrete", () => {
    for (const skillName of ["officecli-current", "python-pptx-native", "pptxgenjs-native", "svg-pptx-native"]) {
      const skillPath = path.join(import.meta.dir, "route-skills", skillName, "SKILL.md")
      const skill = readFileSync(skillPath, "utf8")
      expect(skill).toContain("44pt")
      expect(skill).toContain("18pt")
    }
  })
})
