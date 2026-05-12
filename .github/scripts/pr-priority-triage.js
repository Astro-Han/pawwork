export const TRIAGE_MARKER = "<!-- pawwork-pr-priority-triage-v1 -->"

const LOW_RISK_GLOBS = [
  "docs/**",
  "**/*.md",
  ".github/workflows/**",
  "**/test/**",
  "**/e2e/**",
]

const USER_PATH_GLOBS = ["packages/app/src/**", "packages/desktop-electron/src/**"]

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
