/**
 * The internal channel's pure parts (contract/wire/core-channel.md): its
 * frames, the family of a method or path, routing by the owners table,
 * the side a read is shadowed on, the shadow comparison and the outbound
 * queue's coalescing. Held to contract/vectors/core-channel.json, which
 * the Rust side (roamgate-sidecar) reads too.
 */
import familiesFile from "../../../contract/owners/families.json";
import { encodeFrame, FRAME_JSON } from "../utils/frames";

/** The channel's protocol version, in `hello` and `welcome`. */
export const PROTOCOL = 1;
/** A message: one compact JSON object. */
export const KIND_MESSAGE = FRAME_JSON;
/** A body chunk: stream u32 LE, flags byte, bytes. */
export const KIND_BODY = 2;
export const CHANNEL_KINDS: ReadonlySet<number> = new Set([
  KIND_MESSAGE,
  KIND_BODY,
]);
/** The largest frame on the channel, length field's count. */
export const CHANNEL_MAX_FRAME = 64 * 1024 * 1024;
/** The most bytes of a body one chunk carries. */
export const BODY_CHUNK = 256 * 1024;
/** The most bytes of a body its sender keeps unacknowledged. */
export const BODY_WINDOW = 4 * 1024 * 1024;
/** Body chunk flags. */
export const FLAG_END = 1;
export const FLAG_RESPONSE = 2;

export type Side = "bun" | "rust";

export type Family = {
  test?: boolean;
  phase?: number;
  note?: string;
  rpc: string[];
  http: string[];
  files: string[];
  shadow: string[];
  /** CLI commands it answers (`roamgate <command>`). */
  cli?: string[];
};
export type Families = Record<string, Family>;
export type Owners = Record<string, string>;
/** What the front knows of the core: connected, and the families it has. */
export type CoreState = { connected: boolean; families: readonly string[] };

/** contract/owners/families.json's families. */
export const FAMILIES: Families = (
  familiesFile as unknown as { families: Families }
).families;

const encoder = new TextEncoder();

export function encodeMessage(message: Record<string, unknown>): Uint8Array {
  return encodeFrame(KIND_MESSAGE, encoder.encode(JSON.stringify(message)));
}

export function encodeBody(
  stream: number,
  flags: number,
  bytes: Uint8Array,
): Uint8Array {
  const payload = new Uint8Array(5 + bytes.length);
  new DataView(payload.buffer).setUint32(0, stream, true);
  payload[4] = flags;
  payload.set(bytes, 5);
  return encodeFrame(KIND_BODY, payload);
}

/** A body chunk's payload, or null when it is too short to be one. */
export function decodeBody(
  payload: Uint8Array,
): { stream: number; flags: number; bytes: Uint8Array } | null {
  if (payload.length < 5) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, 5);
  return {
    stream: view.getUint32(0, true),
    flags: payload[4]!,
    bytes: payload.slice(5),
  };
}

/**
 * The family whose list names `name`: an exact entry first, else the
 * longest entry ending with `separator` that starts it.
 */
function familyFor(
  name: string,
  families: Families,
  list: (family: Family) => string[],
  separator: string,
): string | null {
  let best: string | null = null;
  let bestLength = -1;
  for (const [family, entry] of Object.entries(families)) {
    for (const item of list(entry)) {
      if (item === name) return family;
      if (
        item.endsWith(separator) &&
        name.startsWith(item) &&
        item.length > bestLength
      ) {
        best = family;
        bestLength = item.length;
      }
    }
  }
  return best;
}

export function familyOf(method: string, families: Families): string | null {
  return familyFor(method, families, (entry) => entry.rpc, ".");
}

export function httpFamilyOf(path: string, families: Families): string | null {
  return familyFor(path, families, (entry) => entry.http, "/");
}

/**
 * The family a CLI command belongs to (exact names only): a `cli` entry
 * names a command, or a command and its first word (`setup voice`: the
 * other setups stay with their own command's family).
 */
export function cliFamilyOf(
  command: string,
  families: Families,
  args: readonly string[] = [],
): string | null {
  const first = args[0];
  const sub =
    first !== undefined && first !== "" && !first.startsWith("-")
      ? `${command} ${first}`
      : null;
  for (const [family, entry] of Object.entries(families))
    if (
      !entry.test &&
      (entry.cli?.includes(command) || (sub && entry.cli?.includes(sub)))
    )
      return family;
  return null;
}

/** Who serves `family` now (null: a name of no family, Bun's). */
export function familySide(
  family: string | null,
  families: Families,
  owners: Owners,
  core: CoreState,
  test: boolean,
): Side {
  if (family === null) return "bun";
  if (families[family]?.test && !test) return "bun";
  if (owners[family] !== "rust") return "bun";
  return core.connected && core.families.includes(family) ? "rust" : "bun";
}

/** Who answers a browser RPC: Rust only when given it and able to. */
export function routeRpc(
  method: string,
  families: Families,
  owners: Owners,
  core: CoreState,
  test: boolean,
): Side {
  return familySide(familyOf(method, families), families, owners, core, test);
}

/** Who serves an HTTP path, as routeRpc. */
export function routeHttp(
  path: string,
  families: Families,
  owners: Owners,
  core: CoreState,
  test: boolean,
): Side {
  return familySide(httpFamilyOf(path, families), families, owners, core, test);
}

/**
 * The side a read is shadowed on: the one that did not answer it, when it
 * has the family (Bun has every family in stage 1); null when the method
 * is not a shadowed read.
 */
export function shadowSide(
  method: string,
  families: Families,
  owners: Owners,
  core: CoreState,
  test: boolean,
): Side | null {
  const family = familyOf(method, families);
  if (family === null) return null;
  const entry = families[family]!;
  if (entry.test && !test) return null;
  if (!entry.shadow.includes(method)) return null;
  if (familySide(family, families, owners, core, test) === "rust") return "bun";
  return core.connected && core.families.includes(family) ? "rust" : null;
}

export type ShadowDifference = {
  path: string;
  kind: "missing" | "extra" | "type" | "length" | "value";
  owner?: string | number;
  other?: string | number;
};

function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function keyPath(path: string, key: string): string {
  return IDENTIFIER.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * The structural differences between the owner's result and the other
 * side's, the first `limit` of them, without the values themselves.
 */
export function shadowDiff(
  owner: unknown,
  other: unknown,
  limit = 20,
): { diffs: ShadowDifference[]; truncated: boolean } {
  const diffs: ShadowDifference[] = [];
  let truncated = false;
  const add = (difference: ShadowDifference): boolean => {
    if (diffs.length >= limit) {
      truncated = true;
      return false;
    }
    diffs.push(difference);
    return true;
  };
  const walk = (a: unknown, b: unknown, path: string): boolean => {
    const typeA = jsonType(a);
    const typeB = jsonType(b);
    if (typeA !== typeB)
      return add({ path, kind: "type", owner: typeA, other: typeB });
    if (typeA === "array") {
      const left = a as unknown[];
      const right = b as unknown[];
      if (
        left.length !== right.length &&
        !add({
          path,
          kind: "length",
          owner: left.length,
          other: right.length,
        })
      )
        return false;
      const count = Math.min(left.length, right.length);
      for (let index = 0; index < count; index++)
        if (!walk(left[index], right[index], `${path}[${index}]`)) return false;
      return true;
    }
    if (typeA === "object") {
      const left = a as Record<string, unknown>;
      const right = b as Record<string, unknown>;
      for (const key of Object.keys(left)) {
        const at = keyPath(path, key);
        if (!Object.hasOwn(right, key)) {
          if (!add({ path: at, kind: "missing" })) return false;
        } else if (!walk(left[key], right[key], at)) return false;
      }
      for (const key of Object.keys(right))
        if (
          !Object.hasOwn(left, key) &&
          !add({ path: keyPath(path, key), kind: "extra" })
        )
          return false;
      return true;
    }
    return a === b ? true : add({ path, kind: "value" });
  };
  walk(owner, other, "$");
  return { diffs, truncated };
}

/**
 * The queue one side writes its messages through: an item with a key
 * replaces a queued one with the same key, which leaves, the new one going
 * last. An item taken is never replaced.
 */
export class OutboundQueue<T = unknown> {
  private items: { item: T; key: string | null }[] = [];

  /** Queues `item`; the number queued after it. */
  enqueue(item: T, key: string | null = null): number {
    if (key !== null)
      this.items = this.items.filter((queued) => queued.key !== key);
    this.items.push({ item, key });
    return this.items.length;
  }

  /** The next item to write, or null. */
  take(): T | null {
    return this.items.shift()?.item ?? null;
  }

  size(): number {
    return this.items.length;
  }
}
