import { render } from "solid-js/web"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { LanguageProvider } from "@/context/language"
import { type Platform, PlatformProvider } from "@/context/platform"
import { SessionPermissionContent } from "@/pages/session/composer/session-permission-dock"

const platform: Platform = {
  platform: "web",
  openLink: () => {},
  restart: async () => {},
  back: () => {},
  forward: () => {},
  notify: async () => {},
}

function deleteRequest(input: { id: string; title: string }): PermissionRequest {
  return {
    id: `perm_${input.id}`,
    sessionID: "ses_permission_snap",
    permission: "automate_manage",
    patterns: [input.id],
    always: [],
    metadata: { action: "delete", id: input.id, title: input.title },
  }
}

const persistableRequest: PermissionRequest = {
  id: "perm_bash_echo",
  sessionID: "ses_permission_snap",
  permission: "bash",
  patterns: ["echo ok"],
  always: ["echo ok"],
  metadata: {},
}

function Block(props: { snap: string; request: PermissionRequest }) {
  return (
    <div data-snap={props.snap} style={{ width: "640px" }}>
      <SessionPermissionContent request={props.request} responding={false} onDecide={() => {}} />
    </div>
  )
}

function PermissionDockFixture() {
  return (
    <PlatformProvider value={platform}>
      <LanguageProvider locale="en">
        <div style={{ display: "grid", gap: "20px", padding: "24px", background: "var(--bg-base)" }}>
          <Block snap="delete-once" request={deleteRequest({ id: "aut_daily", title: "Daily repo brief" })} />
          <Block snap="persistable" request={persistableRequest} />
        </div>
      </LanguageProvider>
    </PlatformProvider>
  )
}

export function mountPermissionDockFixture(root: HTMLElement) {
  render(() => <PermissionDockFixture />, root)
}
