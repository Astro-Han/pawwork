import { base64Encode } from "@opencode-ai/util/encode"
import type { PawworkSkillName } from "./pawwork-skill-meta"
import { buildSkillSessionCommandInput } from "./session-new-view-command"

export async function startPawworkSkillSession(input: {
  name: PawworkSkillName
  client: {
    session: {
      create: (input: { skill: PawworkSkillName }) => Promise<{ data?: { id: string } }>
      command: (input: ReturnType<typeof buildSkillSessionCommandInput>) => Promise<unknown>
      delete: (input: { sessionID: string }) => Promise<unknown>
    }
  }
  directory: string
  agent: string
  model: string
  variant?: string
  locale?: string
  promote: (directory: string, sessionID: string) => void
  navigate: (href: string) => void
  onSessionCreateFailed: () => never
}) {
  const created = await input.client.session.create({ skill: input.name }).then((res) => res.data)
  if (!created) input.onSessionCreateFailed()

  try {
    input.promote(input.directory, created.id)
    input.navigate(`/${base64Encode(input.directory)}/session/${created.id}`)

    await input.client.session.command(
      buildSkillSessionCommandInput({
        sessionID: created.id,
        command: input.name,
        agent: input.agent,
        model: input.model,
        variant: input.variant,
        locale: input.locale,
      }),
    )
  } catch (error) {
    await input.client.session.delete({ sessionID: created.id }).catch(() => undefined)
    input.navigate(`/${base64Encode(input.directory)}/session`)
    throw error
  }
}
