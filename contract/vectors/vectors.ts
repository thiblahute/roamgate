/**
 * T0 vectors (contract/vectors/*.json): JSON in, JSON out, the only case
 * source of the functions they cover. `bun test` replays them against the TS
 * functions here, and the Rust crates against theirs; contract/vectors/
 * README.md describes the format.
 */
import { expect, setSystemTime, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** A call of a vector case. */
export type VectorCall = {
  /** `<module>.<export>`: a function, or a class with `new`. */
  fn?: string;
  /** `<module>.<export>`: a constant, compared with `result`. */
  value?: string;
  /** Construct the class `fn` names. */
  new?: boolean;
  /** Call `method` of, or read `get` from, the object that is handle `on`. */
  on?: number;
  method?: string;
  get?: string;
  args?: unknown[];
  /**
   * The encoded result (absent with `throws`). An object with methods in it
   * (a class instance, a driver) is `{"$handle": n}`: later calls use it
   * with `on: n`.
   */
  result?: unknown;
  /** The error message thrown, or a promise's rejection. */
  throws?: string;
  /** The result is a promise: awaited before comparing. */
  async?: boolean;
  /** The arguments after the call, when the call changed them. */
  args_after?: unknown[];
  /** The result is the very object passed as this argument. */
  same_as_arg?: number;
  /** The clock at the call (ms since the epoch), for the calls that read it. */
  now?: number;
};

export type VectorCase = {
  name: string;
  /** The describe blocks around the old test. */
  group?: string[];
  /** The old test's title in parity/ledger.tsv when it is not `name`. */
  ledger?: string;
  calls: VectorCall[];
};

export type VectorFile = {
  description: string;
  modules: Record<string, string>;
  /**
   * `generated_ids`: strings matching this pattern are ids the code makes
   * up (from the clock and random numbers); each comparison renames them
   * in order of appearance, so only where they appear counts.
   */
  normalize?: { generated_ids?: string };
  cases: VectorCase[];
};

/** `value` with the strings matching `pattern` renamed `$id1`, `$id2`... */
function renameIds(value: unknown, pattern: RegExp): unknown {
  const names = new Map<string, string>();
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      if (!pattern.test(item)) return item;
      let name = names.get(item);
      if (!name) {
        name = `$id${names.size + 1}`;
        names.set(item, name);
      }
      return name;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item).map(([key, entry]) => [key, walk(entry)]),
      );
    return item;
  };
  return walk(value);
}

const TAGS = new Set([
  "$undefined",
  "$num",
  "$bigint",
  "$map",
  "$set",
  "$date",
  "$regexp",
  "$bytes",
  "$buffer",
  "$error",
  "$object",
  "$handle",
  "$fn",
  "$text",
]);

/** Long strings with long runs are written as runs: `{"$text": [...]}`. */
const RUN_MIN = 64;

function runsOf(text: string): (string | [string, number])[] | undefined {
  if (text.length < 1024) return undefined;
  const out: (string | [string, number])[] = [];
  let plain = "";
  let at = 0;
  while (at < text.length) {
    let best: [string, number] | undefined;
    for (let size = 1; size <= 8 && at + size <= text.length; size++) {
      const unit = text.slice(at, at + size);
      let count = 1;
      while (text.startsWith(unit, at + count * size)) count++;
      if (
        count * size >= RUN_MIN &&
        (!best || count * size > best[1] * best[0].length)
      )
        best = [unit, count];
    }
    if (best) {
      if (plain) out.push(plain);
      plain = "";
      out.push(best);
      at += best[0].length * best[1];
    } else {
      plain += text[at];
      at++;
    }
  }
  if (plain) out.push(plain);
  return out.length < text.length / 16 ? out : undefined;
}

export class Unencodable extends Error {}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/**
 * A value as JSON: plain data as is, the rest tagged (`{"$undefined":true}`,
 * `{"$num":"NaN"}`, `{"$map":[[k,v]]}`, ...). Undefined properties are left
 * out, as JSON does. `handles` names the objects that are handles.
 */
export function encodeVector(
  value: unknown,
  handles?: (value: object) => number | undefined,
  functions?: (value: (...args: never[]) => unknown) => unknown,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "undefined":
      return { $undefined: true };
    case "boolean":
      return value;
    case "string": {
      const runs = runsOf(value);
      return runs ? { $text: runs } : value;
    }
    case "number":
      if (Number.isNaN(value)) return { $num: "NaN" };
      if (value === Infinity) return { $num: "Infinity" };
      if (value === -Infinity) return { $num: "-Infinity" };
      if (Object.is(value, -0)) return { $num: "-0" };
      return value;
    case "bigint":
      return { $bigint: value.toString() };
    case "function": {
      const encoded = functions?.(value as (...args: never[]) => unknown);
      if (encoded === undefined) throw new Unencodable("function");
      return encoded;
    }
    case "symbol":
      throw new Unencodable("symbol");
  }
  const object = value as object;
  const handle = handles?.(object);
  if (handle !== undefined) return { $handle: handle };
  if (Array.isArray(object)) {
    const out: unknown[] = [];
    for (let index = 0; index < object.length; index++)
      out.push(encodeVector(object[index], handles, functions));
    return out;
  }
  if (object instanceof Map)
    return {
      $map: [...object].map(([key, item]) => [
        encodeVector(key, handles, functions),
        encodeVector(item, handles, functions),
      ]),
    };
  if (object instanceof Set)
    return {
      $set: [...object].map((item) => encodeVector(item, handles, functions)),
    };
  if (object instanceof Date)
    return {
      $date: Number.isNaN(object.getTime()) ? "Invalid" : object.toISOString(),
    };
  if (object instanceof RegExp)
    return { $regexp: [object.source, object.flags] };
  if (Buffer.isBuffer(object)) return { $buffer: hex(object) };
  if (object instanceof Uint8Array) return { $bytes: hex(object) };
  if (object instanceof Error)
    return { $error: { name: object.name, message: object.message } };
  const proto = Object.getPrototypeOf(object);
  if (proto !== Object.prototype && proto !== null)
    throw new Unencodable(proto?.constructor?.name ?? "object");
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (item === undefined) continue;
    out[key] = encodeVector(item, handles, functions);
  }
  const keys = Object.keys(out);
  if (keys.length === 1 && TAGS.has(keys[0]!)) return { $object: out };
  return out;
}

/** A callback's calls, as `{"$fn": ...}` gives them. */
export type VectorCallback = {
  calls: {
    args?: unknown[];
    result?: unknown;
    throws?: string;
    async?: boolean;
  }[];
};

/** What decoding needs from the case: its handles and callbacks. */
export type VectorScope = {
  handle?: (id: number) => unknown;
  callback?: (table: VectorCallback) => unknown;
};

/** The value `encodeVector` gave. */
export function decodeVector(value: unknown, scope: VectorScope = {}): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.map((item) => decodeVector(item, scope));
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object);
  if (keys.length === 1 && TAGS.has(keys[0]!)) {
    const tagged = object[keys[0]!] as never;
    switch (keys[0]) {
      case "$undefined":
        return undefined;
      case "$num":
        return tagged === "-0" ? -0 : Number(tagged);
      case "$bigint":
        return BigInt(tagged);
      case "$map":
        return new Map(
          (tagged as [unknown, unknown][]).map(([key, item]) => [
            decodeVector(key, scope),
            decodeVector(item, scope),
          ]),
        );
      case "$set":
        return new Set(
          (tagged as unknown[]).map((item) => decodeVector(item, scope)),
        );
      case "$date":
        return new Date(tagged === "Invalid" ? Number.NaN : tagged);
      case "$regexp": {
        const [source, flags] = tagged as [string, string];
        return new RegExp(source, flags);
      }
      case "$buffer":
        return Buffer.from(tagged as string, "hex");
      case "$bytes":
        return new Uint8Array(Buffer.from(tagged as string, "hex"));
      case "$error": {
        const { name, message } = tagged as { name: string; message: string };
        const error = new Error(message);
        error.name = name;
        return error;
      }
      case "$handle":
        if (!scope.handle) throw new Error("a handle outside a case");
        return scope.handle(tagged as number);
      case "$text":
        return (tagged as (string | [string, number])[])
          .map((part) =>
            typeof part === "string" ? part : part[0].repeat(part[1]),
          )
          .join("");
      case "$fn":
        if (!scope.callback) throw new Error("a callback outside a case");
        return scope.callback(tagged as VectorCallback);
      case "$object": {
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(tagged as object))
          out[key] = decodeVector(item, scope);
        return out;
      }
    }
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object))
    out[key] = decodeVector(item, scope);
  return out;
}

const vectorsDir = import.meta.dir;

export function readVectors(name: string): VectorFile {
  return JSON.parse(
    readFileSync(join(vectorsDir, `${name}.json`), "utf8"),
  ) as VectorFile;
}

type Exports = Record<string, unknown>;

function exported(modules: Record<string, Exports>, name: string) {
  const [key, ...path] = name.split(".");
  let value: unknown = modules[key!];
  if (!value) throw new Error(`no module for ${name}`);
  for (const part of path) value = (value as Record<string, unknown>)[part];
  return value;
}

function lookup(modules: Record<string, Exports>, name: string) {
  const [key, ...path] = name.split(".");
  let owner: unknown;
  let value: unknown = modules[key!];
  if (!value) throw new Error(`no module for ${name}`);
  for (const part of path) {
    owner = value;
    value = (value as Record<string, unknown>)[part];
  }
  if (typeof value !== "function") throw new Error(`no function ${name}`);
  // A static method keeps its class as `this`.
  return path.length > 1
    ? (value as (...args: unknown[]) => unknown).bind(owner)
    : (value as (...args: unknown[]) => unknown);
}

/**
 * Replays one case: every call, in order, compared with what it gave. A
 * callback answers each call with what the recorded one gave, matching the
 * first unanswered call with the same arguments; by the end of the case,
 * every recorded call must have been made.
 */
export async function replayCase(
  modules: Record<string, Exports>,
  vector: VectorCase,
  normalize: VectorFile["normalize"] = {},
) {
  const ids = normalize.generated_ids
    ? new RegExp(normalize.generated_ids)
    : undefined;
  const same = (actual: unknown, expected: unknown, label: string) =>
    ids
      ? expect(renameIds(actual, ids), label).toEqual(renameIds(expected, ids))
      : expect(actual, label).toEqual(expected);
  const objects = new Map<number, object>();
  const handles = new Map<object, number>();
  const tables = new Map<unknown, VectorCallback>();
  const used = new Map<VectorCallback, Set<number>>();
  const problems: string[] = [];
  const handleOf = (value: object) => handles.get(value);
  const tableOf = (value: unknown) => {
    const table = tables.get(value);
    return table && { $fn: table };
  };
  const encode = (value: unknown) => encodeVector(value, handleOf, tableOf);
  const scope: VectorScope = {
    handle: (id) => {
      const value = objects.get(id);
      if (!value) throw new Error(`no handle ${id}`);
      return value;
    },
    callback: (table) => {
      const done = used.get(table) ?? new Set<number>();
      used.set(table, done);
      const stub = (...args: unknown[]) => {
        while (args.length && args[args.length - 1] === undefined) args.pop();
        const given = JSON.stringify(encode(args));
        const at = table.calls.findIndex(
          (call, index) =>
            !done.has(index) && JSON.stringify(call.args ?? []) === given,
        );
        if (at < 0) {
          problems.push(`a callback called with unrecorded arguments ${given}`);
          throw new Error(`unrecorded callback arguments ${given}`);
        }
        done.add(at);
        const call = table.calls[at]!;
        if (call.throws !== undefined) {
          const error = new Error(call.throws);
          if (call.async) return Promise.reject(error);
          throw error;
        }
        const result = decodeVector(call.result, scope);
        return call.async ? Promise.resolve(result) : result;
      };
      tables.set(stub, table);
      return stub;
    },
  };
  const keep = (id: number, value: unknown) => {
    objects.set(id, value as object);
    handles.set(value as object, id);
  };
  // The handles a result holds, where the recorded one has them.
  const bind = (expected: unknown, actual: unknown) => {
    if (!expected || typeof expected !== "object") return;
    if (!actual || typeof actual !== "object") return;
    if (Array.isArray(expected)) {
      if (Array.isArray(actual))
        expected.forEach((item, index) => bind(item, actual[index]));
      return;
    }
    const keys = Object.keys(expected);
    if (keys.length === 1 && keys[0] === "$handle") {
      if (!handles.has(actual))
        keep((expected as { $handle: number }).$handle, actual);
      return;
    }
    if (keys.length === 1 && TAGS.has(keys[0]!)) return;
    for (const key of keys)
      bind(
        (expected as Record<string, unknown>)[key],
        (actual as Record<string, unknown>)[key],
      );
  };
  try {
    for (const [index, call] of vector.calls.entries()) {
      if (call.value !== undefined) {
        same(encode(exported(modules, call.value)), call.result, call.value);
        continue;
      }
      const where = `${vector.name}: call ${index + 1} (${call.fn ?? `#${call.on}.${call.method ?? call.get}`})`;
      if (call.now !== undefined) setSystemTime(new Date(call.now));
      const args = decodeVector(call.args ?? [], scope) as unknown[];
      let result: unknown;
      let error: unknown;
      let threw = false;
      try {
        if (call.on !== undefined) {
          const target = scope.handle!(call.on) as Record<string, unknown>;
          if (call.get !== undefined) {
            result = target[call.get];
          } else {
            const method = target[call.method!] as (...a: unknown[]) => unknown;
            result = method.apply(target, args);
          }
        } else if (call.new) {
          const Class = lookup(modules, call.fn!) as unknown as new (
            ...a: unknown[]
          ) => object;
          result = new Class(...args);
        } else {
          result = lookup(modules, call.fn!)(...args);
        }
        if (call.async) result = await result;
      } catch (caught) {
        threw = true;
        error = caught;
      }
      if (call.throws !== undefined) {
        expect(threw, `${where} throws`).toBe(true);
        expect((error as Error)?.message ?? String(error), where).toBe(
          call.throws,
        );
      } else if (threw) {
        throw error;
      } else {
        bind(call.result, result);
        same(encode(result), call.result, where);
      }
      if (call.same_as_arg !== undefined)
        expect(result === args[call.same_as_arg], `${where} same object`).toBe(
          true,
        );
      if (call.args_after !== undefined)
        same(encode(args), call.args_after, `${where} arguments after`);
    }
    for (const [table, done] of used)
      if (done.size !== table.calls.length)
        problems.push(
          `a callback was called ${done.size} times, not ${table.calls.length}`,
        );
    expect(problems, vector.name).toEqual([]);
  } finally {
    if (vector.calls.some((call) => call.now !== undefined)) setSystemTime();
  }
}

/**
 * A `bun test` per case of contract/vectors/`name`.json, against the
 * modules it names (keys of `modules`, as the file's `modules` lists them).
 */
export function runVectors(name: string, modules: Record<string, Exports>) {
  const file = readVectors(name);
  for (const key of Object.keys(file.modules))
    if (!modules[key]) throw new Error(`${name}: module ${key} not given`);
  for (const vector of file.cases) {
    const title = [...(vector.group ?? []), vector.name].join(" > ");
    test(title, () => replayCase(modules, vector, file.normalize));
  }
}
