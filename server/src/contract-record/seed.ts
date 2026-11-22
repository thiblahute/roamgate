import { type Classified, Classifier, readRecordings } from "./corpus";

/**
 * Turns part of a contract recording into the seed of a T1 scenario (the
 * Rust migration plan, section 5.4): one browser socket's calls with the
 * reply each got and the pushes in between, in order, plus the HTTP,
 * agent socket and CLI exchanges and the processes run in the same span
 * (the answers the fakes must give). A seed is a starting point: a person
 * trims it, and the parity harness's normalizers (contract/normalize.json)
 * replace ids and times when it is run.
 */

export type SeedOptions = {
  /** The browser socket to follow (`list` shows them); all when absent. */
  sock?: string;
  /** ISO times bounding the span. */
  from?: string;
  to?: string;
  /** Push names left out; `terminal` (screen bytes) unless keepAll. */
  dropPushes?: readonly string[];
  keepAll?: boolean;
  name?: string;
};

type Step = Record<string, unknown>;

export type Seed = {
  name: string;
  recorded: { from?: string; to?: string; sock?: string; files: string[] };
  steps: Step[];
  /** What the fakes answered: the processes run, in order. */
  fakes: Step[];
};

const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** ISO timestamps as `{{time}}`: the scenario runner's clock decides them. */
export function normalizeTimes(value: unknown): unknown {
  if (typeof value === "string")
    return ISO_TIME.test(value) ? "{{time}}" : value;
  if (Array.isArray(value)) return value.map(normalizeTimes);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      out[key] = normalizeTimes(item);
    return out;
  }
  return value;
}

export type SocketSummary = {
  sock: string;
  channel: string;
  from: string;
  to: string;
  calls: number;
  pushes: number;
  methods: Record<string, number>;
};

/** The sockets of a recording, to pick one to seed from. */
export function listSockets(paths: readonly string[]): SocketSummary[] {
  const classifier = new Classifier();
  const sockets = new Map<string, SocketSummary>();
  for (const record of readRecordings(paths)) {
    if (!record.sock) continue;
    const message = classifier.classify(record);
    const summary =
      sockets.get(record.sock) ??
      ({
        sock: record.sock,
        channel: record.ch,
        from: record.t,
        to: record.t,
        calls: 0,
        pushes: 0,
        methods: {},
      } satisfies SocketSummary);
    summary.to = record.t;
    if (message?.surface === "rpc.request") {
      summary.calls += 1;
      summary.methods[message.name] = (summary.methods[message.name] ?? 0) + 1;
    } else if (message?.surface === "push") summary.pushes += 1;
    sockets.set(record.sock, summary);
  }
  return [...sockets.values()];
}

function within(t: string, options: SeedOptions): boolean {
  if (options.from && t < options.from) return false;
  if (options.to && t > options.to) return false;
  return true;
}

/** A scenario seed from a recording. */
export function seedScenario(
  paths: readonly string[],
  options: SeedOptions = {},
): Seed {
  const drop = new Set(
    options.keepAll ? [] : (options.dropPushes ?? ["terminal"]),
  );
  const classifier = new Classifier();
  const steps: Step[] = [];
  const fakeRuns: { t: string; step: Step }[] = [];
  const files = new Set<string>();
  /** A call's step, by socket and id, until its reply arrives. */
  const open = new Map<string, Step>();
  let pushes: Step[] | null = null;
  let first: string | undefined;
  let last: string | undefined;

  const touch = (message: Classified) => {
    files.add(message.record.file);
    first ??= message.record.t;
    last = message.record.t;
  };

  for (const record of readRecordings(paths)) {
    const message = classifier.classify(record);
    if (!message || !within(record.t, options)) continue;
    const ownSocket = !options.sock || record.sock === options.sock;
    switch (message.surface) {
      case "rpc.request": {
        if (!ownSocket) break;
        touch(message);
        pushes = null;
        const msg = record.msg as Record<string, unknown>;
        const step: Step = {
          call: message.name,
          params: normalizeTimes(message.payload),
          ...(msg.connection_id !== undefined
            ? { connection: msg.connection_id }
            : {}),
        };
        steps.push(step);
        if (msg.id !== undefined)
          open.set(`${record.sock}\u0000${String(msg.id)}`, step);
        break;
      }
      case "rpc.reply": {
        if (!ownSocket) break;
        const id = (record.msg as Record<string, unknown>).id;
        const key = `${record.sock}\u0000${String(id)}`;
        const step = open.get(key);
        if (!step) break;
        touch(message);
        open.delete(key);
        step[message.error ? "error" : "reply"] = normalizeTimes(
          message.payload,
        );
        break;
      }
      case "push": {
        if (!ownSocket || drop.has(message.name)) break;
        touch(message);
        if (!pushes) {
          pushes = [];
          steps.push({ expect_pushes: pushes });
        }
        const msg = record.msg as Record<string, unknown>;
        pushes.push({
          push: message.name,
          ...(msg.connection_id !== undefined
            ? { connection: msg.connection_id }
            : {}),
          message: normalizeTimes(message.payload),
        });
        break;
      }
      case "http":
      case "agent":
      case "mcp": {
        if (options.sock) break;
        // Static files are the build's, not the scenario's.
        if (
          message.surface === "http" &&
          /^GET \/(assets\/|[^/]*\.(?:js|css|png|svg|ico|webmanifest|json)$)/.test(
            message.name,
          )
        )
          break;
        touch(message);
        pushes = null;
        steps.push({
          [message.surface]:
            message.surface === "agent"
              ? message.name
              : `${message.request?.method} ${message.request?.path}`,
          ...(message.request?.query ? { query: message.request.query } : {}),
          ...(message.request?.body !== undefined
            ? { body: normalizeTimes(message.request.body) }
            : {}),
          expect: {
            status: message.status ?? (record.upgrade ? 101 : undefined),
            ...(message.payload !== undefined
              ? { body: normalizeTimes(message.payload) }
              : {}),
          },
        });
        break;
      }
      case "cli": {
        if (options.sock) break;
        touch(message);
        pushes = null;
        steps.push({
          cli: record.argv,
          expect: {
            exit: record.exit,
            stdout: record.stdout,
            stderr: record.stderr || undefined,
          },
        });
        break;
      }
      case "spawn": {
        fakeRuns.push({
          t: record.t,
          step: { run: record.argv, cwd: record.cwd, exit: record.code },
        });
        break;
      }
      default:
        break;
    }
  }
  // A socket's seed gets the processes run while it was open.
  const fakes = fakeRuns
    .filter(
      ({ t }) =>
        !options.sock ||
        (first !== undefined && last !== undefined && t >= first && t <= last),
    )
    .map(({ step }) => step);
  return {
    name:
      options.name ??
      `seed-${(options.sock ?? "all").replace(/[^a-z0-9-]/gi, "-")}-${(first ?? "empty").replace(/[^0-9T]/g, "").slice(0, 15)}`,
    recorded: { from: first, to: last, sock: options.sock, files: [...files] },
    steps,
    fakes,
  };
}

/** A seed as YAML, with a header saying where it came from. */
export function seedYaml(seed: Seed): string {
  return `# Scenario seed from a contract recording (scripts/contract-record.ts seed).\n# Review it, trim it and name its steps before it becomes a parity case.\n${Bun.YAML.stringify(
    JSON.parse(JSON.stringify(seed)),
    null,
    2,
  )}\n`;
}
