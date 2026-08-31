import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let captured;
mock.module("../src/output.js", () => ({
  out: (data) => {
    captured = data;
  },
  err: (msg) => {
    captured = { error: msg };
  },
}));

import {
  matchRule,
  findBlockingRule,
  setPolicyDir,
  setLocalPolicyFile,
  setPoliciesDir,
  loadRules,
  enforcePolicy,
  globalPolicyPath,
  serverPolicyPath,
} from "../src/policy.js";
import { policyCmd } from "../src/commands/policy.js";

const TEST_DIR = join(tmpdir(), "spec-cli-test-policy-" + process.pid);
const LOCAL_FILE = join(TEST_DIR, "local-policy.json");

function ctx(overrides = {}) {
  return {
    spec: "k8s",
    tool: "restart",
    args: { pod_name: "prod-api" },
    ...overrides,
  };
}

describe("matchRule", () => {
  test("string tool is exact match via glob filter", () => {
    expect(matchRule({ tool: "restart" }, ctx())).toBe(true);
    expect(matchRule({ tool: "delete" }, ctx())).toBe(false);
  });

  test("tool glob matches", () => {
    expect(matchRule({ tool: "re*" }, ctx())).toBe(true);
    expect(matchRule({ tool: "delete_*" }, ctx())).toBe(false);
  });

  test("tool regex matches", () => {
    expect(matchRule({ tool: { regex: "^re.*" } }, ctx())).toBe(true);
    expect(matchRule({ tool: { regex: "^delete" } }, ctx())).toBe(false);
  });

  test("spec glob is optional and filters when set", () => {
    expect(matchRule({ spec: "k8s", tool: "restart" }, ctx())).toBe(true);
    expect(matchRule({ spec: "aws", tool: "restart" }, ctx())).toBe(false);
    expect(matchRule({ tool: "restart" }, ctx({ spec: undefined }))).toBe(true);
  });

  test("when prefix matches arg", () => {
    const rule = { tool: "restart", when: { pod_name: { prefix: "prod" } } };
    expect(matchRule(rule, ctx())).toBe(true);
    expect(matchRule(rule, ctx({ args: { pod_name: "staging-api" } }))).toBe(false);
  });

  test("when suffix matches arg", () => {
    const rule = { when: { pod_name: { suffix: "-api" } } };
    expect(matchRule(rule, ctx())).toBe(true);
    expect(matchRule(rule, ctx({ args: { pod_name: "prod-web" } }))).toBe(false);
  });

  test("when glob string matches arg", () => {
    const rule = { when: { pod_name: "prod*" } };
    expect(matchRule(rule, ctx())).toBe(true);
    expect(matchRule(rule, ctx({ args: { pod_name: "dev-api" } }))).toBe(false);
  });

  test("when regex matches arg", () => {
    const rule = { when: { pod_name: { regex: "^prod-" } } };
    expect(matchRule(rule, ctx())).toBe(true);
    expect(matchRule(rule, ctx({ args: { pod_name: "xprod-api" } }))).toBe(false);
  });

  test("when eq is case-insensitive", () => {
    const rule = { when: { pod_name: { eq: "PROD-API" } } };
    expect(matchRule(rule, ctx())).toBe(true);
  });

  test("when in matches any listed value", () => {
    const rule = { when: { env: { in: ["prod", "production"] } } };
    expect(matchRule(rule, ctx({ args: { env: "prod" } }))).toBe(true);
    expect(matchRule(rule, ctx({ args: { env: "dev" } }))).toBe(false);
  });

  test("when exists true requires the key", () => {
    const rule = { when: { pod_name: { exists: true } } };
    expect(matchRule(rule, ctx())).toBe(true);
    expect(matchRule(rule, ctx({ args: {} }))).toBe(false);
  });

  test("when exists false requires the key to be absent", () => {
    const rule = { when: { dry_run: { exists: false } } };
    expect(matchRule(rule, ctx({ args: {} }))).toBe(true);
    expect(matchRule(rule, ctx({ args: { dry_run: "1" } }))).toBe(false);
  });

  test("dotted when keys walk nested args", () => {
    const rule = { when: { "metadata.namespace": { prefix: "prod" } } };
    expect(matchRule(rule, ctx({ args: { metadata: { namespace: "prod-apps" } } }))).toBe(true);
    expect(matchRule(rule, ctx({ args: { metadata: { namespace: "dev" } } }))).toBe(false);
  });

  test("all when clauses must match", () => {
    const rule = {
      when: {
        pod_name: { prefix: "prod" },
        force: { eq: "true" },
      },
    };
    expect(matchRule(rule, ctx({ args: { pod_name: "prod-api", force: "true" } }))).toBe(true);
    expect(matchRule(rule, ctx({ args: { pod_name: "prod-api", force: "false" } }))).toBe(false);
  });

  test("empty rule matches any call", () => {
    expect(matchRule({}, ctx())).toBe(true);
  });
});

describe("findBlockingRule", () => {
  const rules = [
    {
      id: "no-prod-restart",
      effect: "block",
      tool: "restart",
      when: { pod_name: { prefix: "prod" } },
      message: "cannot restart prod pods",
    },
    { id: "no-deletes", effect: "block", tool: { regex: "^delete_.*" }, message: "no deletes" },
  ];

  test("returns the first matching block", () => {
    const hit = findBlockingRule(rules, ctx());
    expect(hit.id).toBe("no-prod-restart");
    expect(hit.message).toBe("cannot restart prod pods");
  });

  test("returns null when nothing matches", () => {
    expect(findBlockingRule(rules, ctx({ tool: "list", args: {} }))).toBeNull();
  });

  test("ignores non-block effects", () => {
    const mixed = [{ id: "allow-all", effect: "allow", tool: "restart" }, ...rules];
    expect(findBlockingRule(mixed, ctx()).id).toBe("no-prod-restart");
  });

  test("SPEC_NO_POLICY skips evaluation", () => {
    process.env.SPEC_NO_POLICY = "1";
    try {
      expect(findBlockingRule(rules, ctx())).toBeNull();
    } finally {
      delete process.env.SPEC_NO_POLICY;
    }
  });
});

describe("loadRules", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setPolicyDir(TEST_DIR);
    setLocalPolicyFile(LOCAL_FILE);
    setPoliciesDir(null);
    delete process.env.SPEC_NO_POLICY;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("missing files yield no rules", () => {
    expect(loadRules()).toEqual([]);
  });

  test("loads global policy.json and tags source", () => {
    writeFileSync(
      join(TEST_DIR, "policy.json"),
      JSON.stringify({
        rules: [{ id: "g1", effect: "block", tool: "restart", message: "no" }],
      })
    );
    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("g1");
    expect(rules[0].source).toBe("global");
  });

  test("accepts a bare array as the file body", () => {
    writeFileSync(
      join(TEST_DIR, "policy.json"),
      JSON.stringify([{ id: "g1", effect: "block", tool: "*" }])
    );
    expect(loadRules()[0].id).toBe("g1");
  });

  test("merges local rules with global", () => {
    writeFileSync(
      join(TEST_DIR, "policy.json"),
      JSON.stringify({ rules: [{ id: "g1", effect: "block", tool: "a" }] })
    );
    writeFileSync(
      LOCAL_FILE,
      JSON.stringify({ rules: [{ id: "l1", effect: "block", tool: "b" }] })
    );
    const ids = loadRules().map((r) => r.id);
    expect(ids).toEqual(["l1", "g1"]);
    expect(loadRules().find((r) => r.id === "l1").source).toBe("local");
  });

  test("loads policies/<spec>.json and defaults spec to the filename", () => {
    mkdirSync(join(TEST_DIR, "policies"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "policies", "k8s.json"),
      JSON.stringify({
        rules: [{ id: "no-restart", effect: "block", tool: "restart", message: "no" }],
      })
    );
    const rules = loadRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].id).toBe("no-restart");
    expect(rules[0].spec).toBe("k8s");
    expect(rules[0].source).toBe("server:k8s");
  });

  test("--policies-path overrides the per-spec folder", () => {
    const other = join(TEST_DIR, "alt-policies");
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, "petstore.json"),
      JSON.stringify({ rules: [{ id: "no-add", effect: "block", tool: "addPet" }] })
    );
    setPoliciesDir(other);
    const rules = loadRules();
    expect(rules[0].id).toBe("no-add");
    expect(rules[0].spec).toBe("petstore");
    expect(rules[0].source).toBe("server:petstore");
  });
});

describe("enforcePolicy", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    setPolicyDir(TEST_DIR);
    setLocalPolicyFile(LOCAL_FILE);
    setPoliciesDir(null);
    delete process.env.SPEC_NO_POLICY;
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("throws with message and rule id", () => {
    writeFileSync(
      join(TEST_DIR, "policy.json"),
      JSON.stringify({
        rules: [
          {
            id: "no-prod-restart",
            effect: "block",
            tool: "restart",
            when: { pod_name: { prefix: "prod" } },
            message: "cannot restart prod pods",
          },
        ],
      })
    );
    expect(() => enforcePolicy(ctx())).toThrow("blocked by policy: cannot restart prod pods");
    expect(() => enforcePolicy(ctx())).toThrow("rule: no-prod-restart");
    expect(() => enforcePolicy(ctx())).toThrow("source: global");
  });

  test("SPEC_NO_POLICY skips a corrupt policy file", () => {
    writeFileSync(join(TEST_DIR, "policy.json"), "{not json");
    process.env.SPEC_NO_POLICY = "1";
    try {
      expect(() => enforcePolicy(ctx())).not.toThrow();
    } finally {
      delete process.env.SPEC_NO_POLICY;
    }
  });

  test("allows when no rule matches", () => {
    writeFileSync(
      join(TEST_DIR, "policy.json"),
      JSON.stringify({
        rules: [
          {
            id: "no-prod-restart",
            effect: "block",
            tool: "restart",
            when: { pod_name: { prefix: "prod" } },
          },
        ],
      })
    );
    expect(() => enforcePolicy(ctx({ args: { pod_name: "dev-api" } }))).not.toThrow();
  });

  test("blocks a per-spec file rule when ctx.spec matches", () => {
    mkdirSync(join(TEST_DIR, "policies"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, "policies", "k8s.json"),
      JSON.stringify({
        rules: [{ id: "no-restart", effect: "block", tool: "restart", message: "k8s locked" }],
      })
    );
    expect(() => enforcePolicy(ctx())).toThrow("k8s locked");
    expect(() => enforcePolicy(ctx({ spec: "petstore" }))).not.toThrow();
  });
});

describe("spec policy CRUD", () => {
  beforeEach(() => {
    captured = null;
    mkdirSync(TEST_DIR, { recursive: true });
    setPolicyDir(TEST_DIR);
    setLocalPolicyFile(LOCAL_FILE);
    setPoliciesDir(null);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("list is empty when no file exists", async () => {
    await policyCmd([]);
    expect(captured.total).toBe(0);
    expect(captured.rules).toEqual([]);
  });

  test("add --data with a spec name writes the per-spec file", async () => {
    await policyCmd([
      "add",
      "--data",
      JSON.stringify({ id: "no-restart", spec: "k8s", tool: "restart" }),
    ]);
    expect(captured.source).toBe("server:k8s");
    expect(existsSync(serverPolicyPath("k8s"))).toBe(true);
    expect(existsSync(globalPolicyPath())).toBe(false);
  });

  test("add --policies-path writes under that folder", async () => {
    const other = join(TEST_DIR, "alt-policies");
    await policyCmd([
      "add",
      "--policies-path",
      other,
      "--id",
      "no-add",
      "--spec",
      "petstore",
      "--tool",
      "addPet",
    ]);
    expect(existsSync(join(other, "petstore.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(other, "petstore.json"), "utf-8")).rules[0].id).toBe(
      "no-add"
    );
  });

  test("add --data upserts a global rule", async () => {
    await policyCmd([
      "add",
      "--data",
      JSON.stringify({
        id: "no-prod-restart",
        tool: "restart",
        when: { pod_name: { prefix: "prod" } },
        message: "cannot restart prod pods",
      }),
    ]);
    expect(captured.ok).toBe(true);
    expect(captured.id).toBe("no-prod-restart");
    expect(captured.source).toBe("global");
    const stored = JSON.parse(readFileSync(globalPolicyPath(), "utf-8"));
    expect(stored.rules[0].id).toBe("no-prod-restart");
    expect(stored.rules[0].effect).toBe("block");
  });

  test("add with flags and --when", async () => {
    await policyCmd([
      "add",
      "--id",
      "no-deletes",
      "--tool",
      "delete_*",
      "--spec",
      "k8s",
      "--message",
      "no deletes",
      "--when",
      "force.eq=true",
    ]);
    expect(captured.source).toBe("server:k8s");
    const stored = JSON.parse(readFileSync(serverPolicyPath("k8s"), "utf-8"));
    expect(stored.rules[0]).toEqual({
      id: "no-deletes",
      effect: "block",
      spec: "k8s",
      tool: "delete_*",
      when: { force: { eq: "true" } },
      message: "no deletes",
    });
    expect(existsSync(globalPolicyPath())).toBe(false);
  });

  test("add --local writes the project file", async () => {
    await policyCmd(["add", "--local", "--id", "local-block", "--tool", "restart"]);
    expect(existsSync(LOCAL_FILE)).toBe(true);
    expect(JSON.parse(readFileSync(LOCAL_FILE, "utf-8")).rules[0].id).toBe("local-block");
    expect(existsSync(globalPolicyPath())).toBe(false);
  });

  test("add rejects a missing id", async () => {
    await expect(policyCmd(["add", "--tool", "restart"])).rejects.toThrow("id");
  });

  test("add rejects a rule with no matcher", async () => {
    await expect(policyCmd(["add", "--id", "oops"])).rejects.toThrow("at least one matcher");
  });

  test("add rejects an invalid regex", async () => {
    await expect(
      policyCmd(["add", "--data", JSON.stringify({ id: "bad", tool: { regex: "(" } })])
    ).rejects.toThrow("Invalid regex");
  });

  test("add rejects a duplicate unless upserting the same id", async () => {
    await policyCmd(["add", "--id", "r1", "--tool", "a"]);
    await policyCmd(["add", "--id", "r1", "--tool", "b", "--message", "updated"]);
    const stored = JSON.parse(readFileSync(globalPolicyPath(), "utf-8"));
    expect(stored.rules).toHaveLength(1);
    expect(stored.rules[0].tool).toBe("b");
    expect(stored.rules[0].message).toBe("updated");
  });

  test("list shows source and both files", async () => {
    await policyCmd(["add", "--id", "g1", "--tool", "a"]);
    await policyCmd(["add", "--local", "--id", "l1", "--tool", "b"]);
    await policyCmd(["list"]);
    expect(captured.total).toBe(2);
    expect(captured.rules.map((r) => r.id).sort()).toEqual(["g1", "l1"]);
  });

  test("show returns one rule", async () => {
    await policyCmd(["add", "--id", "g1", "--tool", "restart", "--message", "no"]);
    await policyCmd(["show", "g1"]);
    expect(captured.id).toBe("g1");
    expect(captured.tool).toBe("restart");
  });

  test("show throws when missing", async () => {
    await expect(policyCmd(["show", "nope"])).rejects.toThrow("No policy rule");
  });

  test("remove deletes by id", async () => {
    await policyCmd(["add", "--id", "g1", "--tool", "a"]);
    await policyCmd(["remove", "g1"]);
    expect(captured.ok).toBe(true);
    expect(JSON.parse(readFileSync(globalPolicyPath(), "utf-8")).rules).toEqual([]);
  });

  test("remove --local only touches the local file", async () => {
    await policyCmd(["add", "--id", "g1", "--tool", "a"]);
    await policyCmd(["add", "--local", "--id", "g1", "--tool", "b"]);
    await policyCmd(["remove", "g1", "--local"]);
    expect(JSON.parse(readFileSync(LOCAL_FILE, "utf-8")).rules).toEqual([]);
    expect(JSON.parse(readFileSync(globalPolicyPath(), "utf-8")).rules[0].id).toBe("g1");
  });

  test("clear empties the target file", async () => {
    await policyCmd(["add", "--id", "g1", "--tool", "a"]);
    await policyCmd(["clear"]);
    expect(JSON.parse(readFileSync(globalPolicyPath(), "utf-8")).rules).toEqual([]);
  });

  test("add with a spec glob stays in the global file", async () => {
    await policyCmd(["add", "--id", "any-k8s", "--spec", "k8s*", "--tool", "restart"]);
    expect(captured.source).toBe("global");
    expect(existsSync(serverPolicyPath("k8s"))).toBe(false);
    expect(JSON.parse(readFileSync(globalPolicyPath(), "utf-8")).rules[0].spec).toBe("k8s*");
  });

  test("remove --spec deletes from the per-spec file", async () => {
    await policyCmd(["add", "--id", "no-deletes", "--spec", "k8s", "--tool", "delete_*"]);
    await policyCmd(["remove", "no-deletes", "--spec", "k8s"]);
    expect(JSON.parse(readFileSync(serverPolicyPath("k8s"), "utf-8")).rules).toEqual([]);
  });

  test("clear --spec empties the per-spec file", async () => {
    await policyCmd(["add", "--id", "no-deletes", "--spec", "k8s", "--tool", "delete_*"]);
    await policyCmd(["clear", "--spec", "k8s"]);
    expect(JSON.parse(readFileSync(serverPolicyPath("k8s"), "utf-8")).rules).toEqual([]);
  });

  test("bare --when throws a usage error", async () => {
    await expect(
      policyCmd(["add", "--id", "x", "--tool", "y", "--when", "--local"])
    ).rejects.toThrow("Invalid --when");
  });

  test("add --data spec name wins over a conflicting --spec flag", async () => {
    await policyCmd([
      "add",
      "--spec",
      "k8s",
      "--data",
      JSON.stringify({ id: "x", spec: "aws", tool: "restart" }),
    ]);
    expect(captured.source).toBe("server:aws");
    expect(existsSync(serverPolicyPath("aws"))).toBe(true);
    expect(existsSync(serverPolicyPath("k8s"))).toBe(false);
  });
});
