import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import Schema from "typebox/schema";
import { type Classified, Classifier, readRecordings } from "./corpus";
import { addToCensus, type Census } from "./shapes";

/**
 * Checks a contract recording against the schemas under `contract/` (the
 * layout of the Rust migration plan, section 4.1):
 *
 * | Surface | Schema |
 * |---|---|
 * | RPC request and reply | `contract/rpc/<family>/<method>.json`: `{ "params": <schema>, "reply": <schema>, "error"?: <schema> }`, or the same under `$defs` |
 * | Push | `contract/push/<name>.json`: the whole message's schema (`<name>` as corpus.ts pushName gives it, `event:` and `method:` prefixes dropped) |
 * | HTTP | `contract/http/openapi.yaml` (or `.json`): the path's operation, its JSON or form request body and the status's JSON response |
 * | Agent socket | `contract/agent-socket/openapi.yaml`: `POST /v1/<command>` likewise |
 *
 * A message whose schema says no is a mismatch; a key no schema at its level
 * names (its `properties`, `patternProperties`, any branch of an `anyOf`,
 * `oneOf` or `allOf`) is an unknown field, even where extra keys are
 * allowed; a message of one of those surfaces with no schema is unlisted.
 *
 * The contract can replace or extend this: a `contract/record-check.ts`
 * exporting `createRecordCheck(contractDir)` returning
 * `{ check(message: Classified): Finding[] | undefined }` is asked first for
 * every message, and its `undefined` falls back to the built-in check.
 */

export type FindingKind = "mismatch" | "unknown-field" | "unlisted";

export type Finding = {
  kind: FindingKind;
  surface: string;
  name: string;
  path: string;
  detail: string;
};

export type RecordCheck = {
  check(message: Classified): Finding[] | undefined;
};

export type CheckReport = {
  messages: number;
  checked: number;
  /** Findings grouped by kind, surface, name and path. */
  findings: (Finding & { count: number; first: string })[];
  census: Census;
};

// biome-ignore lint/suspicious/noExplicitAny: JSON Schema documents.
type JsonSchema = any;

type Validator = {
  Check(value: unknown): boolean;
  Errors(value: unknown): unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readStructured(path: string): JsonSchema {
  const text = readFileSync(path, "utf8");
  return /\.ya?ml$/.test(path) ? Bun.YAML.parse(text) : JSON.parse(text);
}

function filesUnder(directory: string, pattern: RegExp): string[] {
  if (!existsSync(directory)) return [];
  const out: string[] = [];
  for (const name of readdirSync(directory)) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, pattern));
    else if (pattern.test(name)) out.push(path);
  }
  return out;
}

/** An OpenAPI document's operations, matched by method and path template. */
type Operation = {
  template: RegExp;
  method: string;
  operation: JsonSchema;
  defs: Record<string, JsonSchema>;
};

/** `#/components/schemas/X` refs rewritten to `#/$defs/X`. */
function rewriteRefs(schema: JsonSchema): JsonSchema {
  if (Array.isArray(schema)) return schema.map(rewriteRefs);
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema))
    out[key] =
      key === "$ref" && typeof value === "string"
        ? value.replace(/^#\/components\/schemas\//, "#/$defs/")
        : rewriteRefs(value);
  return out;
}

function openApiOperations(path: string): Operation[] {
  const document = readStructured(path);
  const defs = rewriteRefs(document?.components?.schemas ?? {});
  const out: Operation[] = [];
  for (const [template, item] of Object.entries(
    (document?.paths ?? {}) as Record<string, Record<string, unknown>>,
  )) {
    const pattern = new RegExp(
      `^${template
        .split(/\{[^}]+\}/)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]+")}$`,
    );
    for (const [method, operation] of Object.entries(item))
      if (/^(get|put|post|delete|patch|head|options)$/.test(method))
        out.push({
          template: pattern,
          method: method.toUpperCase(),
          operation: rewriteRefs(operation),
          defs,
        });
  }
  return out;
}

/** The built-in check over a contract directory. */
export class ContractSchemas {
  private readonly rpc = new Map<string, JsonSchema>();
  private readonly push = new Map<string, JsonSchema>();
  private readonly http: Operation[] = [];
  private readonly agent: Operation[] = [];
  private readonly validators = new WeakMap<object, Validator>();
  readonly empty: boolean;

  constructor(readonly directory: string) {
    for (const file of filesUnder(join(directory, "rpc"), /\.json$/))
      this.rpc.set(basename(file, ".json"), readStructured(file));
    for (const file of filesUnder(join(directory, "push"), /\.json$/))
      this.push.set(basename(file, ".json"), readStructured(file));
    for (const [dir, into] of [
      ["http", this.http],
      ["agent-socket", this.agent],
    ] as const)
      for (const name of ["openapi.yaml", "openapi.yml", "openapi.json"]) {
        const path = join(directory, dir, name);
        if (existsSync(path)) {
          into.push(...openApiOperations(path));
          break;
        }
      }
    this.empty =
      !this.rpc.size &&
      !this.push.size &&
      !this.http.length &&
      !this.agent.length;
  }

  private validator(schema: JsonSchema): Validator {
    let validator = this.validators.get(schema);
    if (!validator) {
      validator = Schema.Compile(schema) as unknown as Validator;
      this.validators.set(schema, validator);
    }
    return validator;
  }

  private rpcPart(
    method: string,
    part: "params" | "reply" | "error",
  ): JsonSchema | null | undefined {
    const document = this.rpc.get(method);
    if (!document) return undefined;
    const schema = document[part] ?? document.$defs?.[part];
    if (!schema) return null;
    // Keep the document's $defs reachable from the part.
    return document.$defs && !schema.$defs
      ? { ...schema, $defs: document.$defs }
      : schema;
  }

  private operation(
    list: Operation[],
    method: string,
    path: string,
  ): Operation | undefined {
    return list.find((op) => op.method === method && op.template.test(path));
  }

  /** The findings of one message; undefined when its surface has no contract home. */
  check(message: Classified): Finding[] | undefined {
    const { surface, name } = message;
    const findings: Finding[] = [];
    const against = (schema: JsonSchema, value: unknown, where: string) =>
      findings.push(...this.validate(surface, name, schema, value, where));
    if (surface === "rpc.request" || surface === "rpc.reply") {
      const part =
        surface === "rpc.request"
          ? "params"
          : message.error
            ? "error"
            : "reply";
      const schema = this.rpcPart(name, part);
      if (schema === undefined)
        return [
          {
            kind: "unlisted",
            surface,
            name,
            path: "/",
            detail: "no contract/rpc entry",
          },
        ];
      if (schema === null) {
        // An error with no error schema is the common envelope's business.
        if (part === "error") return [];
        return [
          {
            kind: "unlisted",
            surface,
            name,
            path: "/",
            detail: `no ${part} schema`,
          },
        ];
      }
      against(schema, message.payload, part);
      return findings;
    }
    if (surface === "push") {
      const key = name.replace(/^(event|method):/, "");
      const schema = this.push.get(name) ?? this.push.get(key);
      if (!schema)
        return [
          {
            kind: "unlisted",
            surface,
            name,
            path: "/",
            detail: "no contract/push entry",
          },
        ];
      against(schema, message.payload, "message");
      return findings;
    }
    if (surface === "http" || surface === "agent") {
      const list = surface === "http" ? this.http : this.agent;
      const method = message.request?.method ?? "GET";
      const path = message.request?.path ?? "";
      const op = this.operation(list, method, path);
      if (!op)
        return [
          {
            kind: "unlisted",
            surface,
            name,
            path: "/",
            detail: `no operation for ${method} ${path}`,
          },
        ];
      const withDefs = (schema: JsonSchema) =>
        Object.keys(op.defs).length ? { ...schema, $defs: op.defs } : schema;
      const content = op.operation.requestBody?.content ?? {};
      const requestSchema =
        content["application/json"]?.schema ??
        content["application/x-www-form-urlencoded"]?.schema;
      if (requestSchema && message.request?.body !== undefined)
        against(withDefs(requestSchema), message.request.body, "request");
      const responses = op.operation.responses ?? {};
      const response =
        responses[String(message.status)] ??
        responses[`${String(message.status).slice(0, 1)}XX`] ??
        responses.default;
      if (!response && message.status !== undefined)
        findings.push({
          kind: "mismatch",
          surface,
          name,
          path: "/status",
          detail: `status ${message.status} not described`,
        });
      const responseSchema = response?.content?.["application/json"]?.schema;
      if (responseSchema && message.payload !== undefined)
        against(withDefs(responseSchema), message.payload, "response");
      return findings;
    }
    return undefined;
  }

  private validate(
    surface: string,
    name: string,
    schema: JsonSchema,
    value: unknown,
    where: string,
  ): Finding[] {
    const out: Finding[] = [];
    const validator = this.validator(schema);
    if (!validator.Check(value)) {
      const result = validator.Errors(value);
      const errors = (
        Array.isArray(result) && Array.isArray(result[1]) ? result[1] : result
      ) as {
        instancePath?: string;
        message?: string;
      }[];
      for (const error of Array.isArray(errors) ? errors : [])
        out.push({
          kind: "mismatch",
          surface,
          name,
          path: `${where}${error.instancePath ?? ""}`,
          detail: error.message ?? "invalid",
        });
      if (!out.length)
        out.push({
          kind: "mismatch",
          surface,
          name,
          path: where,
          detail: "invalid",
        });
    }
    for (const path of unknownFields(schema, value, schema, ""))
      out.push({
        kind: "unknown-field",
        surface,
        name,
        path: `${where}${path}`,
        detail: "not in the schema",
      });
    return out;
  }
}

function resolveRef(root: JsonSchema, ref: string): JsonSchema | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node = root;
  for (const part of ref.slice(2).split("/"))
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return node;
}

/** The schemas a value at this level could be described by. */
function branches(
  schema: JsonSchema,
  root: JsonSchema,
  depth = 0,
): JsonSchema[] {
  if (!isObject(schema) || depth > 16) return [];
  const out: JsonSchema[] = [schema];
  if (typeof schema.$ref === "string") {
    const target = resolveRef(root, schema.$ref);
    if (target) out.push(...branches(target, root, depth + 1));
  }
  for (const key of ["allOf", "anyOf", "oneOf"])
    if (Array.isArray(schema[key]))
      for (const branch of schema[key])
        out.push(...branches(branch, root, depth + 1));
  for (const key of ["then", "else"])
    if (isObject(schema[key]))
      out.push(...branches(schema[key], root, depth + 1));
  return out;
}

/** Paths of the keys no schema at their level names. */
export function unknownFields(
  schema: JsonSchema,
  value: unknown,
  root: JsonSchema,
  path: string,
  depth = 0,
): string[] {
  if (depth > 32 || schema === true || schema === undefined) return [];
  const all = branches(schema, root);
  const out: string[] = [];
  if (isObject(value)) {
    const described = all.filter(
      (branch) =>
        isObject(branch.properties) ||
        isObject(branch.patternProperties) ||
        isObject(branch.additionalProperties),
    );
    if (!described.length) return [];
    for (const [key, item] of Object.entries(value)) {
      const children: JsonSchema[] = [];
      for (const branch of described) {
        if (isObject(branch.properties) && key in branch.properties)
          children.push(branch.properties[key]);
        else if (isObject(branch.patternProperties))
          for (const [pattern, child] of Object.entries(
            branch.patternProperties,
          ))
            if (new RegExp(pattern, "u").test(key)) children.push(child);
        if (!children.length && isObject(branch.additionalProperties))
          children.push(branch.additionalProperties);
      }
      const at = `${path}/${key}`;
      if (!children.length) out.push(at);
      // The first describing branch is enough to look inside.
      else out.push(...unknownFields(children[0], item, root, at, depth + 1));
    }
  } else if (Array.isArray(value)) {
    const items = all.map((branch) => branch.items).find(isObject);
    if (items)
      value.slice(0, 16).forEach((item, index) => {
        out.push(
          ...unknownFields(items, item, root, `${path}/${index}`, depth + 1),
        );
      });
  }
  // A path seen once per array item reads better without the index.
  return [...new Set(out.map((p) => p.replace(/\/\d+(?=\/|$)/g, "/*")))];
}

/** The contract's own check (contract/record-check.ts), when it has one. */
export async function loadRecordCheck(
  contractDir: string,
): Promise<RecordCheck | null> {
  const path = join(contractDir, "record-check.ts");
  if (!existsSync(path)) return null;
  const module = (await import(path)) as {
    createRecordCheck?: (contractDir: string) => RecordCheck;
  };
  return module.createRecordCheck?.(contractDir) ?? null;
}

/** Checks every message of a recording; the census comes with it. */
export async function checkRecordings(
  paths: readonly string[],
  contractDir: string | null,
  options: { surfaces?: ReadonlySet<string> } = {},
): Promise<CheckReport> {
  const schemas = contractDir ? new ContractSchemas(contractDir) : null;
  const custom = contractDir ? await loadRecordCheck(contractDir) : null;
  const classifier = new Classifier();
  const census: Census = {};
  const grouped = new Map<string, Finding & { count: number; first: string }>();
  let messages = 0;
  let checked = 0;
  for (const record of readRecordings(paths)) {
    const message = classifier.classify(record);
    if (!message || message.surface === "recorder") continue;
    if (options.surfaces && !options.surfaces.has(message.surface)) continue;
    messages += 1;
    addToCensus(census, message.surface, message.name, message.payload);
    if (message.request?.body !== undefined)
      addToCensus(
        census,
        `${message.surface}.request`,
        message.name,
        message.request.body,
      );
    const findings =
      custom?.check(message) ??
      (schemas && !schemas.empty ? schemas.check(message) : undefined);
    if (!findings) continue;
    checked += 1;
    for (const finding of findings) {
      const key = `${finding.kind}\u0000${finding.surface}\u0000${finding.name}\u0000${finding.path}`;
      const existing = grouped.get(key);
      if (existing) existing.count += 1;
      else
        grouped.set(key, {
          ...finding,
          count: 1,
          first: `${record.file}:${record.line}`,
        });
    }
  }
  return {
    messages,
    checked,
    findings: [...grouped.values()].sort(
      (a, b) => a.kind.localeCompare(b.kind) || b.count - a.count,
    ),
    census,
  };
}
