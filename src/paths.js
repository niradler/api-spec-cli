import { existsSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const GLOBAL_DIR = join(homedir(), ".spec-cli");

export function migrateLegacyHome(home = homedir()) {
  const legacy = join(home, "spec-cli-config");
  const destination = join(home, ".spec-cli");
  try {
    if (existsSync(legacy) && !existsSync(destination)) renameSync(legacy, destination);
  } catch (error) {
    process.stderr.write(
      `warning: Could not migrate spec-cli-config to .spec-cli (${error.code}).\n`
    );
  }
}
