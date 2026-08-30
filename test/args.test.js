import { describe, test, expect } from "bun:test";
import { parseArgs, parseKV, parseLimit, parseOffset } from "../src/args.js";

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

  test("bare --flag is true when no value follows", () => {
    const { flags, positional } = parseArgs(["add", "--local", "--id", "r1"]);
    expect(flags.local).toBe(true);
    expect(flags.id).toBe("r1");
    expect(positional).toEqual(["add"]);
  });

  test("collects --when as repeatable", () => {
    const { flags } = parseArgs(["--when", "pod_name.prefix=prod", "--when", "force.eq=true"]);
    expect(flags.when).toEqual(["pod_name.prefix=prod", "force.eq=true"]);
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

describe("parseLimit", () => {
  test("defaults to 20 when the flag is omitted", () => {
    expect(parseLimit({})).toBe(20);
  });

  test("0 means no cap", () => {
    expect(parseLimit({ limit: "0" })).toBe(0);
  });

  test("parses a positive page size", () => {
    expect(parseLimit({ limit: "5" })).toBe(5);
  });
});

describe("parseOffset", () => {
  test("missing or invalid is 0", () => {
    expect(parseOffset({})).toBe(0);
    expect(parseOffset({ offset: "nope" })).toBe(0);
  });

  test("parses a positive offset", () => {
    expect(parseOffset({ offset: "20" })).toBe(20);
  });
});
