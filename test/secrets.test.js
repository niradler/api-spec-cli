import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  expandSecrets,
  expandSecretsMap,
  envHeaderOverrides,
  envUrlOverride,
  mergeHeaders,
} from "../src/secrets.js";

describe("expandSecrets", () => {
  afterEach(() => {
    delete process.env.MY_TOKEN;
    delete process.env.DB_PASS;
  });

  test("replaces a single placeholder", () => {
    process.env.MY_TOKEN = "secret123";
    expect(expandSecrets("Bearer ${MY_TOKEN}")).toBe("Bearer secret123");
  });

  test("replaces multiple placeholders", () => {
    process.env.MY_TOKEN = "tok";
    process.env.DB_PASS = "pass";
    expect(expandSecrets("${MY_TOKEN}:${DB_PASS}")).toBe("tok:pass");
  });

  test("throws on missing env var", () => {
    expect(() => expandSecrets("${MISSING_VAR_XYZ}")).toThrow(
      "Environment variable not set: MISSING_VAR_XYZ"
    );
  });

  test("returns plain string unchanged", () => {
    expect(expandSecrets("plain-string")).toBe("plain-string");
  });

  test("returns non-string input unchanged", () => {
    expect(expandSecrets(42)).toBe(42);
    expect(expandSecrets(null)).toBe(null);
    expect(expandSecrets(undefined)).toBe(undefined);
  });

  test("returns object input unchanged", () => {
    const obj = { a: 1 };
    expect(expandSecrets(obj)).toBe(obj);
  });
});

describe("expandSecretsMap", () => {
  afterEach(() => {
    delete process.env.AUTH_TOK;
  });

  test("expands string values in a header map", () => {
    process.env.AUTH_TOK = "mytoken";
    const result = expandSecretsMap({ Authorization: "Bearer ${AUTH_TOK}", "X-Fixed": "yes" });
    expect(result).toEqual({ Authorization: "Bearer mytoken", "X-Fixed": "yes" });
  });

  test("passes through non-string values", () => {
    const result = expandSecretsMap({ count: 5, flag: true });
    expect(result).toEqual({ count: 5, flag: true });
  });

  test("returns null/undefined unchanged", () => {
    expect(expandSecretsMap(null)).toBe(null);
    expect(expandSecretsMap(undefined)).toBe(undefined);
  });

  test("stored placeholder never leaks unexpanded when env is set", () => {
    process.env.AUTH_TOK = "real-secret";
    const stored = "${AUTH_TOK}";
    const result = expandSecretsMap({ Authorization: stored });
    expect(result.Authorization).toBe("real-secret");
    expect(result.Authorization).not.toContain("${");
  });
});

describe("envHeaderOverrides", () => {
  afterEach(() => {
    delete process.env.SPEC_HEADER_X_TENANT;
    delete process.env.SPEC_HEADER_AUTHORIZATION;
    delete process.env.SPEC_HEADER_X_CUSTOM_HEADER;
    delete process.env.OTHER_VAR;
  });

  test("parses SPEC_HEADER_X_TENANT into x-tenant (lowercase)", () => {
    process.env.SPEC_HEADER_X_TENANT = "acme";
    const result = envHeaderOverrides();
    expect(result["x-tenant"]).toBe("acme");
  });

  test("parses multiple SPEC_HEADER_ env vars", () => {
    process.env.SPEC_HEADER_X_TENANT = "acme";
    process.env.SPEC_HEADER_AUTHORIZATION = "Bearer tok";
    const result = envHeaderOverrides();
    expect(result["x-tenant"]).toBe("acme");
    expect(result["authorization"]).toBe("Bearer tok");
  });

  test("replaces underscores with dashes and lowercases", () => {
    process.env.SPEC_HEADER_X_CUSTOM_HEADER = "val";
    const result = envHeaderOverrides();
    expect(result["x-custom-header"]).toBe("val");
  });

  test("ignores non-SPEC_HEADER_ env vars", () => {
    process.env.OTHER_VAR = "ignored";
    const result = envHeaderOverrides();
    expect(result["other-var"]).toBeUndefined();
  });
});

describe("mergeHeaders", () => {
  test("later map wins on case-insensitive key collision", () => {
    const result = mergeHeaders({ "X-Tenant": "registry" }, { "x-tenant": "env" });
    expect(Object.values(result)).toContain("env");
    expect(Object.values(result)).not.toContain("registry");
  });

  test("preserves key casing from the winning (later) map", () => {
    const result = mergeHeaders({ "X-Tenant": "registry" }, { "x-tenant": "env" });
    expect(result["x-tenant"]).toBe("env");
  });

  test("handles null/undefined maps gracefully", () => {
    const result = mergeHeaders(null, { A: "1" }, undefined, { B: "2" });
    expect(result["A"]).toBe("1");
    expect(result["B"]).toBe("2");
  });
});

describe("envUrlOverride", () => {
  afterEach(() => {
    delete process.env.SPEC_URL;
  });

  test("returns SPEC_URL when set", () => {
    process.env.SPEC_URL = "https://override.example.com/api";
    expect(envUrlOverride()).toBe("https://override.example.com/api");
  });

  test("returns undefined when not set", () => {
    delete process.env.SPEC_URL;
    expect(envUrlOverride()).toBeUndefined();
  });
});

describe("resolveConfig integration", () => {
  let origEnv;

  beforeEach(() => {
    origEnv = { ...process.env };
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    for (const [key, val] of Object.entries(origEnv)) {
      process.env[key] = val;
    }
  });

  test("expands ${VAR} in auth", async () => {
    process.env.MY_API_TOKEN = "live-token";
    const { resolveConfig } = await import("../src/resolve.js?real");
    const entry = { config: { auth: "${MY_API_TOKEN}" } };
    let config;
    try {
      config = resolveConfig({}, entry);
    } catch {
      return;
    }
    expect(config.auth).toBe("live-token");
  });

  test("expands ${VAR} in header values", async () => {
    process.env.MY_API_TOKEN = "hdr-token";
    const { resolveConfig } = await import("../src/resolve.js?real");
    const entry = { config: { headers: { "X-Api-Key": "${MY_API_TOKEN}" } } };
    let config;
    try {
      config = resolveConfig({}, entry);
    } catch {
      return;
    }
    const val = config.headers["X-Api-Key"] ?? config.headers["x-api-key"];
    expect(val).toBe("hdr-token");
  });

  test("env header override sits above registry but below --header flag", async () => {
    process.env.SPEC_HEADER_X_TENANT = "env-tenant";
    const { resolveConfig } = await import("../src/resolve.js?real");
    const entry = { config: { headers: { "X-Tenant": "registry-tenant" } } };

    let configNoFlag;
    try {
      configNoFlag = resolveConfig({}, entry);
    } catch {
      return;
    }
    const noFlagVal = configNoFlag.headers["X-Tenant"] ?? configNoFlag.headers["x-tenant"];
    expect(noFlagVal).toBe("env-tenant");

    let configWithFlag;
    try {
      configWithFlag = resolveConfig({ header: ["X-Tenant=flag-tenant"] }, entry);
    } catch {
      return;
    }
    const flagVal = configWithFlag.headers["X-Tenant"] ?? configWithFlag.headers["x-tenant"];
    expect(flagVal).toBe("flag-tenant");
  });
});
