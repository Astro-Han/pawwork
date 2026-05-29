import { Automation } from "."

export const automationDefinitionFixture = Automation.Definition.parse({
  kind: "recurring",
  id: "automation_000000000001abcdefghijklmn",
  title: "Daily repo brief",
  prompt: "Summarize repo changes.",
  revision: 2,
  paused: false,
  context: "fresh",
  where: { projectID: "project-fixture" },
  createdAt: 1_800_000_000_000,
  updatedAt: 1_800_000_030_000,
  timezone: "UTC",
  normalizationWarnings: [],
  rhythm: { kind: "interval", everyMs: 3_600_000 },
  stop: { kind: "never" },
  nextFireAt: null,
  nextFires: [],
  failureStreak: 0,
})

export const automationDefinitionDeletedFixture = Automation.Tombstone.parse({
  id: automationDefinitionFixture.id,
  deleted: true,
  revision: automationDefinitionFixture.revision + 1,
})

export const automationRunFixture = Automation.Run.parse({
  id: "automation_run_000000000002abcdefghijklmn",
  automationID: automationDefinitionFixture.id,
  revision: 1,
  definitionRevision: automationDefinitionFixture.revision,
  state: "awaiting_input",
  blocker: {
    kind: "permission",
    requestID: "per_000000000004abcdefghijklmn",
  },
  triggeredAt: 1_800_000_060_000,
  startedAt: 1_800_000_061_000,
  completedAt: null,
  sessionID: "ses_000000000003abcdefghijklmn",
  result: null,
  error: null,
  cost: null,
})

export const automationEventFixtures = [
  {
    type: Automation.Event.DefinitionUpdated.type,
    properties: automationDefinitionFixture,
  },
  {
    type: Automation.Event.DefinitionDeleted.type,
    properties: automationDefinitionDeletedFixture,
  },
  {
    type: Automation.Event.RunUpdated.type,
    properties: automationRunFixture,
  },
] as const
