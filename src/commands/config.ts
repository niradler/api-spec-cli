import { out } from "../output.ts";
import { getConfig, setConfig } from "../store.ts";

type Raw = any;

export async function configCmd(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "get" || sub === "show") {
    const key = args[1];
    const config = getConfig();
    if (key) {
      out({ [key]: getNestedValue(config, key) });
    } else {
      out(config);
    }
    return;
  }

  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || value === undefined) throw new Error("Usage: spec config set <key> <value>");

    const config = getConfig();
    setNestedValue(config, key, value);
    setConfig(config);
    out({ ok: true, [key]: value });
    return;
  }

  if (sub === "unset") {
    const key = args[1];
    if (!key) throw new Error("Usage: spec config unset <key>");

    const config = getConfig();
    deleteNestedValue(config, key);
    setConfig(config);
    out({ ok: true, deleted: key });
    return;
  }

  throw new Error(`Unknown config subcommand: ${sub}. Use: get, set, unset`);
}

function configKeyParts(key: string): string[] {
  const parts = key.split(".");
  if (parts.some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))) {
    throw new Error("Invalid config key.");
  }
  return parts;
}

function setNestedValue(obj: Raw, key: string, value: unknown): void {
  const parts = configKeyParts(key);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      !Object.hasOwn(current, parts[i]) ||
      current[parts[i]] === null ||
      typeof current[parts[i]] !== "object"
    ) {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function getNestedValue(obj: Raw, key: string): unknown {
  const parts = configKeyParts(key);
  let current = obj;
  for (const part of parts) {
    if (current == null) return undefined;
    current = current[part];
  }
  return current;
}

function deleteNestedValue(obj: Raw, key: string): void {
  const parts = configKeyParts(key);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current == null) return;
    current = current[parts[i]];
  }
  if (current != null) delete current[parts[parts.length - 1]];
}
