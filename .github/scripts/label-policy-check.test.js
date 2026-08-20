import test from "node:test"
import assert from "node:assert/strict"

import { validateLabelPolicy } from "./label-policy-check.js"

function messages(result) {
  return result.errors.map((error) => error.message)
}

test("accepts a valid issue label set", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["task", "P2", "app", "tech-debt"],
  })

  assert.deepEqual(result.errors, [])
})

// Dependabot labels its own pull requests, and those labels are forbidden on
// issues only. Without the itemType gate every dependency PR fails pr-triage.
test("accepts the automation labels Dependabot puts on its pull requests", () => {
  const result = validateLabelPolicy({
    itemType: "pull_request",
    labels: ["dependencies", "github_actions", "task", "P3", "ci"],
  })

  assert.deepEqual(result.errors, [])
})

test("rejects missing priority labels", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["bug", "app"],
  })

  assert.deepEqual(messages(result), ["issue must have exactly one priority label: P0, P1, P2, or P3"])
})

test("treats missing labels input as an empty label set", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
  })

  assert.deepEqual(messages(result), [
    "issue must have exactly one priority label: P0, P1, P2, or P3",
    "issue must have exactly one type label: bug, enhancement, task, or documentation",
    "issue must have at least one primary routing label: app, ui, platform, harness, or ci",
  ])
})

test("rejects multiple priority labels", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["bug", "P1", "P2", "app"],
  })

  assert.deepEqual(messages(result), ["issue must have exactly one priority label: P0, P1, P2, or P3"])
})

test("rejects missing type labels", () => {
  const result = validateLabelPolicy({
    itemType: "pull_request",
    labels: ["P2", "app"],
  })

  assert.deepEqual(messages(result), [
    "pull_request must have exactly one type label: bug, enhancement, task, or documentation",
  ])
})

test("rejects multiple type labels", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["bug", "task", "P2", "app"],
  })

  assert.deepEqual(messages(result), [
    "issue must have exactly one type label: bug, enhancement, task, or documentation",
  ])
})

test("rejects missing primary routing labels", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["task", "P2"],
  })

  assert.deepEqual(messages(result), [
    "issue must have at least one primary routing label: app, ui, platform, harness, or ci",
  ])
})

test("rejects dependency automation labels on issues", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["task", "P3", "app", "dependencies"],
  })

  assert.deepEqual(messages(result), [
    "issue must not use PR automation labels: dependencies, github_actions, or javascript",
  ])
})

test("reports all independent label policy failures", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["bug", "enhancement", "P1", "P2", "dependencies"],
  })

  assert.deepEqual(messages(result), [
    "issue must have exactly one priority label: P0, P1, P2, or P3",
    "issue must have exactly one type label: bug, enhancement, task, or documentation",
    "issue must have at least one primary routing label: app, ui, platform, harness, or ci",
    "issue must not use PR automation labels: dependencies, github_actions, or javascript",
  ])
})
