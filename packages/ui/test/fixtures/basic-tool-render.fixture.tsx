import { render } from "solid-js/web"
import { BasicTool } from "../../src/components/basic-tool"

function Details(props: { onRender: () => void }) {
  props.onRender()
  return <span data-testid="basic-tool-details">details</span>
}

export function mountBasicTool(props: { defaultOpen?: boolean; defer?: boolean; stateKey?: string }) {
  let detailsRenderCount = 0
  const host = document.createElement("div")
  document.body.append(host)

  const disposeRoot = render(
    () => (
      <BasicTool
        icon="mcp"
        trigger={{ title: "Test tool" }}
        defaultOpen={props.defaultOpen}
        defer={props.defer}
        stateKey={props.stateKey}
      >
        <Details onRender={() => detailsRenderCount++} />
      </BasicTool>
    ),
    host,
  )

  return {
    host,
    detailsRenderCount: () => detailsRenderCount,
    details: () => host.querySelector("[data-testid='basic-tool-details']"),
    trigger: () => host.querySelector("[data-slot='collapsible-trigger']") as HTMLElement | null,
    dispose: () => {
      disposeRoot()
      host.remove()
    },
  }
}
