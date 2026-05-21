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

test("accepts a valid pull request label set", () => {
  const result = validateLabelPolicy({
    itemType: "pull_request",
    labels: ["enhancement", "P2", "app", "ui"],
  })

  assert.deepEqual(result.errors, [])
})

test("accepts ci as a primary routing label", () => {
  const result = validateLabelPolicy({
    itemType: "pull_request",
    labels: ["task", "P2", "ci"],
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

test("accepts tech-debt as a supplemental label with any primary type", () => {
  const result = validateLabelPolicy({
    itemType: "issue",
    labels: ["bug", "P2", "app", "tech-debt"],
  })

  assert.deepEqual(result.errors, [])
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
