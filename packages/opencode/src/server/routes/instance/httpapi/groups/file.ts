import { Ripgrep } from "@/file/ripgrep"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { WorkspaceRoutingQuery } from "./common"

const FileQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  path: Schema.String,
})

const FindTextQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  pattern: Schema.String,
})

const FindFileQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  query: Schema.String,
  dirs: Schema.optionalKey(Schema.Literals(["true", "false"])),
  type: Schema.optionalKey(Schema.Literals(["file", "directory"])),
  limit: Schema.optionalKey(
    Schema.NumberFromString.pipe(
      Schema.check(Schema.isInt()),
      Schema.check(Schema.isGreaterThanOrEqualTo(1)),
      Schema.check(Schema.isLessThanOrEqualTo(200)),
    ),
  ),
})

const FindSymbolQuery = Schema.Struct({
  ...WorkspaceRoutingQuery.fields,
  query: Schema.String,
})

const FileNode = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  absolute: Schema.String,
  type: Schema.Literals(["file", "directory"]),
  ignored: Schema.Boolean,
})

const FileContent = Schema.Struct({
  type: Schema.Literals(["text", "binary"]),
  content: Schema.String,
  diff: Schema.optionalKey(Schema.String),
  patch: Schema.optionalKey(Schema.Any),
  encoding: Schema.optionalKey(Schema.Literal("base64")),
  mimeType: Schema.optionalKey(Schema.String),
})

const FileStatus = Schema.Struct({
  path: Schema.String,
  added: Schema.Number,
  removed: Schema.Number,
  status: Schema.Literals(["added", "deleted", "modified"]),
})

export const FileApi = HttpApi.make("file")
  .add(
    HttpApiGroup.make("file")
      .add(
        HttpApiEndpoint.get("findText", "/find", {
          query: FindTextQuery,
          success: Schema.Struct({
            items: Schema.Array(Ripgrep.SearchMatch),
            partial: Schema.Boolean,
            partialReason: Schema.optionalKey(Schema.Literals(["invalid_pattern", "partial_io"])),
          }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.text",
            summary: "Find text",
            description: "Search for text patterns across files in the project using ripgrep.",
          }),
        ),
        HttpApiEndpoint.get("findFile", "/find/file", {
          query: FindFileQuery,
          success: Schema.Array(Schema.String),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.files",
            summary: "Find files",
            description: "Search for files or directories by name or pattern in the project directory.",
          }),
        ),
        HttpApiEndpoint.get("findSymbol", "/find/symbol", {
          query: FindSymbolQuery,
          success: Schema.Array(Schema.Any),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "find.symbols",
            summary: "Find symbols",
            description: "Search for workspace symbols like functions, classes, and variables using LSP.",
          }),
        ),
        HttpApiEndpoint.get("list", "/file", {
          query: FileQuery,
          success: Schema.Array(FileNode),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.list",
            summary: "List files",
            description: "List files and directories in a specified path.",
          }),
        ),
        HttpApiEndpoint.get("content", "/file/content", {
          query: FileQuery,
          success: FileContent,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.read",
            summary: "Read file",
            description: "Read the content of a specified file.",
          }),
        ),
        HttpApiEndpoint.get("status", "/file/status", {
          query: WorkspaceRoutingQuery,
          success: Schema.Array(FileStatus),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "file.status",
            summary: "Get file status",
            description: "Get the git status of all files in the project.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "file",
          description: "HttpApi file routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode file HttpApi",
      version: "0.0.1",
      description: "HttpApi surface for file routes.",
    }),
  )
