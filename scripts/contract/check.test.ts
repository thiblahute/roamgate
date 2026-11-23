/**
 * The contract freeze check: fails when the Bun server's surface and the
 * contract under contract/ disagree. See contract/README.md for what to do
 * when it fails.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { brokenRefs, CONTRACT, contractNames, readJson } from "./entries";
import {
  cliGoldens,
  inventoryDigest,
  parseSqlFile,
  SQL_FILES,
} from "./generated";
import {
  constants,
  type Inventory,
  inventory,
  sqlStatements,
} from "./inventory";
import { generateSchemas, schemaFilesOnDisk } from "./schemas";

const HOW =
  "Update contract/ (bun scripts/contract/scaffold.ts adds entries for new names; remove the entries of names that are gone), log the change in contract/CHANGES.md and record the new digest in contract/contract.json. See contract/README.md.";

const found = await inventory();
const { names: have, problems } = contractNames();

function difference(a: readonly string[], b: readonly string[]): string[] {
  const other = new Set(b);
  return [...new Set(a)].filter((name) => !other.has(name)).sort();
}

describe("contract inventory", () => {
  test("the contract's entries are well formed", () => {
    expect(problems).toEqual([]);
  });

  const surfaces = Object.keys(found).filter(
    (surface) => surface !== "http_methods",
  ) as (keyof Inventory)[];
  for (const surface of surfaces) {
    test(`every ${surface} name of the server has a contract entry`, () => {
      const missing = difference(found[surface], have[surface]);
      if (missing.length) console.error(`${surface}: ${HOW}`);
      expect(missing).toEqual([]);
    });
    test(`every ${surface} entry of the contract is still served`, () => {
      const stale = difference(have[surface], found[surface]);
      if (stale.length) console.error(`${surface}: ${HOW}`);
      expect(stale).toEqual([]);
    });
  }

  test("every method a route tests for is in the OpenAPI document", () => {
    expect(difference(found.http_methods, have.http_methods)).toEqual([]);
  });

  test("the inventory digest is recorded with a change log entry", () => {
    const contract = readJson<{ version: string; inventory_sha256: string }>(
      "contract.json",
    );
    const digest = inventoryDigest(found);
    if (contract.inventory_sha256 !== digest) console.error(HOW);
    expect(contract.inventory_sha256).toBe(digest);
    const changes = readFileSync(join(CONTRACT, "CHANGES.md"), "utf8");
    const latest = /^## (\S+)\n+inventory: ([0-9a-f]{64})$/m.exec(changes);
    expect(latest?.[1]).toBe(contract.version);
    expect(latest?.[2]).toBe(digest);
  });
});

describe("generated parts of the contract", () => {
  test("the pinned versions and limits are unchanged", () => {
    expect(constants()).toEqual(
      readJson<{ constants: Record<string, string> }>("contract.json")
        .constants,
    );
  });

  test("CLI help matches the goldens", async () => {
    for (const [file, text] of Object.entries(await cliGoldens()))
      expect({ file, text }).toEqual({
        file,
        text: readFileSync(join(CONTRACT, "cli", file), "utf8"),
      });
  });

  test("the SQL each database runs matches storage/sqlite", () => {
    const statements = sqlStatements();
    expect(difference(Object.keys(statements), Object.keys(SQL_FILES))).toEqual(
      [],
    );
    const recorded: Record<string, string[]> = {};
    for (const file of new Set(Object.values(SQL_FILES)))
      Object.assign(
        recorded,
        parseSqlFile(
          readFileSync(join(CONTRACT, "storage/sqlite", file), "utf8"),
        ),
      );
    const current = Object.fromEntries(
      Object.keys(SQL_FILES).map((module) => [
        module,
        statements[module] ?? [],
      ]),
    );
    expect(current).toEqual(recorded);
  });

  test("the JSON Schemas match the TypeScript types", () => {
    const generated = generateSchemas();
    // A schema whose module is gone is stale: --regenerate deletes it.
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
