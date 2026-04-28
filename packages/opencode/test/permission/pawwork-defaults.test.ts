import { afterEach, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

test("build agent uses PawWork permission defaults", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const build = await Agent.get("build")

      expect(build).toBeDefined()
      expect(Permission.evaluate("read", "notes.txt", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("edit", "notes.txt", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("external_directory", "/tmp/outside", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "ls -la", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "git status", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "chmod +x script.sh", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "kill 12345", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("bash", "dd if=/dev/zero of=disk.img", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "mkfs.ext4 /dev/sdb1", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rm file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rmdir folder", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "unlink file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "find . -delete", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "Remove-Item file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "del file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "erase file.txt", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "rd folder", build!.permission).action).toBe("deny")
      expect(Permission.evaluate("bash", "sudo rm -rf /", build!.permission).action).toBe("ask")
      expect(Permission.evaluate("doom_loop", "*", build!.permission).action).toBe("ask")
      expect(Permission.evaluate("question", "*", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("plan_enter", "*", build!.permission).action).toBe("allow")
      expect(Permission.evaluate("plan_exit", "*", build!.permission).action).toBe("deny")
    },
  })
})
