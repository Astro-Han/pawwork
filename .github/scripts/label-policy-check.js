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

function labelList(labels) {
  if (labels.length <= 1) return labels.join("")
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`
}

/**
 * @param {{ itemType: string, labels?: string[] }} input
 */
export function validateLabelPolicy({ itemType, labels = [] }) {
  const labelSet = new Set(labels)
  const errors = []

  const priorities = intersection(labelSet, POLICY.priorities)
  if (priorities.length !== 1) {
    errors.push(error(`${itemType} must have exactly one priority label: ${labelList(POLICY.priorities)}`, priorities))
  }

  const types = intersection(labelSet, POLICY.types)
  if (types.length !== 1) {
    errors.push(error(`${itemType} must have exactly one type label: ${labelList(POLICY.types)}`, types))
  }

  const routing = intersection(labelSet, POLICY.routing)
  if (routing.length < 1) {
    errors.push(
      error(`${itemType} must have at least one primary routing label: ${labelList(POLICY.routing)}`, routing),
    )
  }

  const forbiddenIssueLabels = itemType === "issue" ? intersection(labelSet, POLICY.issueForbiddenLabels) : []
  if (forbiddenIssueLabels.length > 0) {
    errors.push(
      error(`issue must not use PR automation labels: ${labelList(POLICY.issueForbiddenLabels)}`, forbiddenIssueLabels),
    )
  }

  return {
    ok: errors.length === 0,
    errors,
  }
}
