/**
 * contract/vectors/tool-params.json: how a tool's parameters are refused,
 * as typebox (the TS server's checker) says it, for every tool of the
 * catalog. Each case is a call the generator derives from the tool's
 * schema (the wrong type, a missing or extra property, each limit
 * crossed) and the first error typebox gives (`instancePath || "/"`, then
 * its message), or null when the call passes. The Rust registry
 * (crates/roamgate-claude) is held to the same cases, so a refusal reads
 * the same whichever side answers.
 *
 *   bun scripts/contract/tool-params.ts --write   rewrites the file
 *
 * tool-params.test.ts fails when the file differs from what this makes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { firstParamError } from "../../server/src/work/tools";
import { readCatalog, ROOT } from "./tools-catalog";

export const TOOL_PARAMS_PATH = join(
  ROOT,
  "contract",
  "vectors",
  "tool-params.json",
);

export type ToolParamCase = {
  table: string;
  tool: string;
  params: unknown;
  /** The first error as the tools say it, or null when the call passes. */
  error: string | null;
};

type Schema = Record<string, unknown>;

/** A value of the schema's kind that passes, as far as it can be made. */
function sample(schema: Schema): unknown {
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0] as Schema);
  switch (schema.type) {
    case "string": {
      const min = typeof schema.minLength === "number" ? schema.minLength : 0;
      return "a".repeat(Math.max(min, 1));
    }
    case "integer":
    case "number":
      return typeof schema.minimum === "number" ? schema.minimum : 1;
    case "boolean":
      return true;
    case "null":
      return null;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      const properties = (schema.properties ?? {}) as Record<string, Schema>;
      for (const key of (schema.required ?? []) as string[])
        if (properties[key]) out[key] = sample(properties[key]!);
      return out;
    }
    default:
      return "a";
  }
}

/** Values that break one rule of the schema each. */
function breakers(schema: Schema): unknown[] {
  const out: unknown[] = [];
  if (Array.isArray(schema.anyOf)) {
    out.push({ zzz: 1 }, 1.5);
    for (const branch of schema.anyOf as Schema[])
      out.push(...breakers(branch));
    return out;
  }
  if ("const" in schema) out.push(schema.const === false ? true : "zzz");
  if (Array.isArray(schema.enum)) out.push("zzz-not-one");
  switch (schema.type) {
    case "string":
      out.push(5, null);
      if (typeof schema.maxLength === "number")
        out.push("b".repeat(schema.maxLength + 1));
      if (typeof schema.minLength === "number" && schema.minLength > 0)
        out.push("");
      if (typeof schema.pattern === "string") out.push("!! not it !!");
      break;
    case "integer":
    case "number":
      out.push("1", 1.5);
      if (typeof schema.minimum === "number") out.push(schema.minimum - 1);
      if (typeof schema.maximum === "number") out.push(schema.maximum + 1);
      break;
    case "boolean":
      out.push("true");
      break;
    case "array": {
      out.push("a", {});
      const items = schema.items as Schema | undefined;
      if (items) out.push([{ zzz: [1] }], [5]);
      if (typeof schema.maxItems === "number")
        out.push(
          Array.from({ length: schema.maxItems + 1 }, () =>
            items ? sample(items) : 1,
          ),
        );
      if (typeof schema.minItems === "number" && schema.minItems > 0)
        out.push([]);
      break;
    }
    case "object":
      out.push([], "a", { zzz: 1 });
      if (typeof schema.minProperties === "number") out.push({});
      break;
  }
  return out;
}

/** The cases of one tool. */
function toolCases(
  table: string,
  tool: string,
  schema: Schema,
): ToolParamCase[] {
  const base = sample(schema) as Record<string, unknown>;
  const calls: unknown[] = [base, [1], "x", null, { ...base, zzz_extra: 1 }];
  if (Array.isArray(schema.required) && schema.required.length) calls.push({});
  const properties = (schema.properties ?? {}) as Record<string, Schema>;
  for (const [key, property] of Object.entries(properties)) {
    calls.push({ ...base, [key]: sample(property) });
    for (const value of breakers(property))
      calls.push({ ...base, [key]: value });
    // One level down: an object or an array of objects.
    const inner =
      property.type === "object"
        ? property
        : property.type === "array" &&
            (property.items as Schema)?.type === "object"
          ? (property.items as Schema)
          : null;
    if (inner) {
      const innerBase = sample(inner) as Record<string, unknown>;
      const wrap = (value: unknown) =>
        property.type === "array" ? [value] : value;
      calls.push({ ...base, [key]: wrap({ ...innerBase, zzz_extra: 1 }) });
      for (const [innerKey, innerProperty] of Object.entries(
        (inner.properties ?? {}) as Record<string, Schema>,
      ))
        for (const value of breakers(innerProperty))
          calls.push({
            ...base,
            [key]: wrap({ ...innerBase, [innerKey]: value }),
          });
    }
  }
  const seen = new Set<string>();
  const out: ToolParamCase[] = [];
  for (const params of calls) {
    const key = JSON.stringify(params);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ table, tool, params, error: firstParamError(schema, params) });
  }
  return out;
}

/** Every case, table by table, tool by tool. */
export function buildToolParamCases(): ToolParamCase[] {
  const out: ToolParamCase[] = [];
  for (const [table, { tools }] of Object.entries(readCatalog().tables))
    for (const tool of tools)
      out.push(...toolCases(table, tool.name, tool.input_schema as Schema));
  return out;
}

/** Long strings as `{"$repeat": [text, count]}`, to keep the file small. */
function compact(value: unknown): unknown {
  if (typeof value === "string" && value.length > 64 && /^(.)\1*$/.test(value))
    return { $repeat: [value[0], value.length] };
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, compact(each)]),
    );
  return value;
}

export function renderToolParams(cases: ToolParamCase[]): string {
  const description =
    "How a tool's parameters are refused, as typebox says it (the first error: its instance path, `/` for the value itself, and its message), for calls derived from every tool's schema in contract/tools/catalog.json; error null when the call passes. Not in the call format of contract/vectors/README.md: its rows are `refusals`. A string of one character repeated is written {\"$repeat\": [character, count]}. Written by scripts/contract/tool-params.ts, checked by its test; the Rust registry (crates/roamgate-claude) is held to it.";
  // One case a line: the file stays readable and small.
  const lines = cases.map((each) =>
    JSON.stringify({ ...each, params: compact(each.params) }),
  );
  return `{\n "description": ${JSON.stringify(description)},\n "refusals": [\n  ${lines.join(",\n  ")}\n ]\n}\n`;
}

export function readToolParams(): string {
  return readFileSync(TOOL_PARAMS_PATH, "utf8");
}

if (import.meta.main) {
  if (!process.argv.includes("--write")) {
    console.error("usage: bun scripts/contract/tool-params.ts --write");
    process.exit(2);
  }
  writeFileSync(TOOL_PARAMS_PATH, renderToolParams(buildToolParamCases()));
}
