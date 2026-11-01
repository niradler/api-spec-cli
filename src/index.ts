export { VERSION } from "./version.ts";

export { createSpecClient } from "./client.ts";
export type {
  SpecClient,
  SpecClientOptions,
  SpecLoader,
  SpecSummary,
  SpecListOptions,
  AddResult,
  RefreshResult,
  SearchOptions,
  SearchHit,
  SearchResult,
  ResourceReadOptions,
  PromptGetOptions,
} from "./client.ts";

export { createToolCatalog, validateArguments, textResult, errorResult } from "./catalog.ts";
export type {
  ToolCatalog,
  ToolCatalogOptions,
  ToolScope,
  SpecSelection,
  CatalogSearchOptions,
  CatalogTool,
  ToolDescription,
} from "./catalog.ts";

export {
  createGateway,
  createGatewayServer,
  handleMetaTool,
  metaTools,
  parseSelection,
  directToolName,
} from "./gateway.ts";
export type { GatewayMode, GatewaySelection, GatewayDependencies } from "./gateway.ts";
export { gatewayConfig, gatewayLogger, startGatewayHttp } from "./gateway-http.ts";
export type {
  GatewayConfig,
  GatewayLogger,
  GatewayHttp,
  GatewayHttpDependencies,
} from "./gateway-http.ts";

export {
  operations,
  operationId,
  findOperation,
  requireOperation,
  listOperations,
  grepOperations,
  describeOperation,
  listTypes,
  describeType,
} from "./operations.ts";
export type {
  SpecOperation,
  ListOptions,
  OperationSummary,
  OperationList,
  GrepMatch,
  SpecTypes,
} from "./operations.ts";

export { executeOperation, readResource, getPrompt } from "./execute.ts";
export type {
  CallRequest,
  CallResult,
  OpenApiCallResult,
  GraphqlCallResult,
  McpCallResult,
  McpResourceResult,
  McpPromptResult,
} from "./execute.ts";

export { listResources, listPrompts, resolveResourceUri, requirePrompt } from "./mcp-features.ts";
export type { ResourceList, PromptList } from "./mcp-features.ts";

export { operationQuery, operationSchema } from "./gateway-schema.ts";

export { loadSpec, resolveEntry, resolveConfig, withAuthFrom } from "./resolve.ts";
export type { ConfigOptions, ResolvedConfig } from "./resolve.ts";

export { assertSpecName, entryFromSource, resolvedEntry, sectionOf } from "./sources.ts";

export {
  SECTIONS,
  emptyRegistry,
  fileRegistryStore,
  memoryRegistryStore,
  allEntries,
  findEntry,
  getEntry,
  putEntry,
} from "./registry.ts";

export { closeMcpClients, createMcpClient, createMcpSession } from "./mcp-client.ts";
export type { McpConnectTarget, McpSession, McpSessionOptions } from "./mcp-client.ts";
export { McpAuthRequiredError } from "./oauth/provider.ts";

export { matchGlob, matchFilter, applyToolFilter } from "./glob.ts";

export { enforcePolicy, findBlockingRule, loadRules, matchRule } from "./policy.ts";
export type { PolicyRule, PolicyPattern, PolicyContext, PolicyScope } from "./policy.ts";

export { setSpecHome, specHome } from "./paths.ts";
export { setCacheDir } from "./cache.ts";
export { setUsageDir } from "./usage.ts";
export { setTokenDir } from "./oauth/tokens.ts";
export { setPolicyDir, setPoliciesDir, setLocalPolicyFile } from "./policy.ts";
export { setResultsDir } from "./output.ts";
export { setProjectDir } from "./store.ts";

export type * from "./types.ts";
