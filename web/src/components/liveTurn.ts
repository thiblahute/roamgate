import type {
  AgentChatEvent,
  AgentChatStreamedText,
} from "../../../shared/agentChat";
import {
  type InjectedNotice,
  parseInjectedMessage,
} from "../../../shared/injectedMessage";
import type { HistoryEntry } from "./agentHistory";
import { normalizedMessageText } from "./chatOutbox";

/**
 * What conversation mode streams of a turn before Claude Code's transcript
 * has it: the user messages it accepted, its reply text as it is written,
 * its tool calls and their results. Each item stays until the transcript's
 * own entry for it arrives (text by API message id and block index, tools
 * by tool_use id, user messages by uuid), so nothing flickers away nor
 * shows twice.
 */
export type LiveItem =
  | {
      kind: "user";
      key: string;
      uuid: string;
      text: string;
      images: number;
      at: number;
      /**
       * What Claude Code put in the turn itself (a subagent's report, a
       * task ending), before the user's words (`text`, often none).
       */
      notices?: InjectedNotice[];
    }
  | {
      kind: "text";
      key: string;
      message_id: string;
      index: number;
      text: string;
      done: boolean;
      at: number;
    }
  | {
      kind: "tool_call";
      key: string;
      tool_use_id: string;
      name: string;
      input: string;
      message_id: string;
      index: number;
      at: number;
    }
  | {
      kind: "tool_result";
      key: string;
      tool_use_id: string;
      text: string;
      is_error: boolean;
      at: number;
    };

export type LiveTurn = {
  items: readonly LiveItem[];
  /** Block types by `message_id:index`: only text blocks are drawn. */
  blocks: Readonly<Record<string, "text" | "thinking" | "tool_use">>;
  /** When the last turn ended (its result), null while one runs. */
  endedAt: number | null;
};

export const EMPTY_LIVE_TURN: LiveTurn = { items: [], blocks: {}, endedAt: 0 };

/**
 * How long an item of a finished turn waits for its transcript entry before
 * it is dropped anyway (a transcript that never records it, a missed push).
 */
export const LIVE_ITEM_GRACE_MS = 2 * 60_000;

const blockKey = (messageId: string, index: number) => `${messageId}:${index}`;

function withItems(turn: LiveTurn, items: readonly LiveItem[]): LiveTurn {
  return items === turn.items ? turn : { ...turn, items };
}

function inputText(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input ?? {});
  } catch {
    return "";
  }
}

/** The turn with one more event of the stream; the same object if unchanged. */
export function applyLiveEvent(
  turn: LiveTurn,
  event: AgentChatEvent,
  now: number,
): LiveTurn {
  switch (event.type) {
    case "block_start": {
      const key = blockKey(event.message_id, event.index);
      const blocks = { ...turn.blocks, [key]: event.block };
      const next = { ...turn, blocks, endedAt: null };
      if (event.block !== "text" || turn.items.some((item) => item.key === key))
        return next;
      return {
        ...next,
        items: [
          ...turn.items,
          {
            kind: "text",
            key,
            message_id: event.message_id,
            index: event.index,
            text: "",
            done: false,
            at: now,
          },
        ],
      };
    }
    case "delta": {
      const key = blockKey(event.message_id, event.index);
      const type = turn.blocks[key];
      if (type && type !== "text") return turn;
      const at = turn.items.findIndex((item) => item.key === key);
      if (at < 0)
        return {
          ...turn,
          endedAt: null,
          items: [
            ...turn.items,
            {
              kind: "text",
              key,
              message_id: event.message_id,
              index: event.index,
              text: event.text,
              done: false,
              at: now,
            },
          ],
        };
      const item = turn.items[at]!;
      if (item.kind !== "text") return turn;
      const items = turn.items.slice();
      items[at] = { ...item, text: item.text + event.text };
      return { ...turn, items };
    }
    case "block_stop": {
      const key = blockKey(event.message_id, event.index);
      const at = turn.items.findIndex((item) => item.key === key);
      if (at < 0) {
        // A whole text block without deltas (the CLI's assistant message).
        if (
          event.text === undefined ||
          !event.text.trim() ||
          (turn.blocks[key] && turn.blocks[key] !== "text")
        )
          return turn;
        return {
          ...turn,
          items: [
            ...turn.items,
            {
              kind: "text",
              key,
              message_id: event.message_id,
              index: event.index,
              text: event.text,
              done: true,
              at: now,
            },
          ],
        };
      }
      const item = turn.items[at]!;
      if (item.kind !== "text") return turn;
      const text = event.text ?? item.text;
      if (item.done && text === item.text) return turn;
      const items = turn.items.slice();
      items[at] = { ...item, text, done: true };
      return { ...turn, items };
    }
    case "abandoned":
      return withItems(
        turn,
        filterItems(
          turn.items,
          (item) =>
            !(
              (item.kind === "text" || item.kind === "tool_call") &&
              item.message_id === event.message_id &&
              item.index >= event.from_index
            ),
        ),
      );
    case "tool_use": {
      const key = `tool:${event.tool_use_id}`;
      const input = inputText(event.input);
      const at = turn.items.findIndex((item) => item.key === key);
      if (at >= 0) {
        const item = turn.items[at]!;
        if (item.kind !== "tool_call" || item.input === input) return turn;
        const items = turn.items.slice();
        items[at] = { ...item, input };
        return { ...turn, items };
      }
      return {
        ...turn,
        endedAt: null,
        items: [
          ...turn.items,
          {
            kind: "tool_call",
            key,
            tool_use_id: event.tool_use_id,
            name: event.name,
            input,
            message_id: event.message_id,
            index: event.index,
            at: now,
          },
        ],
      };
    }
    case "tool_result": {
      const key = `result:${event.tool_use_id}`;
      if (turn.items.some((item) => item.key === key)) return turn;
      return {
        ...turn,
        items: [
          ...turn.items,
          {
            kind: "tool_result",
            key,
            tool_use_id: event.tool_use_id,
            text: event.text,
            is_error: event.is_error,
            at: now,
          },
        ],
      };
    }
    case "user": {
      const key = `user:${event.uuid || now}`;
      if (turn.items.some((item) => item.key === key)) return turn;
      const injected = parseInjectedMessage(event.text);
      const text = injected ? injected.rest : event.text;
      const notices = injected?.notices ?? [];
      if (!text.trim() && !event.images && !notices.length) return turn;
      return {
        ...turn,
        endedAt: null,
        items: [
          ...turn.items,
          {
            kind: "user",
            key,
            uuid: event.uuid,
            text,
            images: event.images,
            at: now,
            ...(notices.length ? { notices } : {}),
          },
        ],
      };
    }
    case "result": {
      // What was being written ends here: an interrupted block keeps its
      // partial text, as Claude Code does.
      const items = turn.items.map((item) =>
        item.kind === "text" && !item.done ? { ...item, done: true } : item,
      );
      return {
        items: items.some((item, index) => item !== turn.items[index])
          ? items
          : turn.items,
        blocks: {},
        endedAt: now,
      };
    }
    case "session":
      // /clear: another conversation, another transcript.
      return { items: [], blocks: {}, endedAt: now };
    default:
      return turn;
  }
}

/**
 * The turn with the reply text the bridge says it already streamed (a
 * subscription in the middle of a turn, after a reload or a reconnect): a
 * block drawn from the deltas since then only, or not drawn at all, gets
 * all of its text. The same object if unchanged.
 */
export function withStreamedText(
  turn: LiveTurn,
  streamed: readonly AgentChatStreamedText[] | undefined,
  now: number,
): LiveTurn {
  if (!streamed?.length) return turn;
  let items = turn.items;
  let blocks = turn.blocks;
  for (const block of streamed) {
    if (!block.text) continue;
    const key = blockKey(block.message_id, block.index);
    const at = items.findIndex((item) => item.key === key);
    const item = at >= 0 ? items[at]! : null;
    if (item && item.kind !== "text") continue;
    // What came here since: more than the bridge had then.
    if (item?.text.startsWith(block.text)) continue;
    if (blocks[key] !== "text") blocks = { ...blocks, [key]: "text" };
    const next: LiveItem = {
      kind: "text",
      key,
      message_id: block.message_id,
      index: block.index,
      text: block.text,
      done: block.done || !!item?.done,
      at: item?.at ?? now,
    };
    items = item
      ? items.map((each, index) => (index === at ? next : each))
      : [...items, next];
  }
  if (items === turn.items && blocks === turn.blocks) return turn;
  return { ...turn, items, blocks, endedAt: null };
}

function filterItems(
  items: readonly LiveItem[],
  keep: (item: LiveItem) => boolean,
): readonly LiveItem[] {
  const kept = items.filter(keep);
  return kept.length === items.length ? items : kept;
}

const textKey = (messageId: string, text: string) =>
  `${messageId}\u0000${text.trim()}`;

/** The transcript's assistant texts, by API message. */
function assistantTexts(history: readonly HistoryEntry[]): Set<string> {
  const texts = new Set<string>();
  for (const entry of history)
    if (entry.message_id !== undefined && entry.kind === "message")
      texts.add(textKey(entry.message_id, entry.text));
  return texts;
}

/** The user messages of the transcript's last few turns, to match by text. */
function recentUserTexts(history: readonly HistoryEntry[]): Set<string> {
  const texts = new Set<string>();
  let seen = 0;
  for (let at = history.length - 1; at >= 0 && seen < 12; at -= 1) {
    const entry = history[at]!;
    if (entry.kind !== "message" || entry.role !== "user" || entry.injected)
      continue;
    seen += 1;
    texts.add(normalizedMessageText(entry.text));
  }
  return texts;
}

/**
 * Drops the items the transcript now shows, and those of a finished turn it
 * never showed in time. The same object when nothing changes.
 */
export function reconcileLiveTurn(
  turn: LiveTurn,
  history: readonly HistoryEntry[],
  now: number,
  graceMs = LIVE_ITEM_GRACE_MS,
): LiveTurn {
  if (!turn.items.length) return turn;
  const blocks = new Set<string>();
  const calls = new Set<string>();
  const results = new Set<string>();
  const uuids = new Set<string>();
  for (const entry of history) {
    if (entry.message_id !== undefined && entry.block_index !== undefined)
      blocks.add(blockKey(entry.message_id, entry.block_index));
    if (entry.source_call_id)
      (entry.kind === "tool_result" ? results : calls).add(
        entry.source_call_id,
      );
    if (entry.uuid && entry.role === "user") uuids.add(entry.uuid);
  }
  let userTexts: Set<string> | null = null;
  let messageTexts: Set<string> | null = null;
  const expired = (item: LiveItem) =>
    turn.endedAt !== null && now - Math.max(item.at, turn.endedAt) > graceMs;
  return withItems(
    turn,
    filterItems(turn.items, (item) => {
      if (expired(item)) return false;
      switch (item.kind) {
        case "text":
          if (blocks.has(item.key)) return false;
          if (!item.done) return true;
          // A block whose index went astray is still the transcript's by
          // its words, in the same API message.
          messageTexts ??= assistantTexts(history);
          return !messageTexts.has(textKey(item.message_id, item.text));
        case "tool_call":
          return !calls.has(item.tool_use_id);
        case "tool_result":
          return !results.has(item.tool_use_id);
        case "user":
          if (item.uuid && uuids.has(item.uuid)) return false;
          // A transcript that carries uuids shows this one by its own: the
          // same words said earlier are another message.
          if (item.uuid && uuids.size) return true;
          // Notices only: the transcript has them by uuid, or never.
          if (!item.text.trim() && !item.images) return true;
          userTexts ??= recentUserTexts(history);
          return !userTexts.has(normalizedMessageText(item.text));
      }
      return true;
    }),
  );
}

/**
 * The items as chat entries, after the transcript's: provisional ids
 * (`live:`) so a bubble never takes a transcript entry's place.
 */
export function liveTurnEntries(turn: LiveTurn): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const item of turn.items) {
    const sent_at = new Date(item.at).toISOString();
    switch (item.kind) {
      case "user":
        for (const [at, notice] of (item.notices ?? []).entries())
          entries.push({
            id: `live:${item.key}:${at}`,
            role: "user",
            kind: "message",
            text: notice.body.trim() || notice.label,
            sent_at,
            injected: { kind: notice.kind, label: notice.label },
            ...(item.uuid ? { uuid: item.uuid } : {}),
          });
        if (!item.text.trim() && !item.images) break;
        entries.push({
          id: `live:${item.key}`,
          role: "user",
          kind: "message",
          text:
            item.text ||
            (item.images === 1 ? "[an image]" : `[${item.images} images]`),
          sent_at,
          ...(item.uuid ? { uuid: item.uuid } : {}),
        });
        break;
      case "text":
        if (!item.text.trim()) break;
        entries.push({
          id: `live:${item.key}`,
          role: "assistant",
          kind: "message",
          text: item.text,
          sent_at,
          message_id: item.message_id,
          block_index: item.index,
        });
        break;
      case "tool_call":
        entries.push({
          id: `live:${item.key}`,
          role: "tool",
          kind: "tool_call",
          text: item.input,
          sent_at,
          tool_name: item.name,
          source_call_id: item.tool_use_id,
        });
        break;
      case "tool_result":
        entries.push({
          id: `live:${item.key}`,
          role: "tool",
          kind: "tool_result",
          text: item.text,
          sent_at,
          source_call_id: item.tool_use_id,
          ...(item.is_error ? { is_error: true } : {}),
        });
        break;
    }
  }
  return entries;
}
