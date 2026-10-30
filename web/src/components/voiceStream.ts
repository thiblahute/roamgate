import type { AgentChatEvent } from "../../../shared/agentChat";
import { parseInjectedMessage } from "../../../shared/injectedMessage";

/** What voice says when Claude stops to ask something. */
export const BLOCKED_NOTICE =
  "Claude is asking something; answer it on the screen.";

/**
 * A turn of conversation mode as text to read aloud while it is written:
 * the reply's text deltas, a paragraph break at the end of each block (so
 * its last sentence is read without waiting), a notice when Claude asks
 * something, and the end on the result of the turn that took the message
 * (however it went: on its own, queued and merged, steered in). Turns
 * Claude starts by itself before it are read too. Fed with the stream's events
 * (`handle`), read by speakStream (`text`).
 */
export function createTurnFeed(awaited: { uuid?: string; text?: string } = {}) {
  // The reply starts after the CLI took the message (its replay): what came
  // before belongs to the turn it interrupted, or steered.
  let started = !awaited.uuid && !awaited.text;
  const awaitedText = (awaited.text ?? "").replace(/\s+/g, " ").trim();
  // The CLI took the message: until then a turn's end is not its answer's
  // (a message steered in may still run as a turn of its own after it).
  let replayed = started;
  const chunks: string[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  let blocked = false;
  // Text blocks by message id and index, and how much of each was given.
  const blocks = new Map<string, { text: boolean; given: number }>();
  const ids: string[] = [];
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const push = (text: string) => {
    if (ended || !started || !text) return;
    chunks.push(text);
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const end = () => {
    if (ended) return;
    ended = true;
    resolveDone();
    const resolve = wake;
    wake = null;
    resolve?.();
  };
  const blockKey = (messageId: string, index: number) =>
    `${messageId}:${index}`;

  return {
    /** Resolves when the turn ended (its result) or `close` was called. */
    done,
    /** The live chat ids of the text being read, for highlighting. */
    ids: () => ids,
    handle(event: AgentChatEvent) {
      if (event.type === "user" && !replayed) {
        // What Claude Code put in the turn (a subagent's report, a task
        // ending) is not the message said, even when it quotes it.
        const injected = parseInjectedMessage(event.text);
        const text = (injected ? injected.rest : event.text)
          .replace(/\s+/g, " ")
          .trim();
        if (
          (!injected || text) &&
          ((awaited.uuid && event.uuid === awaited.uuid) ||
            (awaitedText && text.includes(awaitedText)))
        ) {
          // Its own turn, or merged with others queued: read from here.
          replayed = true;
          started = true;
        } else if (injected && !text) {
          // Claude answers a report or a task ending first: read that too,
          // on to the message's own turn.
          started = true;
        }
        return;
      }
      if (!started) {
        if (event.type === "session") end();
        return;
      }
      switch (event.type) {
        case "block_start": {
          const key = blockKey(event.message_id, event.index);
          blocks.set(key, { text: event.block === "text", given: 0 });
          if (event.block === "text") ids.push(`live:${key}`);
          return;
        }
        case "delta": {
          const key = blockKey(event.message_id, event.index);
          let block = blocks.get(key);
          if (!block) {
            block = { text: true, given: 0 };
            blocks.set(key, block);
            ids.push(`live:${key}`);
          }
          if (!block.text) return;
          block.given += event.text.length;
          push(event.text);
          return;
        }
        case "block_stop": {
          const key = blockKey(event.message_id, event.index);
          const block = blocks.get(key);
          if (block && !block.text) return;
          // A block that came whole, without deltas.
          if (!block?.given && event.text) {
            if (!block) ids.push(`live:${key}`);
            blocks.set(key, { text: true, given: event.text.length });
            push(event.text);
          }
          push("\n\n");
          return;
        }
        case "status":
          if (event.status === "blocked" && !blocked)
            push(`\n\n${BLOCKED_NOTICE}\n\n`);
          blocked = event.status === "blocked";
          return;
        case "result":
          push("\n\n");
          // Steered in, not taken yet: its answer may be the next turn.
          if (replayed) end();
          return;
        case "session":
          push("\n\n");
          end();
          return;
        default:
          return;
      }
    },
    /** Ends the text: nothing more is read. */
    close: end,
    /** Reads from now on, without waiting for the message's replay. */
    start() {
      started = true;
    },
    started: () => started,
    /** The turn ended (its result), or the feed was closed. */
    ended: () => ended,
    text: {
      [Symbol.asyncIterator](): AsyncIterator<string> {
        return {
          async next(): Promise<IteratorResult<string>> {
            while (!chunks.length && !ended)
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            if (chunks.length)
              return { value: chunks.splice(0).join(""), done: false };
            return { value: undefined, done: true };
          },
        };
      },
    } as AsyncIterable<string>,
  };
}

export type TurnFeed = ReturnType<typeof createTurnFeed>;

/** A turn Claude started by itself, read from its start. */
export type ClaudeTurn = { feed: TurnFeed; unsubscribe: () => void };

/**
 * Whether a user replay is one Claude Code wrote itself (a subagent's
 * report, a task ending, another session's message): the turn it starts
 * answers no message said.
 */
export function isInjectedReplay(event: AgentChatEvent): boolean {
  if (event.type !== "user" || event.images) return false;
  const injected = parseInjectedMessage(event.text);
  return !!injected && !injected.rest;
}

/**
 * Watches the stream for the turns Claude starts by itself, so voice reads
 * them too: on an injected replay while no reading follows a turn
 * (`reading()` is null or ended), a feed reading from there on is handed
 * to `onTurn`. One during a turn being read is part of it: nothing.
 */
export function watchClaudeTurns(
  subscribe: (listener: (event: AgentChatEvent) => void) => () => void,
  reading: () => TurnFeed | null,
  onTurn: (turn: ClaudeTurn) => void,
): () => void {
  return subscribe((event) => {
    if (!isInjectedReplay(event)) return;
    const current = reading();
    if (current && !current.ended()) return;
    const feed = createTurnFeed();
    const unsubscribe = subscribe(feed.handle);
    onTurn({
      feed,
      unsubscribe: () => {
        feed.close();
        unsubscribe();
      },
    });
  });
}
