/**
 * The contract's own checks: its entries are well formed, the digest of
 * its names is recorded with a change log entry, the schemas of shared/
 * are generated from the types, every `$ref` leads somewhere, and the
 * OpenAPI documents hold only OpenAPI's keys. The Rust server is held to
 * the contract by its own tests and the parity suite (contract/README.md).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  brokenRefs,
  CONTRACT,
  contractNames,
  inventoryDigest,
  readJson,
} from "./entries";
import { generateSchemas, schemaFilesOnDisk } from "./schemas";

const HOW =
  "Log the change in contract/CHANGES.md under a new version and record the new digest in contract/contract.json. See contract/README.md.";

const { names, problems } = contractNames();

describe("contract entries", () => {
  test("the contract's entries are well formed", () => {
    expect(problems).toEqual([]);
  });

  test("the digest of its names is recorded with a change log entry", () => {
    const contract = readJson<{ version: string; inventory_sha256: string }>(
      "contract.json",
    );
    const digest = inventoryDigest(names);
    if (contract.inventory_sha256 !== digest) console.error(HOW);
    expect(contract.inventory_sha256).toBe(digest);
    const changes = readFileSync(join(CONTRACT, "CHANGES.md"), "utf8");
    const latest = /^## (\S+)\n+inventory: ([0-9a-f]{64})$/m.exec(changes);
    expect(latest?.[1]).toBe(contract.version);
    expect(latest?.[2]).toBe(digest);
  });
});

describe("generated parts of the contract", () => {
  test("the JSON Schemas match the TypeScript types", () => {
    const generated = generateSchemas();
    // A schema whose module is gone is stale: --write deletes it.
    expect(schemaFilesOnDisk()).toEqual(Object.keys(generated).sort());
    for (const [file, schema] of Object.entries(generated))
      expect({ file, schema }).toEqual({
        file,
        schema: readJson(`schemas/${file}`),
      });
  }, 60_000);

  test("every $ref leads to a definition", () => {
    expect(brokenRefs()).toEqual([]);
  });
});

describe("OpenAPI documents", () => {
  // A sentence written unquoted in a flow mapping is cut at its comma into a
  // second key: only OpenAPI's own keys are allowed where that would land.
  const OPERATION = new Set([
    "summary",
    "description",
    "operationId",
    "parameters",
    "requestBody",
    "responses",
    "tags",
    "deprecated",
    "security",
    "servers",
    "callbacks",
    "externalDocs",
  ]);
  const RESPONSE = new Set(["description", "headers", "content", "links"]);
  const METHODS = [
    "get",
    "put",
    "post",
    "delete",
    "patch",
    "head",
    "options",
    "trace",
  ];
  for (const file of ["http/openapi.yaml", "agent-socket/openapi.yaml"])
    test(`${file} has only OpenAPI keys in its operations and responses`, () => {
      const document = Bun.YAML.parse(
        readFileSync(join(CONTRACT, file), "utf8"),
      ) as {
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      const stray: string[] = [];
      for (const [path, item] of Object.entries(document.paths))
        for (const [method, operation] of Object.entries(item)) {
          if (!METHODS.includes(method)) continue;
          for (const key of Object.keys(operation))
            if (!OPERATION.has(key) && !key.startsWith("x-"))
              stray.push(`${method} ${path}: ${key}`);
          const responses = (operation.responses ?? {}) as Record<
            string,
            Record<string, unknown>
          >;
          for (const [status, response] of Object.entries(responses))
            for (const key of Object.keys(response ?? {}))
              if (!RESPONSE.has(key) && !key.startsWith("x-"))
                stray.push(`${method} ${path} ${status}: ${key}`);
        }
      expect(stray).toEqual([]);
    });
});
