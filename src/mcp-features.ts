import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type {
  McpPrompt,
  McpResource,
  McpResourceTemplate,
  McpSpec,
  SpecDocument,
  StringMap,
} from "./types.ts";

export interface ResourceList {
  resources: McpResource[];
  templates: McpResourceTemplate[];
}

export interface PromptList {
  prompts: McpPrompt[];
}

export function requireMcpSpec(spec: SpecDocument, feature: "Resources" | "Prompts"): McpSpec {
  if (spec.type !== "mcp")
    throw new Error(`${feature} are only available for MCP specs (spec type: ${spec.type})`);
  return spec;
}

export function listResources(spec: SpecDocument): ResourceList {
  const mcp = requireMcpSpec(spec, "Resources");
  if (!mcp.resources && !mcp.resourceTemplates)
    throw new Error(`MCP server '${mcp.title}' does not expose resources`);
  return { resources: mcp.resources ?? [], templates: mcp.resourceTemplates ?? [] };
}

export function listPrompts(spec: SpecDocument): PromptList {
  const mcp = requireMcpSpec(spec, "Prompts");
  if (!mcp.prompts) throw new Error(`MCP server '${mcp.title}' does not expose prompts`);
  return { prompts: mcp.prompts };
}

function requiredTemplateVars(template: string): string[] {
  return [...template.matchAll(/\{([^}?&]+)\}/g)].flatMap((match) =>
    match[1]!
      .replace(/^[+#./;]/, "")
      .split(",")
      .map((name) => name.replace(/\*$|:\d+$/, ""))
  );
}

function expandTemplate(template: string, vars: StringMap): string {
  const missing = requiredTemplateVars(template).filter((name) => !(name in vars));
  if (missing.length > 0)
    throw new Error(
      `Missing resource template variables: ${missing.join(", ")}. Pass --var ${missing[0]}=<value>`
    );
  return new UriTemplate(template).expand(vars);
}

export function resolveResourceUri(
  spec: SpecDocument,
  target: string,
  vars: StringMap = {}
): string {
  const mcp = requireMcpSpec(spec, "Resources");
  const lower = target.toLowerCase();
  const resource = mcp.resources?.find((r) => r.uri === target || r.name.toLowerCase() === lower);
  if (resource) return resource.uri;
  const template = mcp.resourceTemplates?.find(
    (t) => t.uriTemplate === target || t.name.toLowerCase() === lower
  );
  if (template) return expandTemplate(template.uriTemplate, vars);
  if (UriTemplate.isTemplate(target)) return expandTemplate(target, vars);
  if (!/^[a-z][a-z\d+.-]*:/i.test(target))
    throw new Error(
      `Resource not found: ${target}. Run 'spec resources' to see available resources.`
    );
  return target;
}

export function requirePrompt(spec: SpecDocument, name: string): McpPrompt {
  const { prompts } = listPrompts(spec);
  const lower = name.toLowerCase();
  const prompt = prompts.find((p) => p.name.toLowerCase() === lower);
  if (!prompt)
    throw new Error(`Prompt not found: ${name}. Run 'spec prompts' to see available prompts.`);
  return prompt;
}

export function promptArguments(
  prompt: McpPrompt,
  args: Record<string, unknown>
): Record<string, string> {
  const values = Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    ])
  );
  const missing = prompt.arguments.filter((a) => a.required && !(a.name in values));
  if (missing.length > 0)
    throw new Error(
      `Missing required prompt arguments: ${missing.map((a) => a.name).join(", ")}. Pass --var ${missing[0]!.name}=<value>`
    );
  return values;
}
