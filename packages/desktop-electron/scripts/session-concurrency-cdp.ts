import { execFileSync } from "node:child_process"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium, type Page } from "@playwright/test"

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

type SeededProject = {
  directory: string
  sessionID: string
}

type HttpFailure = {
  status: number
  url: string
  body: string
}

async function createProject(directory: string, index: number) {
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "README.md"), `# Windows Electron concurrency ${index}\n`)
  execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" })
  await writeFile(path.join(directory, ".git", "opencode"), `windows-electron-${index}`)
  execFileSync("git", ["config", "core.fsmonitor", "false"], { cwd: directory, stdio: "ignore" })
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: directory, stdio: "ignore" })
  execFileSync("git", ["add", "README.md"], { cwd: directory, stdio: "ignore" })
  execFileSync(
    "git",
    [
      "-c",
      "user.name=PawWork CI",
      "-c",
      "user.email=ci@pawwork.ai",
      "commit",
      "-m",
      "test fixture",
    ],
    { cwd: directory, stdio: "ignore" },
  )
  return await realpath(directory)
}

async function rendererPage(port: number) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
  const page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => !candidate.url().startsWith("devtools://") && candidate.url() !== "about:blank")
  if (!page) {
    await browser.close()
    throw new Error("Electron CDP endpoint did not expose the PawWork renderer page")
  }
  return { browser, page }
}

async function seedCompletedSessions(page: Page, directories: string[]): Promise<SeededProject[]> {
  return await page.evaluate(async (projectDirectories) => {
    const sidecar = await window.api.awaitInitialization(() => undefined)
    const auth = btoa(`${sidecar.username ?? "opencode"}:${sidecar.password ?? ""}`)

    const request = async (pathname: string, directory: string, init?: RequestInit) => {
      const url = new URL(pathname, sidecar.url)
      url.searchParams.set("directory", directory)
      const response = await fetch(url, {
        ...init,
        headers: {
          authorization: `Basic ${auth}`,
          ...(init?.headers ?? {}),
        },
      })
      if (response.ok) return response
      throw new Error(`${response.status} ${url.pathname}: ${await response.text()}`)
    }

    const projects = await Promise.all(
      projectDirectories.map(async (directory, index) => {
        const created = await request("/session", directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: `windows-electron-concurrency-${index}` }),
        }).then((response) => response.json() as Promise<{ id: string }>)

        await request(`/session/${created.id}/message`, directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            noReply: true,
            model: { providerID: "test", modelID: "test" },
            parts: [{ type: "text", text: `completed Windows Electron task ${index}` }],
          }),
        })

        return { directory, sessionID: created.id }
      }),
    )

    await window.api.storeSet(
      "pawwork.global.dat",
      "server",
      JSON.stringify({
        list: [],
        projects: {
          local: projectDirectories.map((directory) => ({ worktree: directory, expanded: true })),
        },
        lastProject: { local: projectDirectories[0] },
      }),
    )
    return projects
  }, directories)
}

async function concurrentReads(page: Page, projects: SeededProject[], activeDirectory: string) {
  await page.evaluate(
    async ({ active, directories, bootstrap }) => {
      const sidecar = await window.api.awaitInitialization(() => undefined)
      const auth = btoa(`${sidecar.username ?? "opencode"}:${sidecar.password ?? ""}`)
      const request = async (pathname: string, directory?: string) => {
        const url = new URL(pathname, sidecar.url)
        if (directory) url.searchParams.set("directory", directory)
        const response = await fetch(url, { headers: { authorization: `Basic ${auth}` } })
        if (response.ok) return
        throw new Error(`${response.status} ${url.pathname}: ${await response.text()}`)
      }

      await Promise.all([
        request("/experimental/session?roots=true&limit=100&sort=activity"),
        ...directories.map((directory) => request("/session?roots=true&limit=100&sort=created", directory)),
        ...bootstrap.map((pathname) => request(pathname, active)),
      ])
    },
    { active: activeDirectory, directories: projects.map((project) => project.directory), bootstrap: bootstrapPaths },
  )
}

export async function runSessionConcurrencyCdp(input: { port: number; homeDir: string }) {
  const directories = await Promise.all(
    [0, 1, 2].map((index) =>
      createProject(path.join(input.homeDir, "session-concurrency-projects", String(index)), index),
    ),
  )

  const { browser, page } = await rendererPage(input.port)
  const httpFailures: Promise<HttpFailure>[] = []
  const rendererFailures: string[] = []

  page.on("response", (response) => {
    if (response.status() < 500) return
    httpFailures.push(
      response
        .text()
        .catch(() => "<unavailable>")
        .then((body) => ({ status: response.status(), url: response.url(), body })),
    )
  })
  page.on("pageerror", (error) => rendererFailures.push(error.stack ?? error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && message.text().includes("[e2e:error-boundary]")) {
      rendererFailures.push(message.text())
    }
  })

  try {
    const projects = await seedCompletedSessions(page, directories)
    await page.addInitScript(() => {
      ;(window as Window & { __opencode_e2e?: Record<string, unknown> }).__opencode_e2e = {}
    })
    await page.reload({ waitUntil: "domcontentloaded" })

    const sidebarToggle = page.locator('[data-action="pawwork-sidebar-toggle"]')
    await sidebarToggle.waitFor({ state: "visible", timeout: 30_000 })
    if ((await sidebarToggle.getAttribute("aria-expanded")) !== "true") await sidebarToggle.click()
    await sidebarToggle.waitFor({ state: "visible" })

    for (const project of projects) {
      await page
        .locator(`[data-session-id="${project.sessionID}"][data-component="pawwork-session-row"] a`)
        .first()
        .waitFor({ state: "visible", timeout: 30_000 })
    }

    for (let round = 0; round < 12; round += 1) {
      const active = projects[round % projects.length]
      const link = page
        .locator(`[data-session-id="${active.sessionID}"][data-component="pawwork-session-row"] a`)
        .first()
      await link.click()
      await page.waitForFunction(
        (sessionID) =>
          document
            .querySelector(`[data-session-id="${sessionID}"][data-component="pawwork-session-row"] a`)
            ?.classList.contains("active") === true,
        active.sessionID,
        { timeout: 30_000 },
      )
      await concurrentReads(page, projects, active.directory)
      await page.locator('[data-component="prompt-input"]').waitFor({ state: "visible", timeout: 30_000 })
    }

    const failedResponses = await Promise.all(httpFailures)
    if (failedResponses.length || rendererFailures.length) {
      throw new Error(
        JSON.stringify({ httpFailures: failedResponses, rendererFailures }, null, 2),
      )
    }

    return { projects: projects.length, switches: 12, failedResponses: 0 }
  } finally {
    await browser.close()
  }
}
