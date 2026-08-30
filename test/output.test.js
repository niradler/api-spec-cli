import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { encode, decode } from "@toon-format/toon";
import { mkdirSync, rmSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let setFormat, out, err, setMaxStdout, setResultsDir;

function captureLog(fn) {
  const calls = [];
  const spy = spyOn(console, "log").mockImplementation((...args) => {
    calls.push(args.join(" "));
  });
  fn();
  spy.mockRestore();
  return calls;
}

function captureErr(fn) {
  const calls = [];
  const spy = spyOn(console, "error").mockImplementation((...args) => {
    calls.push(args.join(" "));
  });
  fn();
  spy.mockRestore();
  return calls;
}

beforeEach(async () => {
  ({ setFormat, out, err, setMaxStdout, setResultsDir } = await import("../src/output.js?real"));
  setFormat("json");
  setMaxStdout(0);
});

describe("out - default format is toon", () => {
  test("fresh module encodes TOON without setFormat", async () => {
    const { out: outDefault } = await import(`../src/output.js?default-${Date.now()}`);
    const data = { name: "Alice", age: 30 };
    const [output] = captureLog(() => outDefault(data));
    expect(output).toContain("name: Alice");
    expect(output).toContain("age: 30");
    expect(output).not.toMatch(/^\s*\{/);
  });
});

describe("out - json", () => {
  test("pretty-prints JSON", () => {
    const data = { name: "Alice", age: 30 };
    const [output] = captureLog(() => out(data));
    expect(JSON.parse(output)).toEqual(data);
    expect(output).toContain("\n");
  });
});

describe("out - yaml", () => {
  test("outputs YAML without trailing newline", () => {
    setFormat("yaml");
    const data = { name: "Alice", age: 30 };
    const [output] = captureLog(() => out(data));
    expect(output).toContain("name: Alice");
    expect(output).toContain("age: 30");
    expect(output.endsWith("\n")).toBe(false);
  });
});

describe("out - text", () => {
  test("outputs key: value text", () => {
    setFormat("text");
    const [output] = captureLog(() => out({ name: "Alice", age: 30 }));
    expect(output).toContain("name: Alice");
    expect(output).toContain("age: 30");
  });
});

describe("out - toon", () => {
  test("flat object: produces valid TOON, no trailing newline", () => {
    setFormat("toon");
    const data = { name: "Alice", age: 30 };
    const [output] = captureLog(() => out(data));
    expect(output).toContain("name: Alice");
    expect(output).toContain("age: 30");
    expect(output.endsWith("\n")).toBe(false);
  });

  test("flat object: round-trips via decode", () => {
    setFormat("toon");
    const data = { name: "Alice", age: 30 };
    const [output] = captureLog(() => out(data));
    const decoded = decode(output);
    expect(decoded).toEqual(data);
  });

  test("array of uniform objects: uses tabular header form", () => {
    setFormat("toon");
    const data = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const [output] = captureLog(() => out(data));
    expect(output).toMatch(/\[2\]\{.*id.*\}/);
    expect(output.endsWith("\n")).toBe(false);
  });

  test("array of uniform objects: round-trips via decode", () => {
    setFormat("toon");
    const data = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const [output] = captureLog(() => out(data));
    const decoded = decode(output);
    expect(decoded).toEqual(data);
  });

  test("nested object: encodes and round-trips", () => {
    setFormat("toon");
    const data = { user: { id: 42, roles: ["admin", "viewer"] }, active: true };
    const [output] = captureLog(() => out(data));
    expect(output.length).toBeGreaterThan(0);
    expect(output.endsWith("\n")).toBe(false);
    const decoded = decode(output);
    expect(decoded).toEqual(data);
  });

  test("output matches encode() directly", () => {
    setFormat("toon");
    const data = { key: "value" };
    const [output] = captureLog(() => out(data));
    expect(output).toBe(encode(data).trimEnd());
  });
});

describe("err - always plain text regardless of format", () => {
  test("err is plain text when format is toon", () => {
    setFormat("toon");
    const [output] = captureErr(() => err("something went wrong"));
    expect(output).toBe("error: something went wrong");
  });

  test("err is plain text when format is json", () => {
    setFormat("json");
    const [output] = captureErr(() => err("fail"));
    expect(output).toBe("error: fail");
  });

  test("multiline err uses real newlines not escaped", () => {
    const [output] = captureErr(() => err("first line\n  second line"));
    expect(output).toBe("error: first line\n  second line");
    expect(output).not.toContain("\\n");
    expect(output).not.toMatch(/\{"error":/);
  });
});

describe("setFormat - unknown format is ignored", () => {
  test("unknown format keeps current format", () => {
    setFormat("toon");
    setFormat("xml");
    const data = { x: 1 };
    const [output] = captureLog(() => out(data));
    expect(output).toContain("x: 1");
    expect(output.endsWith("\n")).toBe(false);
  });
});

describe("out - spill oversized payloads", () => {
  const dir = join(tmpdir(), `spec-cli-results-${process.pid}`);

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
    setResultsDir(dir);
    setFormat("json");
    setMaxStdout(40);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    setMaxStdout(0);
  });

  test("writes JSON to the results dir and prints a stub", () => {
    const data = { blob: "x".repeat(80) };
    const [output] = captureLog(() => out(data));
    const stub = JSON.parse(output);
    expect(stub.cached).toBe(true);
    expect(stub.bytes).toBeGreaterThan(40);
    expect(stub.hint).toContain("rg <pattern>");
    expect(existsSync(stub.path)).toBe(true);
    expect(JSON.parse(readFileSync(stub.path, "utf-8"))).toEqual(data);
  });

  test("--max-bytes 0 keeps the full payload on stdout", () => {
    setMaxStdout(0);
    const data = { blob: "x".repeat(80) };
    const [output] = captureLog(() => out(data));
    expect(JSON.parse(output)).toEqual(data);
  });
});
