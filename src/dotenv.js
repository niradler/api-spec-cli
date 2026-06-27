import { existsSync, readFileSync } from "fs";
import { join } from "path";

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotenv(dir = process.cwd()) {
  if (process.env.SPEC_NO_DOTENV) return;
  const file = join(dir, ".env");
  if (!existsSync(file)) return;
  let parsed;
  try {
    parsed = parseEnv(readFileSync(file, "utf-8"));
  } catch {
    return;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) process.env[key] = value;
  }
}
