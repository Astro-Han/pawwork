export const POLICY = {
  priorities: ["P0", "P1", "P2", "P3"],
  types: ["bug", "enhancement", "task", "documentation"],
  routing: ["app", "ui", "platform", "harness", "ci"],
  issueForbiddenLabels: ["dependencies", "github_actions", "javascript"],
}

function intersection(labels, allowed) {
  return allowed.filter((label) => labels.has(label))
}

function error(message, labels) {
  return { message, labels }
}

export function validateLabelPolicy({ itemType, labels }) {
  const labelSet = new Set(labels)
  const errors = []

  const priorities = intersection(labelSet, POLICY.priorities)
  if (priorities.length !== 1) {
    errors.push(error(`${itemType} must have exactly one priority label: P0, P1, P2, or P3`, priorities))
  }

  const types = intersection(labelSet, POLICY.types)
  if (types.length !== 1) {
    errors.push(error(`${itemType} must have exactly one type label: bug, enhancement, task, or documentation`, types))
  }

  const routing = intersection(labelSet, POLICY.routing)
  if (routing.length < 1) {
    errors.push(error(`${itemType} must have at least one primary routing label: app, ui, platform, harness, or ci`, routing))
  }

  if (labelSet.has("tech-debt") && !labelSet.has("task")) {
    errors.push(error("tech-debt is only allowed with the task type label", ["tech-debt"]))
  }

  const forbiddenIssueLabels =
    itemType === "issue" ? intersection(labelSet, POLICY.issueForbiddenLabels) : []
  if (forbiddenIssueLabels.length > 0) {
    errors.push(
      error("issue must not use PR automation labels: dependencies, github_actions, or javascript", forbiddenIssueLabels),
    )
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}
