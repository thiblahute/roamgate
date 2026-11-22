/**
 * Adds an entry to `contract/` for every name of the inventory that has
 * none, and with `--regenerate` rewrites the generated parts (CLI help
 * goldens, SQL, JSON Schemas). Existing entries are never changed: they are
 * the contract, edited by hand. Prints the inventory digest to record in
 * contract.json and CHANGES.md.
 *
 *   bun scripts/contract/scaffold.ts [--regenerate]
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript-api";
import { literal, source, walk } from "./ast";
import {
  CONTRACT,
  contractNames,
  pushFile,
  readJson,
  readYaml,
  rpcFamily,
  rpcFile,
} from "./entries";
import {
  type Inventory,
  inventory,
  rpcSources,
  sqlStatements,
  whereFound,
} from "./inventory";
import { writeSchemas } from "./schemas";
import { writeContractFile, yamlText } from "./write";
import { cliGoldens, inventoryDigest, SQL_FILES, sqlFile } from "./generated";

type Json = Record<string, unknown>;

/** Writes a contract file, unless it already says the same (write.ts). */
function write(path: string, text: string): void {
  writeContractFile(join(CONTRACT, path), text);
}

function writeJson(path: string, value: unknown): void {
  write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeYaml(path: string, value: unknown): void {
  write(path, yamlText(value));
}

function missing(surface: keyof Inventory, found: Inventory, have: Inventory) {
  const known = new Set(have[surface]);
  return found[surface].filter((name) => !known.has(name));
}

/** A `$ref` to a generated schema, from an entry `depth` levels down. */
const refAt = (depth: number) => (schema: string, name: string) => ({
  $ref: `${"../".repeat(depth)}schemas/${schema}.schema.json#/$defs/${name}`,
});
const ref = refAt(2);
const pushRef = refAt(1);

// ---------------------------------------------------------------------------
// RPC

/** Methods that are Herdr's, handled or annotated by the server first. */
const HERDR_FAMILIES = new Set([
  "workspace",
  "tab",
  "pane",
  "integration",
  "agent",
]);
/** Of those, answered by the server without reaching Herdr. */
const SERVER_ONLY = new Set(["workspace.path"]);

/** Replies whose type is declared in shared/ or in the server's types. */
const RPC_RESULTS: Record<string, [string, string]> = {
  "bridge.work.board": ["shared/work", "WorkBoard"],
  "bridge.workspace_tree.get": ["shared/workspaceTree", "WorkspaceTree"],
  "bridge.activity.timeline": ["server", "TimelineReply"],
  "activity.presence": ["server", "PresenceReply"],
  "forward.list": ["server", "ForwardWire"],
};

async function scaffoldRpc(names: string[]): Promise<void> {
  const { isBridgeGlobalMethod } = (await import(
    "../../server/src/connections/protocol"
  )) as { isBridgeGlobalMethod: (method: string) => boolean };
  const sources = rpcSources();
  for (const method of names) {
    const family = rpcFamily(method);
    const result = RPC_RESULTS[method];
    const entry: Json = {
      method,
      family,
      scope:
        method === "*"
          ? "connection"
          : isBridgeGlobalMethod(method)
            ? "bridge"
            : "connection",
      handler: sources.get(method),
      ...(method === "*"
        ? {
            herdr: "pass-through",
            description:
              "Any method the server does not handle goes to the connection's Herdr as is (herdr.call), with the panes conversation mode holds and the Claude mod's states overlaid on the reply.",
          }
        : HERDR_FAMILIES.has(family) && !SERVER_ONLY.has(method)
          ? { herdr: "intercepted" }
          : {}),
      params: { type: "object" },
      reply: result
        ? method === "forward.list"
          ? { type: "array", items: ref(...result) }
          : ref(...result)
        : {},
      status: "inventoried",
    };
    writeJson(rpcFile(method), entry);
  }
}

// ---------------------------------------------------------------------------
// Pushes

const PUSH_SCHEMAS: Record<string, [string, string]> = {
  review: ["shared/review", "ReviewPush"],
  work: ["shared/work", "WorkPush"],
  mr_reviews: ["shared/mrReviews", "MrReviewsPush"],
  forge_cache: ["shared/forge", "MrCachePush"],
  workspace_tree: ["shared/workspaceTree", "WorkspaceTree"],
  forwards: ["server", "ForwardWire"],
};

const PUSH_COALESCING: Record<string, string> = {
  review:
    "review:<session id> for a session snapshot, review-prompts:<connection id> for prompts; other review pushes are not coalesced",
  assistant: "assistant",
  terminal: "terminal:<terminal id and viewport>",
};

function scaffoldPushes(names: string[]): void {
  for (const name of names) {
    const event = name.startsWith("event:") ? name.slice(6) : null;
    const typed = PUSH_SCHEMAS[name];
    const payload = typed
      ? name === "forwards"
        ? { type: "array", items: pushRef(...typed) }
        : pushRef(...typed)
      : {};
    // The file is the message's schema, as the record checker reads it;
    // what the inventory knows of it is in x- keywords.
    const entry: Json = {
      "x-inventory": name,
      "x-kind": event ? "event" : "keyed",
      "x-sent-by": whereFound(name),
      ...(PUSH_COALESCING[name]
        ? { "x-coalescing": PUSH_COALESCING[name] }
        : {}),
      "x-status":
        typed || event?.startsWith("agent_chat.") ? "typed" : "inventoried",
      ...(event?.startsWith("agent_chat.")
        ? {
            allOf: [
              pushRef("shared/agentChat", "AgentChatEventEnvelope"),
              { properties: { event: { const: event } } },
            ],
          }
        : event
          ? {
              type: "object",
              required: ["event", "data"],
              properties: {
                event: { const: event },
                data: { type: "object" },
              },
            }
          : {
              type: "object",
              required: [name],
              properties: { [name]: payload },
            }),
    };
    writeJson(pushFile(name), entry);
  }
}

// ---------------------------------------------------------------------------
// HTTP

/** Methods of the paths whose handler decides them (not paired in code). */
const HTTP_METHODS_BY_HAND: Record<string, string[]> = {
  "/health": ["get"],
  "/healthz": ["get"],
  "/login": ["get"],
  "/roamgate-icon-192.png": ["get"],
  "/ws": ["get"],
  "/api/logout": ["post"],
  "/api/health": ["get"],
  "/api/instance-settings": ["get", "put"],
  "/api/notifications/push": ["get", "post", "delete"],
  "/api/notifications/ws": ["get"],
  "/api/history": ["get", "put"],
  "/api/history/commit": ["post"],
  "/api/voice/ws": ["get"],
  "/api/voice/call/signalling": ["get"],
  "/api/voice/call/handoff": ["post"],
  "/api/voice/low-gpu": ["get", "post"],
  "/api/voice/speak": ["post"],
  "/api/voice/setup/cancel": ["post"],
  "/api/voice/setup/remove": ["post"],
  "/api/voice/setup": ["get", "post"],
  "/api/voice/voices/{id}": ["patch", "delete"],
  "/rendered/{token}/{path}": ["get", "head"],
  "/{static}": ["get", "head"],
};

const WEBSOCKET_PATHS = new Set([
  "/ws",
  "/api/notifications/ws",
  "/api/voice/ws",
  "/api/voice/call/signalling",
]);

function scaffoldHttp(found: Inventory): void {
  const path = "http/openapi.yaml";
  const doc = existsSync(join(CONTRACT, path))
    ? readYaml<Json>(path)
    : {
        openapi: "3.1.0",
        info: {
          title: "Roamgate HTTP routes",
          version: "1",
          description:
            "Every path of the listener, from scripts/contract/inventory.ts. Authentication: every route but /health, /healthz, the login routes, /login, the icon, the call handoff and /rendered/* requires the session cookie (or a loopback development listener). WebSocket routes are documented in contract/ws/asyncapi.yaml.",
        },
        paths: {},
      };
  const paths = doc.paths as Record<string, Record<string, Json>>;
  const pairs = new Map<string, string[]>();
  for (const pair of found.http_methods) {
    const [method, route] = pair.split(" ") as [string, string];
    pairs.set(route, [...(pairs.get(route) ?? []), method.toLowerCase()]);
  }
  for (const route of found.http) {
    const item = (paths[route] ??= {});
    const methods = [
      ...new Set([
        ...(pairs.get(route) ?? []),
        ...(HTTP_METHODS_BY_HAND[route] ?? []),
      ]),
    ];
    if (!methods.length) methods.push("get");
    for (const method of methods)
      item[method] ??= {
        summary: WEBSOCKET_PATHS.has(route)
          ? "WebSocket upgrade (see contract/ws/asyncapi.yaml)"
          : route,
        "x-status": "inventoried",
        responses: { default: { description: "See the handler." } },
      };
  }
  writeYaml(path, doc);
}

// ---------------------------------------------------------------------------
// WebSockets

function scaffoldWs(found: Inventory): void {
  const path = "ws/asyncapi.yaml";
  const doc = existsSync(join(CONTRACT, path))
    ? readYaml<Json>(path)
    : {
        asyncapi: "3.0.0",
        info: {
          title: "Roamgate WebSockets",
          version: "1",
          description:
            "The browser bridge /ws (its RPC and pushes are under contract/rpc and contract/push), the notification feed, the voice socket and a call's signalling.",
        },
        channels: {
          bridge: {
            address: "/ws",
            description:
              'Hello with bridge_protocol_version 2 and capabilities; requests {id, method, params, connection_id?, connection_generation?, lane?}; replies {id, result} or {id, error: {message, code?}}, enveloped per connection; chunks marked with \\u0001 and {"ack": n} flow-control windows of 64 KiB to 8 MiB; per-message deflate from 1 KiB with a dedicated compressor; backpressure 8 and 64 MiB, a 30 s stall closes the socket; close 4001 on logout.',
          },
          notifications: {
            address: "/api/notifications/ws",
            description: "The Android app's notification feed.",
            messages: {},
          },
          voice: {
            address: "/api/voice/ws",
            description: "Listening, speech and calls.",
            messages: {},
          },
          signalling: {
            address: "/api/voice/call/signalling",
            description:
              "A call's WebRTC signalling: relayed between the page and the voice helper's signalling server, which the server also reads.",
            messages: {},
          },
        },
        components: { messages: {} },
      };
  const components = (doc.components as Json).messages as Record<string, Json>;
  const channels = doc.channels as Record<string, Json>;
  for (const name of found.ws) {
    const [socket, direction, op] = name.split(" ") as [string, string, string];
    const key = `${socket}_${direction}_${op}`;
    if (components[key]) continue;
    components[key] = {
      "x-inventory": name,
      name: op,
      summary: `${direction === "in" ? "Received" : direction === "out" ? "Sent" : "Read from upstream"}: ${op}`,
      payload: { type: "object" },
      "x-status": "inventoried",
    };
    const channel = channels[socket]!;
    ((channel.messages ??= {}) as Json)[key] = {
      $ref: `#/components/messages/${key}`,
    };
  }
  writeYaml(path, doc);
}

// ---------------------------------------------------------------------------
// Agent socket

function scaffoldAgentSocket(found: Inventory): void {
  const path = "agent-socket/openapi.yaml";
  const doc = existsSync(join(CONTRACT, path))
    ? readYaml<Json>(path)
    : {
        openapi: "3.1.0",
        info: {
          title: "Roamgate agent socket",
          version: "1",
          description:
            "HTTP over the per-connection unix socket (0600 in a 0700 directory) that agents, the roamgate-review client, the holder and the Claude mod call. Every command is POST /v1/<command> with an application/x-www-form-urlencoded body, at most 1 MiB (hold_output: 64 MiB); replies are JSON, {error} with 400, 404, 413 or 500 on failure. watch and hold are long polls without a server timeout.",
        },
        paths: {},
      };
  const paths = doc.paths as Record<string, Json>;
  for (const name of found.agent_socket) {
    const route = name.slice("POST ".length);
    paths[route] ??= {
      post: {
        summary: route.slice("/v1/".length),
        "x-status": "inventoried",
        requestBody: {
          content: {
            "application/x-www-form-urlencoded": { schema: { type: "object" } },
          },
        },
        responses: {
          "200": {
            description: "The command's JSON reply.",
            content: { "application/json": { schema: {} } },
          },
        },
      },
    };
  }
  writeYaml(path, doc);
}

// ---------------------------------------------------------------------------
// CLI

async function scaffoldCli(): Promise<void> {
  const path = "cli/commands.json";
  const cli = (await import("../../server/src/cli/index")) as {
    cliCommands: () => {
      name: string;
      summary: string;
      actions?: readonly string[];
      flags?: readonly string[];
    }[];
  };
  const { SERVER_FLAGS } = (await import(
    "../../server/src/config/server-config"
  )) as { SERVER_FLAGS: string[] };
  const doc = existsSync(join(CONTRACT, path))
    ? readJson<Json>(path)
    : { commands: {}, server_flags: [] };
  const commands = doc.commands as Record<string, Json>;
  const goldens = await cliGoldens();
  for (const command of cli.cliCommands()) {
    const entry = (commands[command.name] ??= {
      summary: command.summary,
      help:
        `help/${command.name}.txt` in goldens
          ? `help/${command.name}.txt`
          : `help/${command.name}.stderr.txt`,
    });
    entry.actions = [
      ...new Set([
        ...((entry.actions as string[]) ?? []),
        ...(command.actions ?? []),
      ]),
    ];
    entry.flags = [
      ...new Set([
        ...((entry.flags as string[]) ?? []),
        ...(command.flags ?? []),
      ]),
    ];
  }
  doc.server_flags = [
    ...new Set([...(doc.server_flags as string[]), ...SERVER_FLAGS]),
  ];
  doc.top_level_help = "help/roamgate.txt";
  doc.server_help = "help/server.txt";
  writeJson(path, doc);
}

// ---------------------------------------------------------------------------
// Environment and processes: Markdown tables

/** `key` and `description` pairs of cli/config.ts's table. */
function configDescriptions(): Map<string, string> {
  const out = new Map<string, string>();
  walk(source("server/src/cli/config.ts"), (node) => {
    if (!ts.isObjectLiteralExpression(node)) return;
    let key: string | undefined;
    let description: string | undefined;
    for (const property of node.properties)
      if (ts.isPropertyAssignment(property)) {
        if (property.name.getText() === "key")
          key = literal(property.initializer);
        if (property.name.getText() === "description")
          description = literal(property.initializer);
      }
    if (key && description) out.set(key, description);
  });
  return out;
}

function appendRows(path: string, header: string, rows: string[]): void {
  const full = join(CONTRACT, path);
  const text = existsSync(full) ? readFileSync(full, "utf8") : header;
  write(path, `${text.trimEnd()}\n${rows.join("\n")}\n`);
}

function files(name: string): string {
  return whereFound(name)
    .map((path) => `\`${path.replace(/^server\/src\//, "")}\``)
    .join(", ");
}

function scaffoldEnv(names: string[]): void {
  const described = configDescriptions();
  const rows = names.map((name) => {
    const suffix = name.replace(/^(ROAMGATE|HERDR_GUI)_/, "");
    const alias = name.startsWith("HERDR_GUI_")
      ? `legacy name of \`ROAMGATE_${suffix}\`, which wins (an explicitly empty ROAMGATE_ value too)`
      : "";
    const description =
      described.get(name) ?? described.get(`ROAMGATE_${suffix}`) ?? "";
    return `| \`${name}\` | ${[description, alias].filter(Boolean).join("; ")} | ${files(name)} |`;
  });
  appendRows(
    "env.md",
    `# Environment variables

Every variable the server reads, from \`scripts/contract/inventory.ts\`
(\`roamgateEnv\` calls, reads of \`process.env\` and of the environments
passed down, the variables \`roamgate config\` and the service's env file
manage). \`ROAMGATE_<X>\` takes precedence over \`HERDR_GUI_<X>\`, including
an explicitly empty value; flags of the server override both.

| Name | Meaning | Read in |
|---|---|---|
`,
    rows,
  );
}

function scaffoldExec(names: string[]): void {
  const rows = names.map((name) => {
    const [kind] = name.split(" ");
    return `| \`${name}\` | ${kind === "spawn" ? "starts a process" : "program named literally"} | ${files(name)} |`;
  });
  appendRows(
    "exec.md",
    `# External processes

Every place the server starts a process (\`spawn <file>#<function>\`: Bun.spawn,
Bun.spawnSync and node:child_process), and every program named literally in
an argv given to them or to the server's runners (\`program <name>\`). The
fakes of the parity suite stand in for these programs.

| Name | Kind | Where |
|---|---|---|
`,
    rows,
  );
}

// ---------------------------------------------------------------------------
// Storage

const STORAGE_SCHEMAS: Record<string, string> = {
  "file:ledger.json": "../schemas/server.schema.json#/$defs/LedgerFile",
  "file:low-gpu.json": "../schemas/server.schema.json#/$defs/LowGpuFile",
  "file:taste.json": "../schemas/server.schema.json#/$defs/TasteFile",
  "file:companion-memory.json":
    "../schemas/server.schema.json#/$defs/MemoryFile",
};

function scaffoldStorage(names: string[]): void {
  const path = "storage/index.json";
  const doc = existsSync(join(CONTRACT, path))
    ? readJson<Json>(path)
    : {
        description:
          "Files and tables the server reads or writes. data:<path> is under the data root (~/.config/roamgate, %APPDATA%\\roamgate on Windows; legacy ~/.config/herdr-gui migrated by copy); file:<name> is a file joined by name anywhere (data, an agent's own files, service definitions); sqlite:<module>:<table> is a table the module creates, its DDL in sqlite/. Private files are 0600 in 0700 directories, opened with O_NOFOLLOW and checked for one link.",
        entries: {},
      };
  const entries = doc.entries as Record<string, Json>;
  for (const name of names) {
    const [kind, rest] = [
      name.slice(0, name.indexOf(":")),
      name.slice(name.indexOf(":") + 1),
    ];
    const entry: Json = { kind, used_in: whereFound(name) };
    if (kind === "sqlite") {
      const [module] = rest.split(":") as [string];
      entry.sql = `sqlite/${SQL_FILES[module] ?? "unknown.sql"}`;
    }
    if (STORAGE_SCHEMAS[name]) entry.schema = STORAGE_SCHEMAS[name];
    entry.status = "inventoried";
    entries[name] = entry;
  }
  doc.entries = Object.fromEntries(
    Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeJson(path, doc);
}

// ---------------------------------------------------------------------------

async function regenerate(): Promise<void> {
  for (const [file, text] of Object.entries(await cliGoldens()))
    write(`cli/${file}`, text);
  const statements = sqlStatements();
  for (const module of Object.keys(statements))
    if (!SQL_FILES[module])
      throw new Error(`${module} creates SQLite tables: add it to SQL_FILES`);
  const databases: Record<string, Record<string, string[]>> = {};
  for (const [module, file] of Object.entries(SQL_FILES))
    (databases[file] ??= {})[module] = statements[module] ?? [];
  for (const [file, sections] of Object.entries(databases))
    write(`storage/sqlite/${file}`, sqlFile(sections));
  writeSchemas();
}

if (import.meta.main) {
  if (process.argv.includes("--regenerate")) await regenerate();
  const found = await inventory();
  const { names: have } = contractNames();
  await scaffoldRpc(missing("rpc", found, have));
  scaffoldPushes(missing("push", found, have));
  scaffoldHttp(found);
  scaffoldWs(found);
  scaffoldAgentSocket(found);
  await scaffoldCli();
  scaffoldEnv(missing("env", found, have));
  scaffoldExec(missing("exec", found, have));
  scaffoldStorage(missing("storage", found, have));
  console.log(`inventory sha256: ${inventoryDigest(found)}`);
}
