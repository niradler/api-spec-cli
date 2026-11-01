export type JsonObject = Record<string, unknown>;
export type StringMap = Record<string, string>;

export type JsonSchema = JsonObject;

export interface ToolFilter {
  allowedTools?: string[];
  disabledTools?: string[];
}

export interface HttpSpecConfig extends ToolFilter {
  baseUrl?: string | null;
  auth?: string | null;
  headers?: StringMap;
}

export type OAuthFlow = "browser" | "device" | "client_credentials";

export interface EntryBase {
  enabled: boolean;
  description?: string;
}

export interface OpenApiEntry extends EntryBase {
  type: "openapi";
  source: string;
  config: HttpSpecConfig;
}

export interface GraphqlEntry extends EntryBase {
  type: "graphql";
  source: string;
  config: HttpSpecConfig;
}

export interface McpStdioEntry extends EntryBase, ToolFilter {
  type: "stdio";
  command: string;
  args: string[];
  cwd?: string;
  env?: StringMap;
}

export interface McpRemoteEntry extends EntryBase, ToolFilter {
  type: "http" | "sse";
  url: string;
  headers?: StringMap;
  oauthFlow?: OAuthFlow;
  oauthClientId?: string;
  oauthCallbackPort?: number;
}

export type McpEntry = McpStdioEntry | McpRemoteEntry;
export type RegistryEntry = OpenApiEntry | GraphqlEntry | McpEntry;
export type RegistrySection = "mcp" | "openapi" | "graphql";

export interface Registry {
  mcp: Record<string, McpEntry>;
  openapi: Record<string, OpenApiEntry>;
  graphql: Record<string, GraphqlEntry>;
}

type Resolved<T, S extends RegistrySection> = T & { name?: string; _section: S };

export type ResolvedEntry =
  Resolved<OpenApiEntry, "openapi"> | Resolved<GraphqlEntry, "graphql"> | Resolved<McpEntry, "mcp">;

export type NamedEntry = ResolvedEntry & { name: string };

export interface RegistryStore {
  read(): Registry;
  write(registry: Registry): void;
}

interface SourceBase extends ToolFilter {
  description?: string;
}

export interface OpenApiSource extends SourceBase {
  type: "openapi";
  source: string;
  baseUrl?: string;
  auth?: string;
  headers?: StringMap;
}

export interface GraphqlSource extends SourceBase {
  type: "graphql";
  source: string;
  auth?: string;
  headers?: StringMap;
}

export interface McpRemoteSource extends SourceBase {
  type: "http" | "sse";
  url: string;
  auth?: string;
  headers?: StringMap;
  oauthFlow?: OAuthFlow;
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthCallbackPort?: number;
}

export interface McpStdioSource extends SourceBase {
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: StringMap;
}

export type SpecSource = OpenApiSource | GraphqlSource | McpRemoteSource | McpStdioSource;

export type SpecRef = string | SpecSource;

export interface OpenApiOperation {
  id: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  parameters: unknown[];
  requestBody: unknown;
  responses: JsonObject;
  tags: string[];
  deprecated: boolean;
}

export interface OpenApiSpec {
  type: "openapi";
  version: string;
  title: string | null;
  description: string | null;
  servers: { url: string }[];
  operations: OpenApiOperation[];
  components: JsonObject;
  raw: JsonObject;
}

export interface GraphqlTypeRef {
  kind: string;
  name: string | null;
  ofType?: GraphqlTypeRef | null;
}

export interface GraphqlInputValue {
  name: string;
  description?: string | null;
  type: GraphqlTypeRef;
  defaultValue?: string | null;
}

export interface GraphqlField {
  name: string;
  description?: string | null;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
  args?: GraphqlInputValue[];
  type: GraphqlTypeRef;
}

export interface GraphqlType {
  name: string;
  kind: string;
  description?: string | null;
  fields?: GraphqlField[] | null;
  inputFields?: GraphqlInputValue[] | null;
  enumValues?: { name: string; description?: string | null }[] | null;
}

export type GraphqlOperationKind = "query" | "mutation" | "subscription";

export interface GraphqlOperation {
  kind: GraphqlOperationKind;
  name: string;
  description: string | null;
  args: GraphqlInputValue[];
  returnType: string | null;
  isDeprecated?: boolean;
  deprecationReason?: string | null;
}

export interface GraphqlSpec {
  type: "graphql";
  title: string | null;
  endpoint: string;
  operations: GraphqlOperation[];
  types: GraphqlType[];
  raw: JsonObject;
}

export interface McpTool {
  name: string;
  description: string | null;
  inputSchema: JsonSchema | null;
}

export interface McpResource {
  uri: string;
  name: string;
  description: string | null;
  mimeType: string | null;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  description: string | null;
  mimeType: string | null;
}

export interface McpPromptArgument {
  name: string;
  description: string | null;
  required: boolean;
}

export interface McpPrompt {
  name: string;
  description: string | null;
  arguments: McpPromptArgument[];
}

export interface McpSpec {
  type: "mcp";
  title: string;
  transport: McpEntry["type"];
  url?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  tools: McpTool[];
  resources?: McpResource[];
  resourceTemplates?: McpResourceTemplate[];
  prompts?: McpPrompt[];
  featureErrors?: { resources?: string; prompts?: string };
}

export type SpecDocument = OpenApiSpec | GraphqlSpec | McpSpec;
export type SpecType = SpecDocument["type"];

export interface LoadedSpec {
  spec: SpecDocument;
  entry: ResolvedEntry;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}

export interface PageOptions {
  offset?: number;
  limit?: number;
}
