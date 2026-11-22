/**
 * The names the contract under `contract/` has an entry for, per surface of
 * the inventory: what `check.test.ts` compares with the code.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { REPO } from "./ast";
import type { Inventory } from "./inventory";

export const CONTRACT = join(REPO, "contract");

export function readJson<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(join(CONTRACT, path), "utf8")) as T;
}

export function readYaml<T = Record<string, unknown>>(path: string): T {
  return Bun.YAML.parse(readFileSync(join(CONTRACT, path), "utf8")) as T;
}

function files(pattern: string): string[] {
  return [...new Bun.Glob(pattern).scanSync({ cwd: CONTRACT })].sort();
}

/** The family directory of an RPC method: `bridge.x` or its first word. */
export function rpcFamily(method: string): string {
  if (method === "*") return "herdr";
  const parts = method.split(".");
  return parts[0] === "bridge" ? parts.slice(0, 2).join(".") : parts[0]!;
}

export function rpcFile(method: string): string {
  return `rpc/${rpcFamily(method)}/${method === "*" ? "passthrough" : method}.json`;
}

/**
 * A push's file: named as the record checker looks it up (an event by its
 * name, a keyed push by its key).
 */
export function pushFile(name: string): string {
  return `push/${name.replace(/^event:/, "")}.json`;
}

/** The backticked names of the first column of a Markdown table. */
export function tableNames(path: string): string[] {
  const out: string[] = [];
  for (const line of readFileSync(join(CONTRACT, path), "utf8").split("\n")) {
    const match = /^\|\s*`([^`]+)`\s*\|/.exec(line);
    if (match) out.push(match[1]!);
  }
  return out;
}

export type EntryProblems = string[];

type OpenApi = {
  paths?: Record<string, Record<string, unknown>>;
};

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "head",
  "options",
];

/** The names of the contract, per surface, and what is malformed in it. */
export function contractNames(): {
  names: Inventory;
  problems: EntryProblems;
} {
  const problems: string[] = [];
  const present = (path: string) => {
    if (existsSync(join(CONTRACT, path))) return true;
    problems.push(`${path} is missing`);
    return false;
  };

  const rpc = files("rpc/**/*.json").map((path) => {
    const entry = readJson<{ method?: string }>(path);
    const method = entry.method ?? "";
    if (rpcFile(method) !== path)
      problems.push(
        `${path}: method "${method}" belongs in ${rpcFile(method)}`,
      );
    return method;
  });

  const push = files("push/*.json").map((path) => {
    const entry = readJson<{ "x-inventory"?: string }>(path);
    const name = entry["x-inventory"] ?? "";
    if (pushFile(name) !== path)
      problems.push(`${path}: push "${name}" belongs in ${pushFile(name)}`);
    return name;
  });

  const openapi = present("http/openapi.yaml")
    ? readYaml<OpenApi>("http/openapi.yaml")
    : {};
  const http = Object.keys(openapi.paths ?? {});
  const httpMethods = Object.entries(openapi.paths ?? {}).flatMap(
    ([path, item]) =>
      Object.keys(item)
        .filter((key) => HTTP_METHODS.includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
  );

  const asyncapi: {
    components?: { messages?: Record<string, { "x-inventory"?: string }> };
  } = present("ws/asyncapi.yaml") ? readYaml("ws/asyncapi.yaml") : {};
  const ws = Object.entries(asyncapi.components?.messages ?? {}).map(
    ([key, message]) => {
      if (!message["x-inventory"])
        problems.push(`ws/asyncapi.yaml: message ${key} has no x-inventory`);
      return message["x-inventory"] ?? key;
    },
  );

  const agent: OpenApi = present("agent-socket/openapi.yaml")
    ? readYaml("agent-socket/openapi.yaml")
    : {};
  const agentSocket = Object.entries(agent.paths ?? {}).flatMap(
    ([path, item]) =>
      Object.keys(item)
        .filter((key) => HTTP_METHODS.includes(key))
        .map((method) => `${method.toUpperCase()} ${path}`),
  );

  const commands: {
    commands: Record<
      string,
      { actions?: string[]; flags?: string[]; help?: string }
    >;
    server_flags: string[];
  } = present("cli/commands.json")
    ? readJson("cli/commands.json")
    : { commands: {}, server_flags: [] };
  const cli: string[] = [];
  for (const [name, command] of Object.entries(commands.commands)) {
    cli.push(name);
    for (const action of command.actions ?? []) cli.push(`${name} ${action}`);
    for (const flag of command.flags ?? []) cli.push(`${name} ${flag}`);
    if (command.help && !existsSync(join(CONTRACT, "cli", command.help)))
      problems.push(`cli/commands.json: ${name}: no golden ${command.help}`);
  }
  for (const flag of commands.server_flags) cli.push(`server ${flag}`);

  const env = present("env.md") ? tableNames("env.md") : [];

  const storageIndex: {
    entries: Record<string, { schema?: string; sql?: string }>;
  } = present("storage/index.json")
    ? readJson("storage/index.json")
    : { entries: {} };
  const storage = Object.keys(storageIndex.entries);
  for (const [name, entry] of Object.entries(storageIndex.entries))
    for (const ref of [entry.schema, entry.sql])
      if (ref && !existsSync(join(CONTRACT, "storage", ref.split("#")[0]!)))
        problems.push(`storage/index.json: ${name}: ${ref} does not exist`);

  const exec = present("exec.md") ? tableNames("exec.md") : [];

  return {
    names: {
      rpc,
      push,
      http,
      http_methods: httpMethods,
      ws,
      agent_socket: agentSocket,
      cli,
      env,
      storage,
      exec,
    },
    problems,
  };
}

/** Every `$ref` of the JSON files under contract/ that leads nowhere. */
export function brokenRefs(): string[] {
  const broken: string[] = [];
  const cache = new Map<string, unknown>();
  const load = (path: string) => {
    if (!cache.has(path))
      cache.set(path, JSON.parse(readFileSync(path, "utf8")));
    return cache.get(path);
  };
  const resolve = (document: unknown, pointer: string) => {
    let at = document as Record<string, unknown> | undefined;
    for (const raw of pointer.split("/").slice(1)) {
      const key = decodeURIComponent(raw)
        .replace(/~1/g, "/")
        .replace(/~0/g, "~");
      at = at?.[key] as Record<string, unknown> | undefined;
    }
    return at;
  };
  for (const path of files("**/*.json")) {
    const full = join(CONTRACT, path);
    const visit = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node)) {
        if (key === "$ref" && typeof value === "string") {
          const [file, pointer = ""] = value.split("#");
          const target = file ? join(dirname(full), file) : full;
          if (
            !existsSync(target) ||
            resolve(load(target), pointer) === undefined
          )
            broken.push(`${relative(CONTRACT, full)}: ${value}`);
        } else visit(value);
      }
    };
    visit(load(full));
  }
  return broken;
}

export { basename };
