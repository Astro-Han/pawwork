import { test, expect } from "bun:test"
import { Effect } from "effect"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"

test("plan agent is not registered after #239", async () => {
  await using tmp = await tmpdir()
  await Effect.runPromise(
    provideInstance(tmp.path)(
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const agents = yield* agent.list()
        const names = agents.map((a) => a.name)
        expect(names).not.toContain("plan")
        expect(names).toContain("build") // build remains as the hidden default
      }),
    ).pipe(Effect.provide(Agent.defaultLayer)),
  )
})
