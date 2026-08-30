import { describe, test, expect, spyOn } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { fetchSpec, inlineEntryFromFlags } from "../src/commands/fetch.js";

const fixture = resolve(import.meta.dir, "fixtures/openapi.json");

describe("inlineEntryFromFlags auth", () => {
  test("graphql inline entry includes auth", () => {
    const entry = inlineEntryFromFlags({ graphql: "https://gql.example/graphql", auth: "tok" });
    expect(entry.config.auth).toBe("tok");
  });

  test("openapi inline entry includes auth", () => {
    const entry = inlineEntryFromFlags({
      openapi: "https://api.example/openapi.json",
      auth: "tok",
    });
    expect(entry.config.auth).toBe("tok");
  });
});

describe("fetchSpec sends auth", () => {
  test("graphql introspection includes Authorization", async () => {
    const spy = spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          __schema: {
            queryType: { name: "Query" },
            mutationType: null,
            subscriptionType: null,
            types: [
              {
                name: "Query",
                kind: "OBJECT",
                description: null,
                fields: [],
                inputFields: null,
                enumValues: null,
              },
            ],
          },
        },
      }),
    });
    try {
      await fetchSpec({
        _section: "graphql",
        type: "graphql",
        source: "https://gql.example/graphql",
        config: { auth: "secret-tok" },
      });
      expect(spy).toHaveBeenCalled();
      const opts = spy.mock.calls[0][1];
      expect(opts.headers.Authorization).toBe("Bearer secret-tok");
    } finally {
      spy.mockRestore();
    }
  });

  test("openapi url fetch includes Authorization", async () => {
    const body = readFileSync(fixture, "utf-8");
    const spy = spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => body,
    });
    try {
      const spec = await fetchSpec({
        _section: "openapi",
        type: "openapi",
        source: "https://api.example/openapi.json",
        config: { auth: "secret-tok" },
      });
      expect(spec.operations.length).toBeGreaterThan(0);
      const opts = spy.mock.calls[0][1];
      expect(opts.headers.Authorization).toBe("Bearer secret-tok");
    } finally {
      spy.mockRestore();
    }
  });
});
