import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import type { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

type SeededProject = {
  directory: string
  session: Session.Info
}

afterEach(async () => {
  await Instance.disposeAll()
})

function withDirectory(pathname: string, directory: string) {
  const url = new URL(pathname, "http://localhost")
  url.searchParams.set("directory", directory)
  return `${url.pathname}${url.search}`
}

async function requestOk(label: string, pathname: string, init?: RequestInit) {
  const response = await Server.Default().app.request(pathname, init)
  if (response.ok) return response
  const body = await response.text()
  throw new Error(`${label} returned ${response.status}: ${body}`)
}

async function seedProject(directory: string, index: number): Promise<SeededProject> {
  const sessionResponse = await requestOk(
    `project ${index} session create`,
    withDirectory("/session", directory),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `windows-concurrency-${index}` }),
    },
  )
  const session = (await sessionResponse.json()) as Session.Info

  await requestOk(
    `project ${index} completed prompt`,
    withDirectory(`/session/${session.id}/message`, directory),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        noReply: true,
        model: { providerID: "test", modelID: "test" },
        parts: [{ type: "text", text: `completed task ${index}` }],
      }),
    },
  )

  return { directory, session }
}

const bootstrapPaths = [
  "/provider",
  "/agent",
  "/config",
  "/config/errors",
  "/session/status",
  "/project/current",
  "/path",
  "/vcs",
  "/command",
  "/permission",
  "/external-result",
  "/mcp",
  "/automation",
] as const

describe("Windows multi-project session concurrency", () => {
  test(
    "keeps session lists and bootstrap reads healthy after completed tasks while switching projects",
    async () => {
      await using first = await tmpdir({ git: true })
      await using second = await tmpdir({ git: true })
      await using third = await tmpdir({ git: true })
      const projects = await Promise.all(
        [first.path, second.path, third.path].map((directory, index) => seedProject(directory, index)),
      )

      for (let round = 0; round < 12; round++) {
        const active = projects[round % projects.length]
        const reads = [
          requestOk(
            `round ${round} global session list`,
            "/experimental/session?roots=true&limit=100&sort=activity",
          ),
          ...projects.map((project, index) =>
            requestOk(
              `round ${round} project ${index} session list`,
              withDirectory("/session?roots=true&limit=100&sort=created", project.directory),
            ),
          ),
          ...bootstrapPaths.map((pathname) =>
            requestOk(`round ${round} active bootstrap ${pathname}`, withDirectory(pathname, active.directory)),
          ),
        ]

        await Promise.all(reads)
      }

      const global = await requestOk("final global session list", "/experimental/session?roots=true&limit=100")
      const ids = ((await global.json()) as Session.Info[]).map((session) => session.id)
      expect(ids).toEqual(expect.arrayContaining(projects.map((project) => project.session.id)))
    },
    30_000,
  )
})
