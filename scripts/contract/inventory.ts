/**
 * The contract inventory: every name the Bun server exposes, read from the
 * code that defines it. `bun scripts/contract/inventory.ts` prints it as
 * JSON; `check.test.ts` compares it with the entries under `contract/`.
 *
 * Each extractor reads one surface where the code defines it (the dispatch
 * of handleRpc and the tables it delegates to, the fetch route chain, the
 * agent socket's command switch, the CLI command table...), and fails
 * loudly when the code takes a shape it does not know (a new delegated RPC
 * family, a route prefix nobody reads), so a change of surface is never
 * silent.
 */
import ts from "typescript-api";
import {
  comparedLiterals,
  enclosingFunction,
  functionName,
  functionsNamed,
  importedFrom,
  isFunctionLike,
  literal,
  pattern,
  source,
  sourceFiles,
  walk,
} from "./ast";

const SERVER = "server/src";
const INDEX = `${SERVER}/index.ts`;

export type Inventory = {
  /** Browser `/ws` RPC methods. */
  rpc: string[];
  /** Messages the server pushes on `/ws` without a request. */
  push: string[];
  /** HTTP paths of the listener. */
  http: string[];
  /** `METHOD path` pairs the route chain tests together. */
  http_methods: string[];
  /** Operations and events of the other WebSockets. */
  ws: string[];
  /** `POST /v1/<command>` of the agent socket. */
  agent_socket: string[];
  /** Management commands, their actions and flags, and the server flags. */
  cli: string[];
  /** Environment variables read. */
  env: string[];
  /** Files and directories under the data root, other named files, tables. */
  storage: string[];
  /** Places that start a process, and the programs named there. */
  exec: string[];
};

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** Where each name was found: files relative to the repository. */
const WHERE = new Map<string, Set<string>>();

/** The files a name of the inventory was read from. */
export function whereFound(name: string): string[] {
  return sorted(WHERE.get(name) ?? []);
}

function add(out: Set<string>, where: string, name: string): void {
  out.add(name);
  let files = WHERE.get(name);
  if (!files) WHERE.set(name, (files = new Set()));
  files.add(where);
}

/** A string constant, followed through relative imports. */
function stringConst(node: ts.Node): string | undefined {
  const text = literal(node);
  if (text !== undefined) return text;
  if (!ts.isIdentifier(node)) return undefined;
  const file = node.getSourceFile();
  return stringConstNamed(file, node.text);
}

function stringConstNamed(
  file: ts.SourceFile,
  name: string,
): string | undefined {
  let found: string | undefined;
  walk(file, (candidate) => {
    if (
      found === undefined &&
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
    )
      found = literal(candidate.initializer);
  });
  if (found !== undefined) return found;
  const imported = importedFrom(file, name);
  return imported
    ? stringConstNamed(source(imported.path), imported.name)
    : undefined;
}

/** The keys of a const object literal, followed through relative imports. */
function objectKeys(file: ts.SourceFile, name: string): string[] | undefined {
  let found: string[] | undefined;
  walk(file, (candidate) => {
    if (
      !found &&
      ts.isVariableDeclaration(candidate) &&
      ts.isIdentifier(candidate.name) &&
      candidate.name.text === name
    ) {
      let init = candidate.initializer;
      while (
        init &&
        (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))
      )
        init = init.expression;
      if (init && ts.isObjectLiteralExpression(init))
        found = init.properties.flatMap((property) =>
          property.name &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
            ? [property.name.text]
            : [],
        );
    }
  });
  if (found) return found;
  const imported = importedFrom(file, name);
  return imported
    ? objectKeys(source(imported.path), imported.name)
    : undefined;
}

/** The values of a string property over the members of a union type. */
function unionTags(path: string, typeName: string, property: string): string[] {
  const out: string[] = [];
  walk(source(path), (node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== typeName) return;
    walk(node.type, (member) => {
      if (
        ts.isPropertySignature(member) &&
        member.name.getText() === property &&
        member.type &&
        ts.isLiteralTypeNode(member.type) &&
        ts.isStringLiteral(member.type.literal)
      )
        out.push(member.type.literal.text);
    });
  });
  if (!out.length) throw new Error(`${path}: no ${typeName}.${property} tags`);
  return out;
}

// ---------------------------------------------------------------------------
// Browser RPC

/**
 * The families handleRpc hands to another module, by the test it uses: a
 * `method.startsWith(prefix)` or an `isXMethod(method)` predicate. A new
 * delegation fails the inventory until it is listed here.
 */
type Delegate = {
  /** Where the family's methods are told apart. */
  scopes: () => ts.Node[];
  /** The values its dispatch compares, and the prefix each gets. */
  subjects: Record<string, string>;
  /** Only the names with one of these prefixes are methods. */
  family: string[];
};

const wholeFile = (path: string) => (): ts.Node[] => [source(path)];
const fn = (path: string, name: string, containing?: string) => (): ts.Node[] =>
  functionsNamed(source(path), name, containing);

const RPC_DELEGATES: Record<string, Delegate | "inline"> = {
  "bridge.assistant.": {
    scopes: fn(
      `${SERVER}/assistant/service.ts`,
      "handle",
      "bridge\\.assistant",
    ),
    subjects: {
      method: "bridge.assistant.",
      operation: "bridge.assistant.task.",
    },
    family: ["bridge.assistant."],
  },
  isMrReviewsMethod: {
    scopes: () => [
      source(`${SERVER}/mr-reviews/rpc.ts`),
      source(`${SERVER}/mr-reviews/module.ts`),
    ],
    subjects: { method: "" },
    family: ["bridge.mr_reviews."],
  },
  isWorkMethod: {
    scopes: wholeFile(`${SERVER}/work/rpc.ts`),
    subjects: { method: "" },
    family: ["bridge.work."],
  },
  isAgentChatMethod: {
    scopes: wholeFile(`${SERVER}/conversation/rpc.ts`),
    subjects: { method: "" },
    family: ["agent_chat.", "agent_history."],
  },
  isReviewMethod: {
    scopes: wholeFile(`${SERVER}/review/rpc.ts`),
    subjects: { method: "" },
    family: ["review."],
  },
  "terminal.": {
    scopes: fn(`${SERVER}/bridge/terminal-bridge.ts`, "handleTerminalRpc"),
    subjects: { method: "" },
    family: ["terminal."],
  },
  "settings.": {
    scopes: wholeFile(`${SERVER}/bridge/settings-rpc.ts`),
    subjects: { method: "" },
    family: ["settings."],
  },
  "forward.": {
    scopes: fn(`${SERVER}/bridge/forward-rpc.ts`, "handleForwardRpc"),
    subjects: { method: "" },
    family: ["forward."],
  },
  "bridge.workspace_tree.": "inline",
  "connections.": "inline",
  "limit_resume.": "inline",
};

function predicateCalls(scope: ts.Node): Set<string> {
  const found = new Set<string>();
  walk(scope, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      /^is\w+Method$/.test(node.expression.text) &&
      node.arguments.length === 1 &&
      ts.isIdentifier(node.arguments[0]!) &&
      (node.arguments[0] as ts.Identifier).text === "method"
    )
      found.add(node.expression.text);
  });
  return found;
}

/** `TABLE[method]` with a constant object: its keys are methods. */
function keyedByMethod(scope: ts.Node): string[] {
  const out: string[] = [];
  const file = scope.getSourceFile();
  walk(scope, (node) => {
    if (
      ts.isElementAccessExpression(node) &&
      ts.isIdentifier(node.argumentExpression) &&
      node.argumentExpression.text === "method" &&
      ts.isIdentifier(node.expression)
    )
      out.push(...(objectKeys(file, node.expression.text) ?? []));
  });
  return out;
}

/** Each browser RPC method, with the file that tells it apart. */
export function rpcSources(): Map<string, string> {
  const [handleRpc] = functionsNamed(source(INDEX), "handleRpc");
  const own = comparedLiterals(handleRpc!, ["method"]);
  const methods = new Map<string, string>();
  for (const name of [...own.exact, ...keyedByMethod(handleRpc!)])
    methods.set(name, INDEX);
  // Any other method goes to Herdr as is, through the pane ownership
  // overlay: the pass-through is an entry of its own.
  let passThrough = false;
  walk(handleRpc!, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "withOwnedSessions"
    )
      passThrough = true;
  });
  if (!passThrough)
    throw new Error(
      "handleRpc no longer passes other methods to Herdr through withOwnedSessions: update the herdr pass-through entry and this check",
    );
  methods.set("*", INDEX);
  const delegations = [...own.prefixes, ...predicateCalls(handleRpc!)];
  for (const key of delegations) {
    const delegate = RPC_DELEGATES[key];
    if (!delegate)
      throw new Error(
        `handleRpc delegates "${key}" to code the contract inventory does not read: add it to RPC_DELEGATES in scripts/contract/inventory.ts`,
      );
    if (delegate === "inline") {
      if (![...methods.keys()].some((name) => name.startsWith(key)))
        throw new Error(`handleRpc lists no method of the family ${key}`);
      continue;
    }
    for (const scope of delegate.scopes())
      for (const [subject, prefix] of Object.entries(delegate.subjects))
        for (const name of comparedLiterals(scope, [subject]).exact) {
          const full = prefix + name;
          if (
            delegate.family.some((family) => full.startsWith(family)) &&
            !methods.has(full)
          )
            methods.set(full, scope.getSourceFile().fileName);
        }
  }
  for (const key of Object.keys(RPC_DELEGATES))
    if (!delegations.includes(key))
      throw new Error(
        `handleRpc no longer delegates "${key}": remove it from RPC_DELEGATES`,
      );
  return methods;
}

export function rpcMethods(): string[] {
  return sorted(rpcSources().keys());
}

// ---------------------------------------------------------------------------
// Pushes on /ws

/** The files that write to browser sockets without being asked. */
const PUSH_FILES = [INDEX, `${SERVER}/bridge/terminal-bridge.ts`];
/** Keys that start a reply or an envelope, not a push. */
const REPLY_KEYS = new Set(["id", "error", "result"]);
/** The other sockets have their own surface (ws). */
const OTHER_SOCKETS = new Set([
  `${SERVER}/http/voice-socket.ts`,
  `${SERVER}/notifications/notification-feed.ts`,
]);
/** Event templates, and where their variable part is listed. */
const EVENT_TEMPLATES: Record<string, () => string[]> = {
  "agent_chat.*": () =>
    unionTags("shared/agentChat.ts", "AgentChatEvent", "type"),
};

function propertyNamed(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (property): property is ts.PropertyAssignment =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  );
}

export function pushes(): string[] {
  const out = new Set<string>();
  for (const path of PUSH_FILES)
    walk(source(path), (node) => {
      if (
        !ts.isCallExpression(node) ||
        !/^(JSON\.stringify|serialize)$/.test(node.expression.getText())
      )
        return;
      const arg = node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) return;
      const first = arg.properties[0];
      if (!first || !first.name) return;
      const key = first.name.getText();
      if (!REPLY_KEYS.has(key)) add(out, path, key);
    });
  // Events in Herdr's shape, `{ event, data }`, sent along Herdr's own.
  for (const path of sourceFiles(SERVER)) {
    if (OTHER_SOCKETS.has(path)) continue;
    walk(source(path), (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const event = propertyNamed(node, "event");
      if (!event || !node.properties.some((p) => p.name?.getText() === "data"))
        return;
      const name = pattern(event.initializer);
      if (name === undefined) return;
      const expand = EVENT_TEMPLATES[name];
      if (name.includes("*") && !expand)
        throw new Error(
          `${path}: event template ${name} has no list of its values in EVENT_TEMPLATES`,
        );
      if (expand)
        for (const value of expand())
          add(out, path, `event:${name.replace("*", value)}`);
      else add(out, path, `event:${name}`);
    });
  }
  return sorted(out);
}

// ---------------------------------------------------------------------------
// HTTP routes

/** Handlers the fetch chain hands a path prefix to. */
const HTTP_PREFIX_DELEGATES: Record<string, () => ts.Node[]> = {
  "/api/history": wholeFile(`${SERVER}/http/history.ts`),
  "/api/voice": () => [
    source(`${SERVER}/http/voice.ts`),
    source(`${SERVER}/http/voice-setup.ts`),
    source(`${SERVER}/http/voice-low-gpu.ts`),
  ],
};

/** Whether a node compares `<x>.method` with a literal; gives the literal. */
function methodTest(node: ts.Node): string | undefined {
  if (!ts.isBinaryExpression(node)) return undefined;
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken)
    return undefined;
  const left = node.left;
  if (ts.isPropertyAccessExpression(left) && left.name.text === "method")
    return literal(node.right);
  return undefined;
}

function pathsIn(
  scopes: ts.Node[],
  paths: Set<string>,
  pairs: Set<string>,
): Set<string> {
  const prefixes = new Set<string>();
  for (const scope of scopes) {
    walk(scope, (node) => {
      // `pathname === "/a"` and `url.pathname === CONSTANT`.
      if (
        ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          node.operatorToken.kind ===
            ts.SyntaxKind.ExclamationEqualsEqualsToken) &&
        /(^|\.)pathname$/.test(node.left.getText())
      ) {
        const path = stringConst(node.right);
        if (path === undefined) return;
        paths.add(path);
        // `pathname === "/a" && req.method === "POST"`.
        const parent = node.parent;
        if (
          ts.isBinaryExpression(parent) &&
          parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        ) {
          const other = parent.left === node ? parent.right : parent.left;
          const method = methodTest(other);
          if (method) pairs.add(`${method} ${path}`);
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        /(^|\.)pathname$/.test(node.expression.expression.getText())
      ) {
        const call = node.expression.name.text;
        const arg = node.arguments[0];
        if (call === "startsWith" && arg) {
          const prefix = stringConst(arg);
          if (prefix !== undefined) prefixes.add(prefix);
        }
        // `pathname.slice("/a/b/".length)`: `/a/b/{id}`.
        if (
          call === "slice" &&
          arg &&
          ts.isPropertyAccessExpression(arg) &&
          arg.name.text === "length"
        ) {
          const prefix = stringConst(arg.expression);
          if (prefix !== undefined) paths.add(`${prefix}{id}`);
        }
      }
    });
  }
  return prefixes;
}

export function httpRoutes(): { paths: string[]; pairs: string[] } {
  const paths = new Set<string>();
  const pairs = new Set<string>();
  const [fetch] = functionsNamed(source(INDEX), "fetch", "rawRequestPathname");
  const prefixes = pathsIn([fetch!], paths, pairs);
  for (const prefix of prefixes) {
    const delegate = HTTP_PREFIX_DELEGATES[prefix];
    if (!delegate)
      throw new Error(
        `the fetch chain hands the prefix ${prefix} to code the contract inventory does not read: add it to HTTP_PREFIX_DELEGATES`,
      );
    pathsIn(delegate(), paths, pairs);
  }
  // A rendered review's page.
  const rendered = stringConstNamed(
    source("shared/renderedPage.ts"),
    "RENDERED_PREFIX",
  );
  if (!rendered) throw new Error("RENDERED_PREFIX not found");
  paths.add(`${rendered}{token}/{path}`);
  // Connection-scoped endpoints, and their legacy single-connection paths.
  walk(source(`${SERVER}/connections/http-routing.ts`), (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      node.name.getText() !== "ENDPOINTS" ||
      !node.initializer ||
      !ts.isArrayLiteralExpression(node.initializer)
    )
      return;
    for (const element of node.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const value = (name: string) => {
        const property = propertyNamed(element, name);
        return property ? literal(property.initializer) : undefined;
      };
      const method = value("method")!;
      const legacy = value("legacyPath")!;
      const scoped = `/api/connections/{connection_id}${value("suffix")}`;
      paths.add(legacy);
      paths.add(scoped);
      pairs.add(`${method} ${legacy}`);
      pairs.add(`${method} ${scoped}`);
    }
  });
  // Static files: everything else, from the built frontend.
  paths.add("/{static}");
  return { paths: sorted(paths), pairs: sorted(pairs) };
}

// ---------------------------------------------------------------------------
// The other WebSockets: notifications, voice, call signalling

export function socketNames(): string[] {
  const out = new Set<string>();
  const feed = source(`${SERVER}/notifications/notification-feed.ts`);
  for (const op of comparedLiterals(feed, ["op"]).exact)
    out.add(`notifications in ${op}`);
  const voice = source(`${SERVER}/http/voice-socket.ts`);
  const [message] = functionsNamed(voice, "message", "request.op");
  for (const op of comparedLiterals(message!, ["op"]).exact)
    out.add(`voice in ${op}`);
  // What the server sends: `{ event: ... }` on either socket.
  for (const [name, file] of [
    ["notifications", feed],
    ["voice", voice],
  ] as const)
    walk(file, (node) => {
      if (!ts.isObjectLiteralExpression(node)) return;
      const event = propertyNamed(node, "event");
      const value = event ? pattern(event.initializer) : undefined;
      if (value !== undefined) out.add(`${name} out ${value}`);
    });
  // The call's signalling relay reads the helper's signalling server.
  const [replies] = functionsNamed(voice, "watchReplies", "message.type");
  for (const type of comparedLiterals(replies!, ["type"]).exact)
    out.add(`signalling upstream ${type}`);
  return sorted(out);
}

// ---------------------------------------------------------------------------
// Agent socket

export function agentSocketCommands(): string[] {
  const file = source(`${SERVER}/review/agent-server.ts`);
  const commands = comparedLiterals(file, ["command"]).exact;
  return sorted([...commands].map((command) => `POST /v1/${command}`));
}

// ---------------------------------------------------------------------------
// CLI

type CliCommandShape = {
  name: string;
  actions?: readonly string[];
  flags?: readonly string[];
};

export async function cliNames(): Promise<string[]> {
  const cli = (await import(`../../${SERVER}/cli/index`)) as {
    cliCommands: () => CliCommandShape[];
  };
  const config = (await import(`../../${SERVER}/config/server-config`)) as {
    SERVER_FLAGS: string[];
  };
  const out = new Set<string>();
  for (const command of cli.cliCommands()) {
    out.add(command.name);
    for (const action of command.actions ?? [])
      out.add(`${command.name} ${action}`);
    for (const flag of command.flags ?? []) out.add(`${command.name} ${flag}`);
  }
  for (const flag of config.SERVER_FLAGS) out.add(`server ${flag}`);
  return sorted(out);
}

// ---------------------------------------------------------------------------
// Environment

/** Objects that hold an environment: `process.env`, `env`, `runtime.env`. */
const ENV_OBJECT = /(^|\.)(env|environment|Env)$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function isAssigned(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/**
 * The literal values an argument takes: itself, or, when it is a parameter
 * of the function around it, that argument of every call of the function
 * in the file (`megabytes("X_MB", ...)` calling `roamgateEnv(name)`).
 */
function wrappedLiterals(arg: ts.Expression): string[] {
  const text = literal(arg);
  if (text !== undefined) return [text];
  if (!ts.isIdentifier(arg)) return [];
  let at: ts.Node | undefined = arg.parent;
  while (at && !isFunctionLike(at)) at = at.parent;
  if (!at || !isFunctionLike(at)) return [];
  const index = at.parameters.findIndex(
    (parameter) =>
      ts.isIdentifier(parameter.name) && parameter.name.text === arg.text,
  );
  const name = functionName(at);
  if (index < 0 || !name) return [];
  const out: string[] = [];
  walk(arg.getSourceFile(), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      const value = literal(node.arguments[index]);
      if (value !== undefined) out.push(value);
    }
  });
  return out;
}

export function envNames(): string[] {
  const out = new Set<string>();
  for (const path of sourceFiles(SERVER))
    walk(source(path), (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "roamgateEnv"
      ) {
        const arg = node.arguments[0];
        const suffixes = arg ? wrappedLiterals(arg) : [];
        for (const suffix of suffixes) {
          add(out, path, `ROAMGATE_${suffix}`);
          add(out, path, `HERDR_GUI_${suffix}`);
        }
        return;
      }
      let object: ts.Expression | undefined;
      let name: string | undefined;
      if (ts.isPropertyAccessExpression(node)) {
        object = node.expression;
        name = node.name.text;
      } else if (ts.isElementAccessExpression(node)) {
        object = node.expression;
        // `env["X"]`, or `env[X_ENV]` with a string constant.
        name = stringConst(node.argumentExpression);
      }
      if (
        object &&
        name &&
        ENV_NAME.test(name) &&
        ENV_OBJECT.test(object.getText()) &&
        !isAssigned(node)
      )
        add(out, path, name);
    });
  // The variables `roamgate config` and the service's env file manage.
  for (const path of [
    `${SERVER}/cli/config.ts`,
    `${SERVER}/config/service-manager.ts`,
  ])
    walk(source(path), (node) => {
      if (
        (ts.isPropertyAssignment(node) &&
          node.name.getText() === "key" &&
          literal(node.initializer)?.startsWith("ROAMGATE_")) ||
        (ts.isCallExpression(node) &&
          node.expression.getText() === "readValue" &&
          literal(node.arguments[0]) !== undefined)
      ) {
        const name = ts.isPropertyAssignment(node)
          ? literal(node.initializer)!
          : literal(node.arguments[0])!;
        if (ENV_NAME.test(name)) add(out, path, name);
      }
    });
  return sorted(out);
}

// ---------------------------------------------------------------------------
// Storage

/** File names that hold data, when a path is joined to them. */
const DATA_FILE =
  /\.(json|jsonl|sqlite|db|bin|zst|lock|pid|env|plist|service|txt)$/;

function segment(node: ts.Node, depth = 0): string[] {
  const text = pattern(node);
  if (text !== undefined) return [text];
  if (ts.isConditionalExpression(node))
    return [
      ...segment(node.whenTrue, depth),
      ...segment(node.whenFalse, depth),
    ];
  if (ts.isParenthesizedExpression(node))
    return segment(node.expression, depth);
  // A local constant of the same function: `const filename = a ? b : c`.
  if (ts.isIdentifier(node) && depth < 3) {
    let at: ts.Node | undefined = node.parent;
    while (at && !isFunctionLike(at)) at = at.parent;
    let found: ts.Expression | undefined;
    if (at)
      walk(at, (inner) => {
        if (
          !found &&
          ts.isVariableDeclaration(inner) &&
          ts.isIdentifier(inner.name) &&
          inner.name.text === node.text &&
          inner.initializer
        )
          found = inner.initializer;
      });
    if (found) return segment(found, depth + 1);
  }
  return ["*"];
}

function isDataRootCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "dataRoot"
  );
}

/** Joined paths: every combination of the alternatives of each segment. */
function combinations(parts: string[][]): string[] {
  return parts.reduce<string[]>(
    (acc, options) =>
      acc.flatMap((head) => options.map((o) => (head ? `${head}/${o}` : o))),
    [""],
  );
}

export function storageNames(): string[] {
  const out = new Set<string>();
  for (const path of sourceFiles(SERVER)) {
    const file = source(path);
    walk(file, (node) => {
      // Everything joined onto the data root.
      if (isFunctionLike(node)) {
        const roots = new Set<string>();
        for (const parameter of node.parameters)
          if (
            ts.isIdentifier(parameter.name) &&
            parameter.initializer &&
            isDataRootCall(parameter.initializer)
          )
            roots.add(parameter.name.text);
        walk(node, (inner) => {
          if (
            ts.isVariableDeclaration(inner) &&
            ts.isIdentifier(inner.name) &&
            inner.initializer &&
            isDataRootCall(inner.initializer)
          )
            roots.add(inner.name.text);
        });
        walk(node.body ?? node, (inner) => {
          if (
            !ts.isCallExpression(inner) ||
            !ts.isIdentifier(inner.expression) ||
            inner.expression.text !== "join"
          )
            return;
          const [base, ...rest] = inner.arguments;
          if (!base || !rest.length) return;
          const anchored =
            isDataRootCall(base) ||
            (ts.isIdentifier(base) && roots.has(base.text));
          if (!anchored) return;
          for (const joined of combinations(rest.map((arg) => segment(arg))))
            add(out, path, `data:${joined}`);
        });
      }
      // `join(dataRoot(), ...)` outside any function.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "join" &&
        node.arguments[0] &&
        isDataRootCall(node.arguments[0]) &&
        node.arguments.length > 1 &&
        enclosingFunction(node) === "<module>"
      )
        for (const joined of combinations(
          node.arguments.slice(1).map((arg) => segment(arg)),
        ))
          add(out, path, `data:${joined}`);
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "defaultDataFile"
      ) {
        const name = literal(node.arguments[0]);
        if (name) add(out, path, `data:${name}`);
      }
      // Any file named by its last path segment.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "join"
      ) {
        const last = literal(node.arguments.at(-1));
        if (last && DATA_FILE.test(last)) add(out, path, `file:${last}`);
      }
      // SQLite tables.
      const text = pattern(node);
      if (
        text &&
        (ts.isStringLiteral(node) ||
          ts.isNoSubstitutionTemplateLiteral(node) ||
          ts.isTemplateExpression(node))
      )
        for (const match of text.matchAll(
          /CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)/g,
        ))
          add(out, path, `sqlite:${path.slice(SERVER.length + 1)}:${match[1]}`);
    });
  }
  // The data root itself, removed by joins such as `join(dataRoot(), x)`
  // where x is a variable.
  out.delete("data:*");
  return sorted(out);
}

/**
 * The SQL each database file creates, in source order: CREATE, ALTER,
 * DROP and PRAGMA statements, with substitutions kept as `${...}`.
 */
export function sqlStatements(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const path of sourceFiles(SERVER)) {
    const file = source(path);
    walk(file, (node) => {
      if (
        !ts.isStringLiteral(node) &&
        !ts.isNoSubstitutionTemplateLiteral(node) &&
        !ts.isTemplateExpression(node)
      )
        return;
      const text = ts.isTemplateExpression(node)
        ? node.getText(file).slice(1, -1)
        : node.text;
      if (
        !/^\s*(CREATE (TABLE|INDEX|UNIQUE INDEX|VIRTUAL TABLE|TRIGGER|VIEW)|ALTER TABLE|DROP (TABLE|INDEX|TRIGGER|VIEW)|PRAGMA) /.test(
          text,
        )
      )
        return;
      if (/^\s*PRAGMA\s+\w+\s*$/.test(text)) return; // a read
      (out[path.slice(SERVER.length + 1)] ??= []).push(
        text.replace(/\s+/g, " ").trim().replace(/;$/, ""),
      );
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// External processes

/** Functions that start a process from an argv. */
const PRIMITIVE_SPAWNERS = new Set(["Bun.spawn", "Bun.spawnSync"]);
const CHILD_PROCESS = new Set([
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
]);
/** The server's own runners: their first argument is an argv. */
const RUNNERS = new Set([
  "runProcess",
  "runProcessWithCode",
  "runProcessWithCodeTimeout",
  "runBinaryProcessWithTimeout",
  "runProcessWithInputTimeout",
  "spawnStreamingProcess",
  "runCommand",
  "captureCommand",
  // Injected runners: `exec(argv)`, `run(argv)`, `capture(argv)`.
  "exec",
  "run",
  "capture",
]);

/** Names of variables, and of functions returning one, that hold an argv. */
const ARGV_HOLDER = /(argv|^cmd|command)$/i;

/** How a file imports node:child_process: its functions, and the module. */
function childProcessImports(file: ts.SourceFile): {
  functions: Set<string>;
  modules: Set<string>;
} {
  const functions = new Set<string>();
  const modules = new Set<string>();
  for (const statement of file.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !/^(node:)?child_process$/.test(statement.moduleSpecifier.text)
    )
      continue;
    const clause = statement.importClause;
    // `import childProcess from` and `import * as childProcess from`.
    if (clause?.name) modules.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings))
      modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements)
        if (CHILD_PROCESS.has((element.propertyName ?? element.name).text))
          functions.add(element.name.text);
  }
  return { functions, modules };
}

/** What a program's name looks like: a word, an .exe, or an absolute path. */
const PROGRAM = /^([a-z][\w.+-]*|\/[\w/.-]+)$/;

function argvProgram(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isArrayLiteralExpression(node)) return literal(node.elements[0]);
  // `spawn("git", [...])` form of child_process.
  return literal(node);
}

export function execNames(): string[] {
  const out = new Set<string>();
  for (const path of sourceFiles(SERVER)) {
    const file = source(path);
    const imported = childProcessImports(file);
    walk(file, (node) => {
      if (!ts.isCallExpression(node)) return;
      const callee = node.expression.getText(file);
      const name = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : "";
      const primitive =
        PRIMITIVE_SPAWNERS.has(callee) ||
        (ts.isIdentifier(node.expression) && imported.functions.has(name)) ||
        (ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          imported.modules.has(node.expression.expression.text) &&
          CHILD_PROCESS.has(name));
      if (!primitive && !RUNNERS.has(name)) return;
      if (primitive)
        add(
          out,
          path,
          `spawn ${path.slice(SERVER.length + 1)}#${enclosingFunction(node)}`,
        );
      let first: ts.Expression | undefined = node.arguments[0];
      // `Bun.spawn({ cmd: [...] })`.
      if (first && ts.isObjectLiteralExpression(first)) {
        const cmd = propertyNamed(first, "cmd");
        first = cmd?.initializer;
      }
      // A string first argument is child_process's `spawn("git", [...])`.
      const program =
        first && !primitive && !ts.isArrayLiteralExpression(first)
          ? undefined
          : argvProgram(first);
      if (program !== undefined && PROGRAM.test(program))
        add(out, path, `program ${program}`);
    });
    // An argv built ahead: `const argv = ["git", ...]`, or returned by a
    // function such as `sshMasterArgv` or `fileManagerCommand`.
    walk(file, (node) => {
      if (!ts.isArrayLiteralExpression(node)) return;
      const program = literal(node.elements[0]);
      if (program === undefined || !PROGRAM.test(program)) return;
      const parent = node.parent;
      const held =
        (ts.isVariableDeclaration(parent) &&
          ts.isIdentifier(parent.name) &&
          ARGV_HOLDER.test(parent.name.text)) ||
        ((ts.isReturnStatement(parent) || ts.isArrowFunction(parent)) &&
          ARGV_HOLDER.test(enclosingFunction(node)));
      if (held) add(out, path, `program ${program}`);
    });
  }
  return sorted(out);
}

// ---------------------------------------------------------------------------
// Constants: versions and limits of the wire protocols and stores

/**
 * The constants the contract pins, as `<file>#<name>`: the source text of
 * each one's value. `server/src/index.ts#bridge_protocol_version` is the
 * property of the bridge's hello.
 */
export const PINNED_CONSTANTS = [
  "server/src/index.ts#bridge_protocol_version",
  "server/src/bridge/websocket-send.ts#WS_BACKPRESSURE_LIMIT_BYTES",
  "server/src/bridge/websocket-send.ts#WS_BACKPRESSURE_HARD_LIMIT_BYTES",
  "server/src/bridge/websocket-send.ts#WS_STALL_TIMEOUT_MS",
  "server/src/bridge/websocket-send.ts#WS_COALESCE_LIMIT_BYTES",
  "server/src/bridge/websocket-send.ts#WS_COMPRESSION_MIN_BYTES",
  "server/src/bridge/websocket-send.ts#WS_PER_MESSAGE_DEFLATE",
  "server/src/bridge/websocket-send.ts#WS_FLOW_INITIAL_WINDOW_CHARS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_MIN_WINDOW_CHARS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_MAX_WINDOW_CHARS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_TARGET_DELAY_MS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_RATE_SAMPLE_MS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_URGENT_CHARS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_CHUNK_CHARS",
  "server/src/bridge/websocket-send.ts#WS_FLOW_QUEUE_LIMIT_CHARS",
  "server/src/bridge/websocket-send.ts#WS_CHUNK_MARKER",
  "server/src/bridge/endpoint-surface.ts#MAX_FRAME",
  "server/src/review/agent-server.ts#REVIEW_AGENT_MAX_BODY_BYTES",
  "server/src/review/agent-server.ts#HOLD_OUTPUT_MAX_BODY_BYTES",
  "server/src/agent/claude-mod.ts#CLAUDE_MOD_PROTOCOL",
  "server/src/voice/voice-helper.ts#MAX_FRAME",
  "server/src/herdr/release.ts#VERIFIED_HERDR_VERSION",
  "server/src/bridge/protocol-compat.ts#MINIMUM_HERDR_PROTOCOL",
  "server/src/bridge/protocol-compat.ts#MAXIMUM_HERDR_PROTOCOL",
  "server/src/activity/store.ts#SCHEMA_VERSION",
  "server/src/review/storage.ts#SCHEMA_VERSION",
  "server/src/archive/store.ts#INDEX_VERSION",
] as const;

export function constants(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PINNED_CONSTANTS) {
    const [path, name] = key.split("#") as [string, string];
    const file = source(path);
    let text: string | undefined;
    walk(file, (node) => {
      if (text !== undefined) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer
      )
        text = node.initializer.getText(file);
      else if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(file) === name
      )
        text = node.initializer.getText(file);
    });
    if (text === undefined) throw new Error(`${key} not found`);
    out[key] = text.replace(/\s+/g, " ");
  }
  return out;
}

// ---------------------------------------------------------------------------

export async function inventory(): Promise<Inventory> {
  const http = httpRoutes();
  return {
    rpc: rpcMethods(),
    push: pushes(),
    http: http.paths,
    http_methods: http.pairs,
    ws: socketNames(),
    agent_socket: agentSocketCommands(),
    cli: await cliNames(),
    env: envNames(),
    storage: storageNames(),
    exec: execNames(),
  };
}

if (import.meta.main) {
  const result = await inventory();
  const counts = Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, value.length]),
  );
  if (process.argv.includes("--counts")) console.log(counts);
  else console.log(JSON.stringify(result, null, 2));
}
