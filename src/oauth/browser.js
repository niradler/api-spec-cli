import { execFile } from "child_process";

export function openBrowser(value, { platform = process.platform, launch = execFile } = {}) {
  const url = new URL(value);
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error("OAuth authorization URL must use HTTP or HTTPS.");
  }

  const options = { windowsHide: true, timeout: 15000 };
  const onError = (error) => {
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
