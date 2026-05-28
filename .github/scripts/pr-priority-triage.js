export const TRIAGE_MARKER = "<!-- pawwork-pr-priority-triage-v1 -->"

export const PRIORITY_LABELS = ["P0", "P1", "P2", "P3"]
export const TYPE_LABELS = ["bug", "enhancement", "task", "documentation"]

const LOW_RISK_GLOBS = [
  "docs/**",
  "**/*.md",
  ".github/workflows/**",
  "**/test/**",
  "**/e2e/**",
]

const USER_PATH_GLOBS = ["packages/app/src/**", "packages/desktop-electron/src/**"]
const RELEASE_BUMP_GLOBS = ["packages/desktop-electron/package.json", "bun.lock"]
const RELEASE_BUMP_REQUIRED_PATH = "packages/desktop-electron/package.json"

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&")
}

function globToRegExp(glob) {
  let out = "^"
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    const next = glob[index + 1]

    if (char === "*") {
      if (next === "*") {
        index += 1
        if (glob[index + 1] === "/") {
          index += 1
          out += "(?:.*/)?"
          continue
        }
        out += ".*"
        continue
      }
      out += "[^/]*"
      continue
    }

    if (char === "?") {
      out += "."
      continue
    }

    out += escapeRegex(char)
  }
  out += "$"
  return new RegExp(out)
}

function matchesAny(path, globs) {
  return globs.some((glob) => globToRegExp(glob).test(path))
}

export function classifyPriority(paths) {
  const normalized = paths.map((path) => path.replace(/\\/g, "/"))

  if (normalized.length === 0) {
    return {
      priority: "P3",
      reason: "no changed files were available from the pull request payload",
    }
  }

  if (normalized.every((path) => matchesAny(path, LOW_RISK_GLOBS))) {
    return {
      priority: "P3",
      reason: `only low-risk paths changed (${normalized.join(", ")})`,
    }
  }

  if (normalized.some((path) => matchesAny(path, USER_PATH_GLOBS))) {
    return {
      priority: "P2",
      reason: `includes user-path files (${normalized.filter((path) => matchesAny(path, USER_PATH_GLOBS)).join(", ")})`,
    }
  }

  return {
    priority: "P2",
    reason: "includes non-doc, non-test paths outside the low-risk bucket",
  }
}

export function buildPriorityReview(paths) {
  const verdict = classifyPriority(paths)
  const manualOverride =
    "P1/P0 are reserved for maintainer confirmation. Please relabel manually if this is a release blocker, security issue, data-loss risk, or updater/runtime failure."

  return {
    ...verdict,
    body: `${TRIAGE_MARKER}
Suggested priority: ${verdict.priority} (${verdict.reason}).

${manualOverride}`,
  }
}

/**
 * @param {string[]} paths
 * @param {string[]} labels
 */
export function planPriorityLabels(paths, labels = []) {
  const { priority } = classifyPriority(paths)
  const labelSet = new Set(labels)
  const existingPriorities = PRIORITY_LABELS.filter((label) => labelSet.has(label))
  const manualPriority = PRIORITY_LABELS.find((label) => label !== "P3" && labelSet.has(label))
  const desiredPriority = manualPriority ?? priority

  return {
    suggestedPriority: priority,
    desiredPriority,
    addLabels: labelSet.has(desiredPriority) ? [] : [desiredPriority],
    removeLabels: existingPriorities.filter((label) => label !== desiredPriority),
  }
}

export function classifyPullRequestType(paths) {
  const normalized = paths.map((path) => path.replace(/\\/g, "/"))

  if (
    normalized.length > 0 &&
    normalized.includes(RELEASE_BUMP_REQUIRED_PATH) &&
    normalized.every((path) => matchesAny(path, RELEASE_BUMP_GLOBS))
  ) {
    return "task"
  }

  return undefined
}

/**
 * @param {string[]} paths
 * @param {string[]} labels
 */
export function planPullRequestLabels(paths, labels = []) {
  const priorityPlan = planPriorityLabels(paths, labels)
  const labelSet = new Set(labels)
  const existingTypes = TYPE_LABELS.filter((label) => labelSet.has(label))
  const inferredType = existingTypes.length === 0 ? classifyPullRequestType(paths) : undefined
  const addLabels = [...priorityPlan.addLabels]

  if (inferredType && !labelSet.has(inferredType)) {
    addLabels.push(inferredType)
  }

  return {
    ...priorityPlan,
    addLabels,
  }
}
