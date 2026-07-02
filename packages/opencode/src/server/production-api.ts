import { HttpApi } from "effect/unstable/httpapi"
import { AutomationApi } from "./routes/instance/httpapi/groups/automation"
import { ConfigApi } from "./routes/instance/httpapi/groups/config"
import { ControlApi } from "./routes/instance/httpapi/groups/control"
import { ExperimentalApi } from "./routes/instance/httpapi/groups/experimental"
import { ExternalResultApi } from "./routes/instance/httpapi/groups/external-result"
import { FileApi } from "./routes/instance/httpapi/groups/file"
import { GlobalApi } from "./routes/instance/httpapi/groups/global"
import { McpApi } from "./routes/instance/httpapi/groups/mcp"
import { MemoryApi } from "./routes/instance/httpapi/groups/memory"
import { PermissionApi } from "./routes/instance/httpapi/groups/permission"
import { ProjectApi } from "./routes/instance/httpapi/groups/project"
import { ProviderApi } from "./routes/instance/httpapi/groups/provider"
import { PtyApi } from "./routes/instance/httpapi/groups/pty"
import { RootApi } from "./routes/instance/httpapi/groups/root"
import { SessionApi } from "./routes/instance/httpapi/groups/session"
import { WorkspaceApi } from "./routes/instance/httpapi/groups/workspace"

export const ProductionApi = HttpApi.make("production")
  .addHttpApi(ControlApi)
  .addHttpApi(GlobalApi)
  .addHttpApi(WorkspaceApi)
  .addHttpApi(RootApi)
  .addHttpApi(ProjectApi)
  .addHttpApi(PtyApi)
  .addHttpApi(ConfigApi)
  .addHttpApi(ExperimentalApi)
  .addHttpApi(SessionApi)
  .addHttpApi(PermissionApi)
  .addHttpApi(ExternalResultApi)
  .addHttpApi(ProviderApi)
  .addHttpApi(MemoryApi)
  .addHttpApi(AutomationApi)
  .addHttpApi(FileApi)
  .addHttpApi(McpApi)
