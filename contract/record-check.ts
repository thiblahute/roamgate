/**
 * The record checker's view of this contract
 * (server/src/contract-record/check.ts asks it first for every message).
 *
 * The contract's entries point into the generated schemas of schemas/ with
 * `$ref`s across files, which the checker's validator does not follow. This
 * bundles each RPC and push entry, and the two OpenAPI documents, into a
 * copy whose references are all local (the definitions copied under
 * `$defs`), and hands the copy to the checker's own ContractSchemas.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  ContractSchemas,
  type RecordCheck,
} from "../server/src/contract-record/check";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function filesUnder(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? filesUnder(path, pattern)
      : pattern.test(name)
        ? [path]
        : [];
  });
}

function read(path: string): Json {
  const text = readFileSync(path, "utf8");
  return (
    /\.ya?ml$/.test(path) ? Bun.YAML.parse(text) : JSON.parse(text)
  ) as Json;
}

/**
 * The document with every `$ref` to another file replaced by a local one:
 * the target definitions (and theirs, transitively) are copied into
 * `defs` under a name that says where they come from.
 */
export function bundle(
  document: Json,
  path: string,
  defs: Json,
  local: (name: string) => string,
): Json {
  const files = new Map<string, Json>();
  const load = (file: string) => {
    let loaded = files.get(file);
    if (!loaded) files.set(file, (loaded = read(file)));
    return loaded;
  };
  const visit = (node: unknown, from: string): unknown => {
    if (Array.isArray(node)) return node.map((each) => visit(each, from));
    if (!isObject(node)) return node;
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== "$ref" || typeof value !== "string") {
        out[key] = visit(value, from);
        continue;
      }
      const [file, pointer = ""] = value.split("#");
      const target = file ? join(dirname(from), file) : from;
      if (target === path && !file) {
        out.$ref = value;
        continue;
      }
      const name = `${relative(dirname(path), target).replace(/[/.]/g, "_")}__${pointer.split("/").pop()}`;
      out.$ref = local(name);
      if (!(name in defs)) {
        defs[name] = true; // a placeholder against cycles
        let at: unknown = load(target);
        for (const part of pointer.split("/").slice(1))
          at = (at as Json)?.[decodeURIComponent(part)];
        defs[name] = visit(at, target);
      }
    }
    return out;
  };
  return visit(document, path) as Json;
}

export function createRecordCheck(contractDir: string): RecordCheck {
  const copy = mkdtempSync(join(tmpdir(), "roamgate-contract-"));
  for (const file of [
    ...filesUnder(join(contractDir, "rpc"), /\.json$/),
    ...filesUnder(join(contractDir, "push"), /\.json$/),
  ]) {
    const defs: Json = {};
    const document = bundle(
      read(file),
      file,
      defs,
      (name) => `#/$defs/${name}`,
    );
    if (Object.keys(defs).length)
      document.$defs = { ...((document.$defs as Json) ?? {}), ...defs };
    const out = join(copy, relative(contractDir, file));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(document));
  }
  for (const dir of ["http", "agent-socket"]) {
    const file = join(contractDir, dir, "openapi.yaml");
    if (!existsSync(file)) continue;
    const schemas: Json = {};
    const document = bundle(
      read(file),
      file,
      schemas,
      (name) => `#/components/schemas/${name}`,
    );
    const components = (document.components ??= {}) as Json;
    components.schemas = {
      ...((components.schemas as Json) ?? {}),
      ...schemas,
    };
    mkdirSync(join(copy, dir), { recursive: true });
    writeFileSync(join(copy, dir, "openapi.json"), JSON.stringify(document));
  }
  const schemas = new ContractSchemas(copy);
  return { check: (message) => schemas.check(message) };
}
