/**
 * JSON Schemas (2020-12) of shared/'s wire and storage types, generated
 * from the TypeScript declarations by ts-json-schema-generator and
 * reconciled by hand through `contract/schemas/reconcile.json` (limits the
 * server checks, optional versus null, literal unions the types leave
 * open). `contract/schemas/server.schema.json`, the server's own types, is
 * written by hand: roamgate-protocol's `contract_schemas` test holds the
 * Rust types to it.
 *
 * `bun scripts/contract/schemas.ts --write` rewrites the generated files;
 * `check.test.ts` regenerates and fails when the files differ, so a type
 * change reaches the contract in the same commit.
 */
import { readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { createGenerator, type Config } from "ts-json-schema-generator";
import ts from "typescript-api";
import { REPO, source } from "./ast";
import { formattedJson, writeContractFile } from "./write";

const SCHEMAS = "contract/schemas";
const RECONCILE = `${SCHEMAS}/reconcile.json`;
/** The schema files written by hand, not generated. */
export const HELD_SCHEMAS = ["server.schema.json"];

type Schema = Record<string, unknown>;

type Reconciliation = {
  /** The schema file, relative to contract/schemas. */
  schema: string;
  /** JSON Pointer to the object changed. */
  pointer: string;
  /** Keywords set on it. */
  set?: Schema;
  /** Keywords removed from it. */
  remove?: string[];
  /** Why: the server code that decides it. */
  why: string;
};

function exportedTypes(path: string): string[] {
  const file = source(path);
  const names: string[] = [];
  for (const statement of file.statements) {
    const exported = ts.canHaveModifiers(statement)
      ? ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (
      (ts.isTypeAliasDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement)) &&
      exported
    )
      names.push(statement.name.text);
    // `export type { A, B } from "..."`.
    if (
      ts.isExportDeclaration(statement) &&
      statement.isTypeOnly &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    )
      for (const element of statement.exportClause.elements)
        names.push(element.name.text);
  }
  return names;
}

function sharedModules(): string[] {
  return [...new Bun.Glob("shared/*.ts").scanSync({ cwd: REPO })]
    .filter((path) => !path.endsWith(".test.ts"))
    .sort();
}

const BASE_CONFIG: Partial<Config> = {
  skipTypeCheck: true,
  expose: "export",
  topRef: false,
  additionalProperties: false,
  sortProps: true,
  strictTuples: true,
};

/** Rewrites draft-07 `definitions` references to 2020-12 `$defs` ones. */
function rewriteRefs(
  node: unknown,
  home: (name: string) => string,
  self: string,
): unknown {
  if (Array.isArray(node))
    return node.map((each) => rewriteRefs(each, home, self));
  if (!node || typeof node !== "object") return node;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$ref" && typeof value === "string") {
      const name = decodeURIComponent(value.replace(/^#\/definitions\//, ""));
      const file = home(name);
      const pointer = `#/$defs/${encodeURIComponent(name)}`;
      out.$ref =
        file === self
          ? pointer
          : `${relative(dirname(self), file) || "."}${pointer}`;
    } else out[key] = rewriteRefs(value, home, self);
  }
  return out;
}

/** One schema file per module of shared/. */
export function generateSchemas(): Record<string, Schema> {
  const modules = sharedModules();
  const owner = new Map<string, string>();
  const files: { file: string; source: string; types: string[] }[] = [];
  for (const path of modules) {
    const file = `shared/${basename(path, ".ts")}.schema.json`;
    const types = exportedTypes(path);
    for (const name of types) {
      if (owner.has(name))
        throw new Error(`${name} is exported by two modules of shared/`);
      owner.set(name, file);
    }
    files.push({ file, source: path, types });
  }
  const shared = createGenerator({
    ...BASE_CONFIG,
    path: join(REPO, "shared/*.ts"),
    tsconfig: join(REPO, "tsconfig.json"),
  });

  const out: Record<string, Schema> = {};
  for (const { file, source: from, types } of files) {
    const generator = shared;
    const defs: Schema = {};
    for (const name of types) {
      const generated = { ...(generator.createSchema(name) as Schema) };
      const definitions = (generated.definitions ?? {}) as Schema;
      delete generated.$schema;
      delete generated.definitions;
      const root = generated;
      // The type itself, at the root without `topRef`.
      const own = definitions[name] ?? root;
      // A file's refs go to the file each type is declared in; a type the
      // generator found elsewhere (Bun, the DOM) stays in this file.
      const home = (ref: string) => owner.get(ref) ?? file;
      defs[name] = rewriteRefs(own, home, file);
      for (const [dep, schema] of Object.entries(definitions))
        if (!owner.has(dep) && !(dep in defs))
          defs[dep] = rewriteRefs(schema, home, file);
    }
    if (!types.length) continue;
    out[file] = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `https://roamgate.dev/contract/schemas/${file}`,
      "x-generated-from": from,
      $defs: Object.fromEntries(
        Object.entries(defs).sort(([a], [b]) => a.localeCompare(b)),
      ),
    };
  }
  return applyReconciliations(out);
}

function pointerGet(root: unknown, pointer: string): Schema {
  let at = root as Schema;
  for (const raw of pointer.split("/").slice(1)) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    const next = (at as Record<string, unknown>)?.[key];
    if (!next || typeof next !== "object")
      throw new Error(`no ${pointer} (at ${key})`);
    at = next as Schema;
  }
  return at;
}

export function reconciliations(): Reconciliation[] {
  return JSON.parse(readFileSync(join(REPO, RECONCILE), "utf8"))
    .reconciliations as Reconciliation[];
}

function applyReconciliations(
  schemas: Record<string, Schema>,
): Record<string, Schema> {
  for (const change of reconciliations()) {
    if (HELD_SCHEMAS.includes(change.schema)) continue;
    const schema = schemas[change.schema];
    if (!schema) throw new Error(`reconcile.json: no schema ${change.schema}`);
    let target: Schema;
    try {
      target = pointerGet(schema, change.pointer);
    } catch (error) {
      throw new Error(
        `reconcile.json: ${change.schema}${change.pointer} no longer exists (${(error as Error).message}): the type changed, review this reconciliation`,
        { cause: error },
      );
    }
    for (const key of change.remove ?? []) delete target[key];
    Object.assign(target, change.set ?? {});
  }
  return schemas;
}

/** The generated schema files in contract/schemas, relative to it, sorted. */
export function schemaFilesOnDisk(): string[] {
  return [
    ...new Bun.Glob("**/*.schema.json").scanSync({ cwd: join(REPO, SCHEMAS) }),
  ]
    .filter((file) => !HELD_SCHEMAS.includes(file))
    .sort();
}

/** Writes the generated schemas and deletes the ones no type makes any more. */
export function writeSchemas(schemas = generateSchemas()): void {
  for (const file of schemaFilesOnDisk())
    if (!(file in schemas)) rmSync(join(REPO, SCHEMAS, file));
  for (const [file, schema] of Object.entries(schemas)) {
    writeContractFile(join(REPO, SCHEMAS, file), formattedJson(file, schema));
  }
}

if (import.meta.main) {
  const schemas = generateSchemas();
  if (process.argv.includes("--write")) writeSchemas(schemas);
  for (const [file, schema] of Object.entries(schemas))
    console.log(file, Object.keys((schema.$defs ?? {}) as Schema).length);
}
