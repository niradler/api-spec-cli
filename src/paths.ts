import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

let homeOverride: string | undefined;

export function setSpecHome(dir: string | undefined): void {
  homeOverride = dir;
}

export function specHome(): string {
  return homeOverride || process.env.SPEC_HOME || join(homedir(), ".spec-cli");
}

export function migrateLegacyHome(home = homedir()): void {
  const legacy = join(home, "spec-cli-config");
  const destination = join(home, ".spec-cli");
  try {
    if (existsSync(legacy) && !existsSync(destination)) renameSync(legacy, destination);
  } catch (error) {
    process.stderr.write(
      `warning: Could not migrate spec-cli-config to .spec-cli (${(error as NodeJS.ErrnoException).code}).\n`
    );
  }
}
