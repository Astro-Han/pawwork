import { describe, expect, test } from "bun:test"
import type { CommandOption } from "@/context/command"
import { buildCommandPaletteDefaultGroups } from "./command-palette-default-items"

const labels = {
  suggested: "Suggested",
  navigation: "Navigation",
  panels: "Panels",
  configure: "Configure",
}

function command(id: string, disabled = false): CommandOption {
  return {
    id,
    title: id,
    category: "Commands",
    disabled,
  }
}

describe("buildCommandPaletteDefaultGroups", () => {
  test("returns the fixed default command map in group order", () => {
    const groups = buildCommandPaletteDefaultGroups({
      options: [
        command("session.new"),
        command("project.open"),
        command("file.open"),
        command("settings.open"),
        command("session.previous"),
        command("session.next"),
        command("input.focus"),
        command("sidebar.toggle"),
        command("panel.toggle"),
        command("terminal.toggle"),
        command("review.toggle"),
        command("browser.toggle"),
        command("model.choose"),
        command("mcp.toggle"),
        command("permissions.autoaccept"),
        command("session.compact"),
      ],
      labels,
    })

    expect(groups.map((group) => group.label)).toEqual(["Suggested", "Navigation", "Panels", "Configure"])
    expect(groups.flatMap((group) => group.items.map((item) => item.option?.id))).toEqual([
      "session.new",
      "project.open",
      "file.open",
      "settings.open",
      "session.previous",
      "session.next",
      "input.focus",
      "sidebar.toggle",
      "panel.toggle",
      "terminal.toggle",
      "review.toggle",
      "browser.toggle",
      "model.choose",
      "mcp.toggle",
      "permissions.autoaccept",
    ])
  })

  test("removes disabled commands without backfilling default slots", () => {
    const groups = buildCommandPaletteDefaultGroups({
      options: [
        command("session.new"),
        command("project.open", true),
        command("file.open"),
        command("settings.open"),
        command("session.compact"),
      ],
      labels,
    })

    expect(groups).toEqual([
      {
        id: "suggested",
        label: "Suggested",
        items: [
          expect.objectContaining({ option: expect.objectContaining({ id: "session.new" }) }),
          expect.objectContaining({ option: expect.objectContaining({ id: "file.open" }) }),
          expect.objectContaining({ option: expect.objectContaining({ id: "settings.open" }) }),
        ],
      },
    ])
  })

  test("hides empty groups", () => {
    const groups = buildCommandPaletteDefaultGroups({
      options: [command("session.previous")],
      labels,
    })

    expect(groups.map((group) => group.id)).toEqual(["navigation"])
  })

  test("ignores suggested-prefixed duplicate command entries", () => {
    const groups = buildCommandPaletteDefaultGroups({
      options: [
        command("suggested.session.new"),
        command("session.new"),
        command("suggested.file.open"),
        command("file.open"),
      ],
      labels,
    })

    expect(groups.flatMap((group) => group.items.map((item) => item.option?.id))).toEqual(["session.new", "file.open"])
  })
})
