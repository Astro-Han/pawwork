import { afterEach, test, expect } from "bun:test"
import { Skill } from "../../src/skill"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import fs from "fs/promises"

const processWithResourcesPath = process as NodeJS.Process & { resourcesPath?: string }

afterEach(async () => {
  await Instance.disposeAll()
})

async function createGlobalSkill(homeDir: string) {
  const skillDir = path.join(homeDir, ".claude", "skills", "global-test-skill")
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: global-test-skill
description: A global skill from ~/.claude/skills for testing.
---

# Global Test Skill

This skill is loaded from the global home directory.
`,
  )
}

async function createBundledSkill(resourcesDir: string, name: string, description = "A bundled skill for testing.") {
  const skillDir = path.join(resourcesDir, "skills", name)
  await fs.mkdir(skillDir, { recursive: true })
  await Bun.write(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---

# ${name}
`,
  )
}

test("discovers skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "test-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A test skill for verification.
---

# Test Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const testSkill = skills.find((s) => s.name === "test-skill")
      expect(testSkill).toBeDefined()
      expect(testSkill!.description).toBe("A test skill for verification.")
      expect(testSkill!.location).toContain(path.join("skill", "test-skill", "SKILL.md"))
    },
  })
})

test("returns skill directories from Skill.dirs", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "dir-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: dir-skill
description: Skill for dirs test.
---

# Dir Skill
`,
      )
    },
  })

  const home = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const dirs = await Skill.dirs()
        const skillDir = path.join(tmp.path, ".opencode", "skill", "dir-skill")
        expect(dirs).toContain(skillDir)
        expect(dirs.length).toBeGreaterThanOrEqual(1)
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = home
  }
})

test("discovers multiple skills from .opencode/skill/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir1 = path.join(dir, ".opencode", "skill", "skill-one")
      const skillDir2 = path.join(dir, ".opencode", "skill", "skill-two")
      await Bun.write(
        path.join(skillDir1, "SKILL.md"),
        `---
name: skill-one
description: First test skill.
---

# Skill One
`,
      )
      await Bun.write(
        path.join(skillDir2, "SKILL.md"),
        `---
name: skill-two
description: Second test skill.
---

# Skill Two
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "skill-one")).toBeDefined()
      expect(skills.find((s) => s.name === "skill-two")).toBeDefined()
    },
  })
})

test("skips skills with missing frontmatter", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "no-frontmatter")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `# No Frontmatter

Just some content without YAML frontmatter.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "no-frontmatter")).toBeUndefined()
    },
  })
})

test("discovers skills from .claude/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".claude", "skills", "claude-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const claudeSkill = skills.find((s) => s.name === "claude-skill")
      expect(claudeSkill).toBeDefined()
      expect(claudeSkill!.location).toContain(path.join(".claude", "skills", "claude-skill", "SKILL.md"))
    },
  })
})

test("discovers global skills from ~/.claude/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    await createGlobalSkill(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const skill = skills.find((item) => item.name === "global-test-skill")
        expect(skill).toBeDefined()
        expect(skill!.description).toBe("A global skill from ~/.claude/skills for testing.")
        expect(skill!.location).toContain(path.join(".claude", "skills", "global-test-skill", "SKILL.md"))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("returns empty array when no skills exist", async () => {
  await using tmp = await tmpdir({ git: true })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(
        skills.find(
          (s) =>
            s.location.startsWith(path.join(tmp.path, ".opencode")) ||
            s.location.startsWith(path.join(tmp.path, ".claude")) ||
            s.location.startsWith(path.join(tmp.path, ".agents")),
        ),
      ).toBeUndefined()
    },
  })
})

test("builtinRoots falls back to import.meta.url when baseDir is missing", () => {
  const roots = Skill.builtinRoots(undefined)
  expect(roots.length).toBeGreaterThanOrEqual(2)
  for (const root of roots) {
    expect(typeof root).toBe("string")
    expect(root.endsWith(path.join("skills"))).toBe(true)
  }
})

test("discovers skills from .agents/skills/ directory", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const agentSkill = skills.find((s) => s.name === "agent-skill")
      expect(agentSkill).toBeDefined()
      expect(agentSkill!.location).toContain(path.join(".agents", "skills", "agent-skill", "SKILL.md"))
    },
  })
})

test("discovers global skills from ~/.agents/skills/ directory", async () => {
  await using tmp = await tmpdir({ git: true })

  const originalHome = process.env.OPENCODE_TEST_HOME
  process.env.OPENCODE_TEST_HOME = tmp.path

  try {
    const skillDir = path.join(tmp.path, ".agents", "skills", "global-agent-skill")
    await fs.mkdir(skillDir, { recursive: true })
    await Bun.write(
      path.join(skillDir, "SKILL.md"),
      `---
name: global-agent-skill
description: A global skill from ~/.agents/skills for testing.
---

# Global Agent Skill

This skill is loaded from the global home directory.
`,
    )

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const skill = skills.find((item) => item.name === "global-agent-skill")
        expect(skill).toBeDefined()
        expect(skill!.description).toBe("A global skill from ~/.agents/skills for testing.")
        expect(skill!.location).toContain(path.join(".agents", "skills", "global-agent-skill", "SKILL.md"))
      },
    })
  } finally {
    process.env.OPENCODE_TEST_HOME = originalHome
  }
})

test("discovers skills from both .claude/skills/ and .agents/skills/", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Bun.write(
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
      await Bun.write(
        path.join(agentDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      expect(skills.find((s) => s.name === "claude-skill")).toBeDefined()
      expect(skills.find((s) => s.name === "agent-skill")).toBeDefined()
    },
  })
})

test("properly resolves directories that skills live in", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const opencodeSkillDir = path.join(dir, ".opencode", "skill", "agent-skill")
      const opencodeSkillsDir = path.join(dir, ".opencode", "skills", "agent-skill")
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      await Bun.write(
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
      await Bun.write(
        path.join(agentDir, "SKILL.md"),
        `---
name: agent-skill
description: A skill in the .agents/skills directory.
---

# Agent Skill
`,
      )
      await Bun.write(
        path.join(opencodeSkillDir, "SKILL.md"),
        `---
name: opencode-skill
description: A skill in the .opencode/skill directory.
---

# OpenCode Skill
`,
      )
      await Bun.write(
        path.join(opencodeSkillsDir, "SKILL.md"),
        `---
name: opencode-skill
description: A skill in the .opencode/skills directory.
---

# OpenCode Skill
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const dirs = await Skill.dirs()
      expect(dirs).toContain(path.join(tmp.path, ".opencode", "skill", "agent-skill"))
      expect(dirs).toContain(path.join(tmp.path, ".opencode", "skills", "agent-skill"))
      expect(dirs).toContain(path.join(tmp.path, ".claude", "skills", "claude-skill"))
      expect(dirs).toContain(path.join(tmp.path, ".agents", "skills", "agent-skill"))
    },
  })
})

test("discovers bundled skills from process.resourcesPath", async () => {
  await using tmp = await tmpdir({ git: true })

  const resourcesDir = path.join(tmp.path, "resources")
  const original = processWithResourcesPath.resourcesPath
  await createBundledSkill(resourcesDir, "packaged-only-skill", "A bundled packaged skill.")
  Object.defineProperty(process, "resourcesPath", { value: resourcesDir, configurable: true })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const bundled = skills.find((item) => item.name === "packaged-only-skill")
        expect(bundled).toBeDefined()
        expect(bundled!.description).toBe("A bundled packaged skill.")
        expect(bundled!.location).toContain(path.join("skills", "packaged-only-skill", "SKILL.md"))
      },
    })
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: original, configurable: true })
  }
})

test("discovers bundled skills from the repo skills directory in dev", async () => {
  await using tmp = await tmpdir({ git: true })

  const original = processWithResourcesPath.resourcesPath
  Object.defineProperty(process, "resourcesPath", { value: undefined, configurable: true })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.find((item) => item.name === "document-processing")).toBeDefined()
        expect(skills.find((item) => item.name === "data-analysis")).toBeDefined()
        expect(skills.find((item) => item.name === "writing-assistant")).toBeDefined()
      },
    })
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: original, configurable: true })
  }
})

test("returns bundled skill roots for source and dist layouts", () => {
  const sourceRoots = Skill.builtinRoots("/repo/packages/opencode/src/skill")
  expect(sourceRoots).toContain("/repo/skills")

  const distRoots = Skill.builtinRoots("/repo/packages/opencode/dist/node/skill")
  expect(distRoots).toContain("/repo/skills")
})

test("bundled productivity skills enforce clarify-first workflow and locale guidance", async () => {
  await using tmp = await tmpdir({ git: true })

  const original = processWithResourcesPath.resourcesPath
  Object.defineProperty(process, "resourcesPath", { value: undefined, configurable: true })

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        const getContent = (name: string) => skills.find((item) => item.name === name)?.content ?? ""

        const assertSharedStructure = (content: string) => {
          expect(content).toContain("<GATE>")
          expect(content).toContain("## Workflow")
          expect(content).toContain("1. **Clarify**")
          expect(content).toContain("2. **Execute**")
          expect(content).toContain("3. **Verify**")
          expect(content).toContain("## Step 1: Clarify")
          expect(content).toContain("## Step 2: Execute")
          expect(content).toContain("## Step 3: Verify")
          expect(content).toContain("## Language")
          expect(content).toContain('Reply in the user\'s locale (shown in system environment as "User locale").')
          // Skills should name the question tool behavior without embedding raw schemas.
          expect(content).not.toContain("```json")
          expect(content).toContain("`question` tool")
          expect(content).toContain("typically 2-4")
          expect(content).toContain("ask fewer when only one material gap is missing")
          expect(content).toContain("recommended answer")
          expect(content).toContain("Do not ask obvious questions")
          expect(content).toContain("Stop asking")
          expect(content).toContain("Before asking, use this decision rule")
          expect(content).toContain("**Must ask**")
          expect(content).toContain("**Use a recommended default and continue**")
          expect(content).toContain("**Ask one multiple-choice question**")
        }

        const documentProcessing = getContent("document-processing")
        assertSharedStructure(documentProcessing)
        expect(documentProcessing).toContain("**Task type**")
        expect(documentProcessing).toContain("**Source**")
        expect(documentProcessing).toContain("**Constraints**")
        expect(documentProcessing).toContain("**Success check**")

        const dataAnalysis = getContent("data-analysis")
        assertSharedStructure(dataAnalysis)
        expect(dataAnalysis).toContain("**Data source**")
        expect(dataAnalysis).toContain("**Output**")
        expect(dataAnalysis).toContain("**Business question**")
        expect(dataAnalysis).toContain("**Decision use**")

        const writingAssistant = getContent("writing-assistant")
        assertSharedStructure(writingAssistant)
        expect(writingAssistant).toContain("**Content type**")
        expect(writingAssistant).toContain("**Tone**")
        expect(writingAssistant).toContain("**Key points**")
        expect(writingAssistant).toContain("**Success check**")
        expect(writingAssistant).toContain("wait for their next message")
      },
    })
  } finally {
    Object.defineProperty(process, "resourcesPath", { value: original, configurable: true })
  }
})
