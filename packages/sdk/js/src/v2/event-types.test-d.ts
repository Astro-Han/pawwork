import type {
  Event,
  EventAutomationDefinitionDeleted,
  EventAutomationDefinitionUpdated,
  EventAutomationRunUpdated,
  EventFileWatcherRescan,
} from "./gen/types.gen.js"

type Assert<T extends true> = T

type _RescanIsSdkEvent = Assert<EventFileWatcherRescan extends Event ? true : false>
type _AutomationDefinitionUpdatedIsSdkEvent = Assert<EventAutomationDefinitionUpdated extends Event ? true : false>
type _AutomationDefinitionDeletedIsSdkEvent = Assert<EventAutomationDefinitionDeleted extends Event ? true : false>
type _AutomationRunUpdatedIsSdkEvent = Assert<EventAutomationRunUpdated extends Event ? true : false>

const _rescan: EventFileWatcherRescan = {
  type: "file.watcher.rescan",
  properties: {
    directory: "/repo",
  },
}

const _automationDefinitionUpdated: EventAutomationDefinitionUpdated = {
  type: "automation.definition.updated",
  properties: {
    kind: "recurring",
    id: "automation_000000000001abcdefghijklmn",
    title: "Daily repo brief",
    prompt: "Summarize repo changes.",
    revision: 2,
    paused: false,
    context: "fresh",
    where: { projectID: "project-fixture" },
    createdAt: 1800000000000,
    updatedAt: 1800000030000,
    timezone: "UTC",
    normalizationWarnings: [],
    rhythm: { kind: "interval", everyMs: 3600000 },
    stop: { kind: "never" },
    nextFireAt: null,
    nextFires: [],
    failureStreak: 0,
  },
}

const _automationDefinitionDeleted: EventAutomationDefinitionDeleted = {
  type: "automation.definition.deleted",
  properties: {
    id: "automation_000000000001abcdefghijklmn",
    deleted: true,
    revision: 3,
  },
}

const _automationRunUpdated: EventAutomationRunUpdated = {
  type: "automation.run.updated",
  properties: {
    id: "automation_run_000000000002abcdefghijklmn",
    automationID: "automation_000000000001abcdefghijklmn",
    revision: 1,
    state: "awaiting_input",
    blocker: {
      kind: "permission",
      sessionID: "ses_000000000003abcdefghijklmn",
      requestID: "per_000000000004abcdefghijklmn",
    },
    triggeredAt: 1800000060000,
    startedAt: 1800000061000,
    completedAt: null,
    sessionID: "ses_000000000003abcdefghijklmn",
    result: null,
    error: null,
    cost: null,
  },
}
