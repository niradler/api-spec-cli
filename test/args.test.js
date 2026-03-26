import { describe, test, expect } from "bun:test";
import { parseArgs, parseKV } from "../src/args.js";

describe("parseArgs", () => {
  test("parses positional args", () => {
    const { positional } = parseArgs(["load", "file.json"]);
    expect(positional).toEqual(["load", "file.json"]);
  });

  test("parses --flag value", () => {
    const { flags } = parseArgs(["--filter", "pets"]);
    expect(flags.filter).toBe("pets");
  });

  test("parses --flag=value", () => {
    const { flags } = parseArgs(["--filter=pets"]);
    expect(flags.filter).toBe("pets");
  });

  test("collects repeatable flags into arrays", () => {
    const { flags } = parseArgs(["--query", "a=1", "--query", "b=2"]);
    expect(flags.query).toEqual(["a=1", "b=2"]);
  });

  test("collects --var as repeatable", () => {
    const { flags } = parseArgs(["--var", "x=1", "--var", "y=2"]);
    expect(flags.var).toEqual(["x=1", "y=2"]);
  });

  test("collects --header as repeatable", () => {
    const { flags } = parseArgs(["--header", "X-Key=val"]);
    expect(flags.header).toEqual(["X-Key=val"]);
  });

  test("mixes positional and flags", () => {
    const { positional, flags } = parseArgs(["show", "getPet", "--format", "yaml"]);
    expect(positional).toEqual(["show", "getPet"]);
    expect(flags.format).toBe("yaml");
  });

  test("handles --flag=value with = in value", () => {
    const { flags } = parseArgs(["--data", '{"key":"val"}']);
    expect(flags.data).toBe('{"key":"val"}');
  });
});

describe("parseKV", () => {
  test("parses key=value pairs", () => {
    expect(parseKV(["a=1", "b=2"])).toEqual({ a: "1", b: "2" });
  });

  test("handles value with = in it", () => {
    expect(parseKV(["key=a=b"])).toEqual({ key: "a=b" });
  });

  test("returns empty for null/undefined", () => {
    expect(parseKV(null)).toEqual({});
    expect(parseKV(undefined)).toEqual({});
  });

  test("throws on missing =", () => {
    expect(() => parseKV(["bad"])).toThrow("Invalid key=value");
  });
});
