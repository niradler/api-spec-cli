import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "../args.ts";
import { out } from "../output.ts";

const SKILL_NAME = "spec-cli";

function isStandaloneBinary(): boolean {
  const runtime = globalThis as { Bun?: { isStandaloneExecutable?: boolean } };
  return runtime.Bun?.isStandaloneExecutable === true;
}
const BUNDLED = join(
  dirname(fileURLToPath(import.meta.url)),
  ...(isStandaloneBinary() ? [] : [".."]),
  "skill",
  "SKILL.md"
);

function installDir(): string {
  return join(homedir(), ".claude", "skills", SKILL_NAME);
}

export async function skillCmd(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args);

  if (positional[0] === "path" || "path" in flags) {
    out({ skill: SKILL_NAME, path: BUNDLED });
    return;
  }

  if (positional[0] === "install" || "install" in flags) {
    if (!existsSync(BUNDLED)) throw new Error(`Bundled skill not found at ${BUNDLED}`);
    const dest = join(installDir(), "SKILL.md");
    mkdirSync(installDir(), { recursive: true });
    writeFileSync(dest, readFileSync(BUNDLED, "utf-8"));
    out({ installed: true, skill: SKILL_NAME, path: dest });
    return;
  }

  out({
    skill: SKILL_NAME,
    usage: {
      install: "spec skill install    Copy the skill into ~/.claude/skills/",
      path: "spec skill path       Print the bundled SKILL.md location",
    },
    bundled: BUNDLED,
  });
}
