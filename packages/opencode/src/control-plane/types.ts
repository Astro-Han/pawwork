import z from "zod"
import { ProjectID } from "@/project/schema"
import { WorkspaceID } from "./schema"

export const WorkspaceInfo = z.object({
  id: WorkspaceID.zod,
  type: z.string(),
  branch: z.string().nullable(),
  name: z.string().nullable(),
  directory: z.string().nullable(),
  extra: z.unknown().nullable(),
  projectID: ProjectID.zod,
})
export type WorkspaceInfo = z.infer<typeof WorkspaceInfo>

export type Target =
  | {
      type: "local"
      directory: string
    }
  | {
      type: "remote"
      url: string | URL
      headers?: HeadersInit
    }

export type Adaptor = {
  auth?: {
    providers: string[]
  }
  configure(input: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  // from is reserved for future workspace copy flows; core does not pass it today.
  create(config: WorkspaceInfo, env?: Record<string, string>, from?: WorkspaceInfo): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  target(config: WorkspaceInfo): Target | Promise<Target>
}
