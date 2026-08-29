import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { encode, decode } from "@toon-format/toon";

let setFormat, out, err;

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
  ({ setFormat, out, err } = await import("../src/output.js?real"));
  setFormat("json");
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

describe("err - always JSON regardless of format", () => {
  test("err stays JSON when format is toon", () => {
    setFormat("toon");
    const [output] = captureErr(() => err("something went wrong"));
    expect(JSON.parse(output)).toEqual({ error: "something went wrong" });
  });

  test("err stays JSON when format is yaml", () => {
    setFormat("yaml");
    const [output] = captureErr(() => err("fail"));
    expect(JSON.parse(output)).toEqual({ error: "fail" });
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
