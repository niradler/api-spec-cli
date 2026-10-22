import { describe, expect, test } from "bun:test";
import { openBrowser } from "../src/oauth/browser.js";

describe("OAuth browser launch", () => {
  test.each(["linux", "darwin", "win32"])(
    "should keep URL data out of shell code on %s",
    (platform) => {
      const value = "https://auth.example/authorize?state=$(touch%20bad)&other=`whoami`";
      let captured;
      openBrowser(value, {
        platform,
        launch: (...args) => {
          captured = args;
        },
      });
      const [command, args, options] = captured;
      expect(options.shell).toBeUndefined();
      expect(options.timeout).toBe(15000);
      if (platform === "win32") {
        expect(command).toBe("powershell.exe");
        expect(args.join(" ")).not.toContain("auth.example");
        expect(options.env.SPEC_AUTH_URL).toBe(new URL(value).href);
        expect(options.windowsHide).toBe(true);
      } else {
        expect(command).toBe(platform === "darwin" ? "open" : "xdg-open");
        expect(args).toEqual([new URL(value).href]);
      }
    }
  );

  test.each(["file:///tmp/payload", "javascript:alert(1)", "invalid"])(
    "should reject unsafe authorization URL %s",
    (url) => {
      let launched = false;
      expect(() =>
        openBrowser(url, {
          launch: () => {
            launched = true;
          },
        })
      ).toThrow();
      expect(launched).toBe(false);
    }
  );
});
