import { homedir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { parseArgs } from "../args.js";
import { out } from "../output.js";

const SKILL_NAME = "api-spec-cli";
const BUNDLED = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md");

function installDir() {
  return join(homedir(), ".claude", "skills", SKILL_NAME);
}

export async function skillCmd(args) {
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
