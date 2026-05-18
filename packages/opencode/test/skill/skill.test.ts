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

test("discovers skills without descriptions but hides them from formatted prompts", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const skillDir = path.join(dir, ".opencode", "skill", "manual-skill")
      await Bun.write(
        path.join(skillDir, "SKILL.md"),
        `---
name: manual-skill
---

# Manual Skill

Instructions here.
`,
      )
    },
  })

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const skills = await Skill.all()
      const item = skills.find((s) => s.name === "manual-skill")
      expect(item).toBeDefined()
      expect(item!.description).toBeUndefined()
      expect(Skill.fmt(skills, { verbose: false })).not.toContain("manual-skill")
      expect(Skill.fmt(skills, { verbose: true })).not.toContain("manual-skill")
      expect(Skill.fmt([item!], { verbose: false })).toBe("No skills are currently available.")
      expect(Skill.fmt([item!], { verbose: true })).toBe("No skills are currently available.")
    },
  })
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

test("discovers skills from .agents/skills/ only", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
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
        path.join(claudeDir, "SKILL.md"),
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
      expect(skills.find((s) => s.name === "agent-skill")).toBeDefined()
      expect(skills.find((s) => s.name === "claude-skill")).toBeUndefined()
    },
  })
})

test("Claude Code skills flag does not disable .agents/skills discovery", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
      const claudeDir = path.join(dir, ".claude", "skills", "claude-skill")
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
        path.join(claudeDir, "SKILL.md"),
        `---
name: claude-skill
description: A skill in the .claude/skills directory.
---

# Claude Skill
`,
      )
    },
  })

  const original = process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
  process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = "true"

  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const skills = await Skill.all()
        expect(skills.find((s) => s.name === "agent-skill")).toBeDefined()
        expect(skills.find((s) => s.name === "claude-skill")).toBeUndefined()
      },
    })
  } finally {
    if (original === undefined) delete process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS
    else process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = original
  }
})

test("properly resolves directories that skills live in", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (dir) => {
      const opencodeSkillDir = path.join(dir, ".opencode", "skill", "agent-skill")
      const opencodeSkillsDir = path.join(dir, ".opencode", "skills", "agent-skill")
      const agentDir = path.join(dir, ".agents", "skills", "agent-skill")
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
        // Positive: every vendored officecli/morph skill must be present. Missing entries
        // signal upstream layout drift or a broken sync that ships an incomplete bundle.
        const vendoredNames = [
          "morph-ppt",
          "morph-ppt-3d",
          "officecli-academic-paper",
          "officecli-data-dashboard",
          "officecli-docx",
          "officecli-financial-model",
          "officecli-pitch-deck",
          "officecli-pptx",
          "officecli-xlsx",
        ]
        for (const name of vendoredNames) {
          expect(skills.find((item) => item.name === name)).toBeDefined()
        }
        // Scope-drift guard: if a future sync silently vendors a new upstream skill matching
        // these prefixes (e.g. a hypothetical `officecli-photoshop`), this assertion fails so
        // the addition cannot land without an explicit update to vendoredNames.
        const vendoredPrefix = /^(officecli-|morph-ppt)/
        expect(skills.filter((item) => vendoredPrefix.test(item.name)).length).toBe(vendoredNames.length)
        // Negative: legacy three are gone (spec measurement: "旧的三个技能名在 model tool list 里完全消失")
        expect(skills.find((item) => item.name === "data-analysis")).toBeUndefined()
        expect(skills.find((item) => item.name === "document-processing")).toBeUndefined()
        expect(skills.find((item) => item.name === "writing-assistant")).toBeUndefined()
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
