import { describe, expect, test } from "bun:test"
import { automationEventFixtures } from "../../src/automation/fixtures"
import { Automation } from "../../src/automation"

describe("automation event fixtures", () => {
  test("match the frozen automation event schemas", () => {
    expect(() => Automation.Event.DefinitionUpdated.properties.parse(automationEventFixtures[0].properties)).not.toThrow()
    expect(() => Automation.Event.DefinitionDeleted.properties.parse(automationEventFixtures[1].properties)).not.toThrow()
    expect(() => Automation.Event.RunUpdated.properties.parse(automationEventFixtures[2].properties)).not.toThrow()
  })
})
