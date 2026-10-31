export { VERSION } from "./version.ts";

export { createSpecClient, paginateGrep } from "./client.ts";
export type {
  SpecClient,
  SpecClientOptions,
  SpecLoader,
  SpecSummary,
  SpecListOptions,
  AddResult,
  RefreshResult,
  GrepOptions,
  GrepGroup,
  GrepResult,
} from "./client.ts";

export { createToolCatalog, validateArguments, textResult, errorResult } from "./catalog.ts";
export type {
  ToolCatalog,
  ToolCatalogOptions,
  ToolScope,
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

export { executeOperation } from "./execute.ts";
export type {
  CallRequest,
  CallResult,
  OpenApiCallResult,
  GraphqlCallResult,
  McpCallResult,
} from "./execute.ts";

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

export { closeMcpClients, createMcpClient } from "./mcp-client.ts";
export type { McpConnectTarget } from "./mcp-client.ts";

export { matchGlob, matchFilter, applyToolFilter } from "./glob.ts";

export { enforcePolicy, findBlockingRule, loadRules, matchRule } from "./policy.ts";
export type { PolicyRule, PolicyPattern, PolicyContext, PolicyScope } from "./policy.ts";

export { setSpecHome, specHome } from "./paths.ts";
export { setCacheDir } from "./cache.ts";
export { setUsageDir } from "./usage.ts";
export { setTokenDir } from "./oauth/tokens.ts";
export { setPolicyDir, setPoliciesDir, setLocalPolicyFile } from "./policy.ts";
export { setResultsDir } from "./output.ts";

export type * from "./types.ts";
