import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { DataProvider } from "../../src/context/data"
import { FileComponentProvider } from "../../src/context/file"
import { ToolRegistry, type ToolProps } from "../../src/components/message-part/registry"
import "../../src/components/message-part/tools/apply-patch"

type PatchFile = {
  filePath: string
  relativePath: string
  type: "add" | "update" | "delete" | "move"
  before?: string
  after?: string
  additions?: number
  deletions?: number
}

function FileDiff() {
  return <div data-testid="apply-patch-file-diff-rendered" />
}

export function patchFile(path = "src/example.ts"): PatchFile {
  return {
    filePath: path,
    relativePath: path,
    type: "update",
    before: "export const value = 1\n",
    after: "export const value = 2\n",
    additions: 1,
    deletions: 1,
  }
}

export function mountApplyPatchTool(initialFiles: PatchFile[]) {
  const ApplyPatchTool = ToolRegistry.render("apply_patch")
  if (!ApplyPatchTool) throw new Error("apply_patch tool is not registered")

  const host = document.createElement("div")
  document.body.append(host)
  const [files, setFiles] = createSignal<PatchFile[]>(initialFiles)
  const props = (): ToolProps => ({
    input: {},
    metadata: { files: files() },
    tool: "apply_patch",
    status: "running",
    defaultOpen: true,
    stateKey: "tool:apply-patch-stability-test",
  })

  const disposeRoot = render(
    () => (
      <DataProvider
        data={{ session: [], session_status: {}, turn_change_aggregate: {}, message: {}, part: {} }}
        directory="/project"
      >
        <FileComponentProvider component={FileDiff}>
          <ApplyPatchTool {...props()} />
        </FileComponentProvider>
      </DataProvider>
    ),
    host,
  )

  return {
    host,
    setFiles,
    collapsible: () => host.querySelector('[data-component="collapsible"]') as HTMLElement | null,
    content: () => host.querySelector('[data-slot="collapsible-content"]') as HTMLElement | null,
    dispose: () => {
      disposeRoot()
      host.remove()
    },
  }
}
