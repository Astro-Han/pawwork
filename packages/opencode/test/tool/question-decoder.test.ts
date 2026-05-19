import { describe, expect, test } from "bun:test"
import { questionDecoder } from "../../src/tool/question"

const singleSelectSnapshot = {
  questions: [
    {
      question: "Pick one",
      options: [{ label: "Yes" }, { label: "No" }],
      multiple: false,
      custom: false,
    },
  ],
}
const multiSelectSnapshot = {
  questions: [
    {
      question: "Pick any",
      options: [{ label: "A" }, { label: "B" }, { label: "C" }],
      multiple: true,
      custom: false,
    },
  ],
}
const customAllowedSnapshot = {
  questions: [
    {
      question: "Free form",
      options: [{ label: "Yes" }, { label: "No" }],
      multiple: false,
      custom: true,
    },
  ],
}

describe("questionDecoder shape guards", () => {
  test("rejects non-object payload", () => {
    expect(questionDecoder(null, singleSelectSnapshot)).toMatchObject({ ok: false, error: "payload_not_object" })
    expect(questionDecoder("oops", singleSelectSnapshot)).toMatchObject({ ok: false, error: "payload_not_object" })
  })
  test("rejects non-array answers field", () => {
    expect(questionDecoder({ answers: "yes" }, singleSelectSnapshot)).toMatchObject({
      ok: false,
      error: "answers_not_array",
    })
  })
  test("rejects rows that are not string arrays", () => {
    expect(questionDecoder({ answers: [[1]] }, singleSelectSnapshot)).toMatchObject({
      ok: false,
      error: "answer_row_not_string_array",
    })
  })
})

describe("questionDecoder semantic rules", () => {
  test("answer count mismatch returns details", () => {
    const result = questionDecoder({ answers: [] }, singleSelectSnapshot)
    expect(result).toMatchObject({
      ok: false,
      error: "answer_count_mismatch",
      details: { expected: 1, got: 0 },
    })
  })

  test("multi answer to single-select question is rejected", () => {
    const result = questionDecoder({ answers: [["Yes", "No"]] }, singleSelectSnapshot)
    expect(result).toMatchObject({ ok: false, error: "multi_answer_to_single_select" })
  })

  test("custom:false rejects labels not in options", () => {
    const result = questionDecoder({ answers: [["Maybe"]] }, singleSelectSnapshot)
    expect(result).toMatchObject({ ok: false, error: "label_not_in_options" })
  })

  test("custom:true accepts arbitrary labels", () => {
    const result = questionDecoder({ answers: [["whatever the user typed"]] }, customAllowedSnapshot)
    expect(result.ok).toBe(true)
  })

  test("whitespace-only answer trims to empty (treated as skipped)", () => {
    const result = questionDecoder({ answers: [["  "]] }, singleSelectSnapshot)
    expect(result).toEqual({ ok: true, value: { answers: [[]] } })
  })

  test("happy path returns trimmed answers", () => {
    const result = questionDecoder({ answers: [["  Yes  "]] }, singleSelectSnapshot)
    expect(result).toEqual({ ok: true, value: { answers: [["Yes"]] } })
  })

  test("multi-select accepts multiple labels", () => {
    const result = questionDecoder({ answers: [["A", "C"]] }, multiSelectSnapshot)
    expect(result).toEqual({ ok: true, value: { answers: [["A", "C"]] } })
  })

  test("option labels with incidental whitespace match trimmed answers", () => {
    // Regression: validLabels was previously built from raw option.label,
    // while answers are trimmed during decode. A label like " yes " would
    // become "yes" on the answer side and fail membership forever (422).
    const paddedLabelSnapshot = {
      questions: [
        {
          question: "Pick one",
          options: [{ label: " yes " }, { label: "no" }],
          multiple: false,
          custom: false,
        },
      ],
    }
    const result = questionDecoder({ answers: [["yes"]] }, paddedLabelSnapshot)
    expect(result).toEqual({ ok: true, value: { answers: [["yes"]] } })
  })
})
