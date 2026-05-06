import { afterEach, test, expect } from "bun:test"
import { Question } from "../../src/question"
import { SessionBlocker } from "../../src/session/blocker"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { QuestionID } from "../../src/question/schema"
import { tmpdir } from "../fixture/fixture"
import { MessageID, SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"

const ask = (
  input: { sessionID: SessionID; questions: Question.Info[]; tool?: { messageID: any; callID: string } },
  options?: { signal?: AbortSignal },
) => AppRuntime.runPromise(Question.Service.use((svc) => svc.ask(input)), options)

const list = () => AppRuntime.runPromise(Question.Service.use((svc) => svc.list()))

const reply = (input: { requestID: QuestionID; answers: Question.Answer[] }) =>
  AppRuntime.runPromise(Question.Service.use((svc) => svc.reply(input)))

const reject = (id: QuestionID) => AppRuntime.runPromise(Question.Service.use((svc) => svc.reject(id)))

const listBlockers = () => AppRuntime.runPromise(SessionBlocker.Service.use((svc) => svc.list()))

afterEach(async () => {
  await Instance.disposeAll()
})

/** Reject all pending questions so dangling Deferred fibers don't hang the test. */
async function rejectAll() {
  const pending = await list()
  for (const req of pending) {
    await reject(req.id)
  }
}

/** Wait until exactly one pending question shows up, then assert it landed.
 *  Returns the pending request so the caller can drive the next step. */
async function waitForPending(timeoutMs = 1000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const pending = await list()
    if (pending.length === 1) return pending[0]!
    await Bun.sleep(10)
  }
  expect(await list(), "expected exactly one pending question before continuing").toHaveLength(1)
  throw new Error("unreachable: assertion above always throws on miss")
}

test("ask - returns pending promise", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })
      expect(promise).toBeInstanceOf(Promise)
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

test("ask - adds to pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()
      expect(pending.length).toBe(1)
      expect(pending[0].questions).toEqual(questions)
      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

test("ask - records an awaiting question blocker", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_blocker"),
        questions: [
          {
            question: "Pick one",
            header: "Pick",
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
        tool: { messageID: MessageID.make("msg_blocker"), callID: "call_blocker" },
      })

      const pending = await list()
      const blockers = await listBlockers()

      expect(blockers).toHaveLength(1)
      expect(blockers[0]).toMatchObject({
        kind: "question",
        status: "awaiting_user",
        sessionID: SessionID.make("ses_blocker"),
        requestID: pending[0]!.id,
        tool: { messageID: MessageID.make("msg_blocker"), callID: "call_blocker" },
      })
      expect(blockers[0]!.request.id).toBe(pending[0]!.id)

      await rejectAll()
      await promise.catch(() => {})
    },
  })
})

// reply tests

test("reply - resolves the pending ask with answers", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Option 1", description: "First option" },
            { label: "Option 2", description: "Second option" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()
      const requestID = pending[0].id

      await reply({
        requestID,
        answers: [["Option 1"]],
      })

      const answers = await promise
      expect(answers).toEqual([["Option 1"]])
    },
  })
})

test("reply - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await list()
      expect(pending.length).toBe(1)

      await reply({
        requestID: pending[0].id,
        answers: [["Option 1"]],
      })
      await promise

      const after = await list()
      expect(after.length).toBe(0)
    },
  })
})

test("reply - clears the question blocker", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_blocker_reply"),
        questions: [
          {
            question: "Pick one",
            header: "Pick",
            options: [
              { label: "A", description: "first" },
              { label: "B", description: "second" },
            ],
          },
        ],
      })

      const pending = await list()
      expect(await listBlockers()).toHaveLength(1)

      await reply({ requestID: pending[0]!.id, answers: [["A"]] })
      await promise

      expect(await listBlockers()).toHaveLength(0)
    },
  })
})

test("reply - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await reply({
        requestID: QuestionID.make("que_unknown"),
        answers: [["Option 1"]],
      })
      // Should not throw
    },
  })
})

// reject tests

test("reject - throws RejectedError", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await list()
      await reject(pending[0].id)

      await expect(promise).rejects.toBeInstanceOf(Question.RejectedError)
    },
  })
})

test("reject - removes from pending list", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Option 1", description: "First option" },
              { label: "Option 2", description: "Second option" },
            ],
          },
        ],
      })

      const pending = await list()
      expect(pending.length).toBe(1)

      await reject(pending[0].id)
      promise.catch(() => {}) // Ignore rejection

      const after = await list()
      expect(after.length).toBe(0)
    },
  })
})

test("reject - does nothing for unknown requestID", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await reject(QuestionID.make("que_unknown"))
      // Should not throw
    },
  })
})

// multiple questions tests

test("ask - handles multiple questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()

      await reply({
        requestID: pending[0].id,
        answers: [["Build"], ["Dev"]],
      })

      const answers = await promise
      expect(answers).toEqual([["Build"], ["Dev"]])
    },
  })
})

test("reply - resolves empty answer arrays as skipped questions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const questions = [
        {
          question: "What would you like to do?",
          header: "Action",
          options: [
            { label: "Build", description: "Build the project" },
            { label: "Test", description: "Run tests" },
          ],
        },
        {
          question: "Which environment?",
          header: "Env",
          options: [
            { label: "Dev", description: "Development" },
            { label: "Prod", description: "Production" },
          ],
        },
      ]

      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions,
      })

      const pending = await list()
      await reply({
        requestID: pending[0].id,
        answers: [[], ["Dev"]],
      })

      const answers = await promise
      expect(answers).toEqual([[], ["Dev"]])
      expect(await list()).toEqual([])
    },
  })
})

test("reply - still rejects wrong answer count", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_test"),
        questions: [
          {
            question: "What would you like to do?",
            header: "Action",
            options: [
              { label: "Build", description: "Build the project" },
              { label: "Test", description: "Run tests" },
            ],
          },
          {
            question: "Which environment?",
            header: "Env",
            options: [
              { label: "Dev", description: "Development" },
              { label: "Prod", description: "Production" },
            ],
          },
        ],
      })

      const pending = await list()
      await reply({
        requestID: pending[0].id,
        answers: [["Build"]],
      })

      await expect(promise).rejects.toBeInstanceOf(Question.RejectedError)
      expect(await list()).toEqual([])
    },
  })
})

// list tests

test("list - returns all pending requests", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const p1 = ask({
        sessionID: SessionID.make("ses_test1"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }, { label: "B", description: "B" }],
          },
        ],
      })

      const p2 = ask({
        sessionID: SessionID.make("ses_test2"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }, { label: "C", description: "C" }],
          },
        ],
      })

      const pending = await list()
      expect(pending.length).toBe(2)
      await rejectAll()
      p1.catch(() => {})
      p2.catch(() => {})
    },
  })
})

test("list - returns empty when no pending", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const pending = await list()
      expect(pending.length).toBe(0)
    },
  })
})

test("questions stay isolated by directory", async () => {
  await using one = await tmpdir({ git: true })
  await using two = await tmpdir({ git: true })

  const p1 = Instance.provide({
    directory: one.path,
    fn: () =>
      ask({
        sessionID: SessionID.make("ses_one"),
        questions: [
          {
            question: "Question 1?",
            header: "Q1",
            options: [{ label: "A", description: "A" }, { label: "B", description: "B" }],
          },
        ],
      }),
  })

  const p2 = Instance.provide({
    directory: two.path,
    fn: () =>
      ask({
        sessionID: SessionID.make("ses_two"),
        questions: [
          {
            question: "Question 2?",
            header: "Q2",
            options: [{ label: "B", description: "B" }, { label: "C", description: "C" }],
          },
        ],
      }),
  })

  const onePending = await Instance.provide({
    directory: one.path,
    fn: () => list(),
  })
  const twoPending = await Instance.provide({
    directory: two.path,
    fn: () => list(),
  })

  expect(onePending.length).toBe(1)
  expect(twoPending.length).toBe(1)
  expect(onePending[0].sessionID).toBe(SessionID.make("ses_one"))
  expect(twoPending[0].sessionID).toBe(SessionID.make("ses_two"))

  await Instance.provide({
    directory: one.path,
    fn: () => reject(onePending[0].id),
  })
  await Instance.provide({
    directory: two.path,
    fn: () => reject(twoPending[0].id),
  })

  await p1.catch(() => {})
  await p2.catch(() => {})
})

// interrupt path: when the ask fiber is interrupted (e.g. session cancel),
// Question.ask must publish question.rejected so the frontend can clear the
// dock, AND remove the entry from pending so question.list() won't return a
// phantom. See issue #419.
//
// Two complementary coverage paths:
//   1. input.signal abort (production cancel route — EffectBridge.run.promise
//      breaks fiber interrupt, so the AbortSignal is the only working channel)
//   2. fiber interrupt via runPromise options.signal (defence-in-depth path
//      for direct supervisor kill / layer shutdown)

test("ask - publishes question.rejected on input.signal abort", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const events: { sessionID: SessionID; requestID: QuestionID }[] = []
      const unsub = Bus.subscribe(Question.Event.Rejected, (evt) => {
        events.push(evt.properties)
      })

      const controller = new AbortController()
      // Pass signal as `input.signal` (NOT to runPromise) so we exercise the
      // signal.addEventListener("abort", failFromAbort) branch, which is the
      // only one that survives in production where EffectBridge.run.promise
      // strips fiber interrupts.
      const promise = AppRuntime.runPromise(
        Question.Service.use((svc) =>
          svc.ask({
            sessionID: SessionID.make("ses_signal"),
            questions: [
              {
                question: "Pick one",
                header: "Pick",
                options: [
                  { label: "A", description: "first" },
                  { label: "B", description: "second" },
                ],
              },
            ],
            signal: controller.signal,
          }),
        ),
      ).catch((err) => err)

      await waitForPending()

      controller.abort()
      const result = await promise

      expect(events).toHaveLength(1)
      expect(events[0]?.sessionID).toBe(SessionID.make("ses_signal"))
      expect(result).toBeInstanceOf(Question.RejectedError)
      expect((result as Question.RejectedError).cancelled).toBe(true)
      expect((result as Question.RejectedError).message).toBe("Question cancelled before the user answered it.")

      const after = await list()
      expect(after).toHaveLength(0)

      unsub()
    },
  })
})

test("ask - publishes question.rejected on fiber interrupt", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const events: { sessionID: SessionID; requestID: QuestionID }[] = []
      const unsub = Bus.subscribe(Question.Event.Rejected, (evt) => {
        events.push(evt.properties)
      })

      const controller = new AbortController()
      const promise = ask(
        {
          sessionID: SessionID.make("ses_interrupt"),
          questions: [
            {
              question: "Pick one",
              header: "Pick",
              options: [
                { label: "A", description: "first" },
                { label: "B", description: "second" },
              ],
            },
          ],
        },
        { signal: controller.signal },
      ).catch(() => {})

      await waitForPending()

      controller.abort()
      await promise

      expect(events).toHaveLength(1)
      expect(events[0]?.sessionID).toBe(SessionID.make("ses_interrupt"))

      const after = await list()
      expect(after).toHaveLength(0)

      unsub()
    },
  })
})

test("reject - leaves cancelled flag false (user dismiss, not session cancel)", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const promise = ask({
        sessionID: SessionID.make("ses_dismiss"),
        questions: [
          {
            question: "Dismiss me?",
            header: "Dismiss",
            options: [
              { label: "Yes", description: "Yes" },
              { label: "No", description: "No" },
            ],
          },
        ],
      })

      const pending = await list()
      await reject(pending[0]!.id)

      const result = await promise.catch((err) => err)
      expect(result).toBeInstanceOf(Question.RejectedError)
      expect((result as Question.RejectedError).cancelled).toBeFalsy()
      expect((result as Question.RejectedError).message).toBe("The user dismissed this question")
    },
  })
})

test("reject - publishes question.rejected with dismissed reason and clears blocker", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const events: Array<{ sessionID: SessionID; requestID: QuestionID; reason?: string }> = []
      const unsub = Bus.subscribe(Question.Event.Rejected, (evt) => {
        events.push(evt.properties)
      })

      const promise = ask({
        sessionID: SessionID.make("ses_reason"),
        questions: [
          {
            question: "Dismiss me?",
            header: "Dismiss",
            options: [
              { label: "Yes", description: "Yes" },
              { label: "No", description: "No" },
            ],
          },
        ],
      })

      const pending = await list()
      expect(await listBlockers()).toHaveLength(1)

      await reject(pending[0]!.id)
      await promise.catch(() => {})

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        sessionID: SessionID.make("ses_reason"),
        requestID: pending[0]!.id,
        reason: "dismissed",
      })
      expect(await listBlockers()).toHaveLength(0)

      unsub()
    },
  })
})

// processor.failToolCall writes `errorMessage(error)` into part.state.error
// for the abort-signal path (failed != cleanup). The message getter has to
// branch on `cancelled` so consumers (state.error, logs, telemetry) read the
// same friendly copy as the legacy fiber-cleanup path. See #419.
test("RejectedError - message branches on cancelled flag", () => {
  const dismissed = new Question.RejectedError()
  expect(dismissed.cancelled).toBeFalsy()
  expect(dismissed.message).toBe("The user dismissed this question")

  const cancelled = new Question.RejectedError({ cancelled: true })
  expect(cancelled.cancelled).toBe(true)
  expect(cancelled.message).toBe("Question cancelled before the user answered it.")
})

test("pending question rejects on instance dispose", async () => {
  await using tmp = await tmpdir({ git: true })

  const pending = Instance.provide({
    directory: tmp.path,
    fn: () => {
      return ask({
        sessionID: SessionID.make("ses_dispose"),
        questions: [
          {
            question: "Dispose me?",
            header: "Dispose",
            options: [{ label: "Yes", description: "Yes" }, { label: "No", description: "No" }],
          },
        ],
      })
    },
  })
  const result = pending.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const items = await list()
      expect(items).toHaveLength(1)
      await Instance.dispose()
    },
  })

  expect(await result).toBeInstanceOf(Question.RejectedError)
})

test("pending question rejects on instance reload", async () => {
  await using tmp = await tmpdir({ git: true })

  const pending = Instance.provide({
    directory: tmp.path,
    fn: () => {
      return ask({
        sessionID: SessionID.make("ses_reload"),
        questions: [
          {
            question: "Reload me?",
            header: "Reload",
            options: [{ label: "Yes", description: "Yes" }, { label: "No", description: "No" }],
          },
        ],
      })
    },
  })
  const result = pending.then(
    () => "resolved" as const,
    (err) => err,
  )

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const items = await list()
      expect(items).toHaveLength(1)
      await Instance.reload({ directory: tmp.path })
    },
  })

  expect(await result).toBeInstanceOf(Question.RejectedError)
})
