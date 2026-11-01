import { execFile, type ExecFileOptions } from "node:child_process";

type Launcher = (
  file: string,
  args: string[],
  options: ExecFileOptions,
  callback: (error: Error | null) => void
) => unknown;

export function assertHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${label} '${value}'.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error(`${label} must use HTTP or HTTPS.`);
  return url;
}

export function openBrowser(
  value: string,
  {
    platform = process.platform,
    launch = execFile as Launcher,
  }: { platform?: NodeJS.Platform; launch?: Launcher } = {}
): void {
  const url = assertHttpUrl(value, "OAuth authorization URL");

  const options: ExecFileOptions = { windowsHide: true, timeout: 15000 };
  const onError = (error: Error | null) => {
    if (error)
      process.stderr.write(
        "warning: Could not open browser. Open the authorization URL manually.\n"
      );
  };
  if (platform === "win32") {
    launch(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:SPEC_AUTH_URL"],
      { ...options, env: { ...process.env, SPEC_AUTH_URL: url.href } },
      onError
    );
  } else {
    launch(platform === "darwin" ? "open" : "xdg-open", [url.href], options, onError);
  }
}
