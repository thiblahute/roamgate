import {
  type AgentCommand,
  asCommand,
  commandEnv,
  commandKey,
  helperCommand,
} from "../profiles/profiles";
import { tmpdir } from "node:os";
import type { BackgroundMemoryLaunch } from "../conversation/drivers/types";
import type { VoiceConfig } from "./voice-helper";

/**
 * Voice chat's cleaner: what the user said goes through a language model
 * before it is sent, which drops fillers, false starts and misheard words,
 * and tells whether it was said to the agent at all (or to someone in the
 * room). It runs on Claude Code sessions kept running in the background
 * (`claude -p` reading messages from stdin), so each request costs only the
 * model's answer.
 *
 * To keep that off the end of a turn, settled sentences are cleaned while
 * the user still talks, and the end is cleaned as soon as they pause: by
 * the time the pause is judged final, the clean text is mostly ready.
 */

export const CLEANER_SYSTEM_PROMPT = `You clean up voice transcripts before they reach a coding agent (Claude Code). Speech recognition mishears names and technical words (Claude may come out as "cloud" or "clot"), and people talking nearby can be picked up too. Each request gives the end of the conversation with the agent, for context, then part of what the user just said aloud.

Reply with one JSON object and nothing else.

A request marked PIECE holds the first sentences of what the user is saying; more follows. Reply {"for_agent": true|false, "text": "..."}.

A request marked END holds the rest of it, after "Cleaned so far" (what the earlier pieces became, possibly empty). Reply {"for_agent": true|false, "text": "...", "fixes": [{"from": "...", "to": "..."}]}: text is the rest, cleaned; fixes (usually none) change words of "Cleaned so far" that the rest shows to be wrong, as when the user corrects themselves ("X, not Y, I meant").

- for_agent: false only when the words are clearly not addressed to the agent: talk with someone else in the room, background voices, TV. When unsure, true.
- text: the words made clean: remove fillers (um, uh, euh, you know...), false starts ("with a, uh, the file" is "with the file"), stutters and repeated words; fix misheard words from the conversation; when the user corrects themselves keep only what they meant. Keep the user's language, meaning, tone and first person. Never answer the words, add to them, summarize them or translate them. With nothing left, "".`;

export type CleanerReply = {
  for_agent?: boolean;
  text?: string;
  fixes?: { from?: string; to?: string }[];
};

/** Asks the model; resolves to its parsed reply. */
export type CleanerAsk = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<CleanerReply>;

export type Cleaned = { text: string; forAgent: boolean };

/** Sentences, each with its end punctuation. */
export function sentences(text: string): string[] {
  return (text.match(/[^.?!…]+(?:[.?!…]+|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

export function parseCleanerReply(text: string): CleanerReply {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error(`Not JSON: ${text}`);
  const reply = JSON.parse(text.slice(start, end + 1)) as CleanerReply;
  if (typeof reply.text !== "string") throw new Error(`No text: ${text}`);
  return reply;
}

/** The longest run of `prefix` items that starts `list`. */
function shared(list: readonly string[], prefix: readonly string[]): number {
  let n = 0;
  while (n < list.length && n < prefix.length && list[n] === prefix[n]) n += 1;
  return n;
}

type Piece = {
  sentences: string[];
  reply: Promise<CleanerReply | null>;
};

/**
 * One utterance's cleaning: `partial` hears the transcript so far (again
 * and again, as the transcriber reads the whole utterance each time),
 * `final` gives the clean text. A failing or slow model gives the words as
 * they were heard.
 */
export class CleanSession {
  private pieces: Piece[] = [];
  private settled: string[] = [];
  private ends = new Map<string, Promise<Cleaned>>();
  private aborted = new AbortController();
  /**
   * The last `final` gave the words as heard: the model failed, was too
   * slow, or its reply was refused.
   */
  fellBack = false;

  constructor(
    private readonly ask: CleanerAsk,
    private readonly context: string,
    private readonly timeoutMs = 6000,
    /** What the context is, as the requests name it. */
    private readonly contextLabel = "Conversation so far",
  ) {}

  /**
   * Sentences that read the same twice are settled and cleaned; at a
   * pause, the whole is cleaned ahead of `final`.
   */
  partial(text: string, pause = false) {
    const all = sentences(text);
    const complete = all.slice(0, -1);
    const stable = complete.slice(0, shared(complete, this.settled));
    this.settled = complete;
    this.keepPieces(stable);
    const covered = this.pieces.reduce((n, p) => n + p.sentences.length, 0);
    if (stable.length > covered) {
      const fresh = stable.slice(covered);
      this.pieces.push({
        sentences: fresh,
        reply: this.ask(
          `${this.header()}PIECE\n${fresh.join(" ")}`,
          this.aborted.signal,
        ).catch(() => null),
      });
    }
    if (pause) void this.end(text);
  }

  async final(text: string): Promise<Cleaned> {
    this.fellBack = false;
    const cleaned = await this.finalCleaned(text);
    // Cleaning drops fillers and false starts, never most of the words: a
    // model that lost them gives the words as heard.
    const words = (value: string) => value.split(/\s+/).filter(Boolean).length;
    if (cleaned.forAgent && words(cleaned.text) < words(text) * 0.5) {
      this.fellBack = true;
      return { text: text.trim(), forAgent: true };
    }
    return cleaned;
  }

  private async finalCleaned(text: string): Promise<Cleaned> {
    const raw = text.trim();
    if (!raw) return { text: "", forAgent: true };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Cleaned>((resolve) => {
      timer = setTimeout(() => {
        this.fellBack = true;
        resolve({ text: raw, forAgent: true });
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.end(raw), timeout]);
    } finally {
      clearTimeout(timer);
      this.aborted.abort();
    }
  }

  close() {
    this.aborted.abort();
  }

  private header() {
    return this.context ? `${this.contextLabel}:\n${this.context}\n\n` : "";
  }

  /** Drops pieces whose sentences the transcript no longer starts with. */
  private keepPieces(said: readonly string[]) {
    let at = 0;
    const kept: Piece[] = [];
    for (const piece of this.pieces) {
      const own = said.slice(at, at + piece.sentences.length);
      if (shared(own, piece.sentences) !== piece.sentences.length) break;
      kept.push(piece);
      at += piece.sentences.length;
    }
    this.pieces = kept;
  }

  private end(text: string): Promise<Cleaned> {
    const raw = text.trim();
    let ending = this.ends.get(raw);
    if (!ending) {
      ending = this.clean(raw).catch(() => {
        this.fellBack = true;
        return { text: raw, forAgent: true };
      });
      this.ends.set(raw, ending);
    }
    return ending;
  }

  private async clean(raw: string): Promise<Cleaned> {
    const all = sentences(raw);
    this.keepPieces(all);
    const pieces = [...this.pieces];
    const replies = await Promise.all(pieces.map((piece) => piece.reply));
    // A piece that failed is cleaned again with the rest.
    const failed = replies.indexOf(null);
    const usable = failed < 0 ? replies.length : failed;
    const covered = pieces
      .slice(0, usable)
      .reduce((n, piece) => n + piece.sentences.length, 0);
    // A piece that came back empty keeps its words as heard: what was said
    // to the agent is never dropped.
    let before = replies
      .slice(0, usable)
      .map(
        (reply, index) =>
          reply?.text?.trim() || pieces[index]!.sentences.join(" "),
      )
      .join(" ");
    const rest = all.slice(covered).join(" ");
    if (!rest)
      return {
        text: before,
        forAgent: replies.slice(0, usable).some((r) => r?.for_agent !== false),
      };
    const reply = await this.ask(
      `${this.header()}END\nCleaned so far: ${before}\nRest: ${rest}`,
      this.aborted.signal,
    );
    for (const fix of reply.fixes ?? [])
      if (fix.from && typeof fix.to === "string" && before.includes(fix.from))
        before = before.replace(fix.from, fix.to);
    return {
      text: [before, reply.text?.trim() ?? ""].filter(Boolean).join(" "),
      forAgent: reply.for_agent !== false,
    };
  }
}

export type ClaudeProcess = {
  write: (line: string) => void;
  lines: AsyncIterable<string>;
  kill: () => void;
  exited: Promise<unknown>;
};

/**
 * The environment of a background Claude Code session: without the Herdr
 * pane variables of a bridge started from a pane, whose hooks would
 * otherwise re-point that pane's agent session at this one, nor Claude
 * Code's own marker of running inside it.
 */
export function backgroundClaudeEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !name.startsWith("HERDR_") && name !== "CLAUDECODE",
    ),
  );
}

export function spawnClaude(
  model: string,
  command: string | AgentCommand = "claude",
  systemPrompt = CLEANER_SYSTEM_PROMPT,
  /**
   * The answer's text as it is written, too (Worker.ask's `onText`): the
   * voice front's words are said before its JSON object is over.
   */
  {
    partial = false,
    launch,
  }: {
    partial?: boolean;
    /** With the companion's memory (CompanionMemoryDriver): instead of a bare model. */
    launch?: BackgroundMemoryLaunch;
  } = {},
): ClaudeProcess {
  const resolved = asCommand(command);
  const child = Bun.spawn(
    [
      resolved.program,
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      ...(partial ? ["--include-partial-messages"] : []),
      "--model",
      model,
      // The user waits for each answer, a short JSON object: at its default
      // effort, Opus thinks for seconds before it.
      "--effort",
      "low",
      "--tools",
      launch?.tools ?? "",
      // No hooks, plugins, MCP servers or CLAUDE.md: a bare model.
      ...(launch ? launch.args : ["--safe-mode"]),
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      systemPrompt,
    ],
    {
      cwd: launch?.cwd ?? tmpdir(),
      env: commandEnv(resolved, backgroundClaudeEnv()),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  async function* lines() {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of child.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        yield buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf("\n");
      }
    }
  }
  return {
    write: (line) => {
      child.stdin.write(line);
      child.stdin.flush();
    },
    lines: lines(),
    kill: () => child.kill(),
    exited: child.exited,
  };
}

/** An image given with a request: what the model sees beside its words. */
export type PromptImage = { media_type: string; data: string };

/**
 * A request's message content: its words, after its images when it has
 * some (image content blocks, as Claude Code's stream-json takes them).
 */
export function promptContent(
  prompt: string,
  images: readonly PromptImage[] = [],
): string | unknown[] {
  if (!images.length) return prompt;
  return [
    ...images.map((image) => ({
      type: "image",
      source: { type: "base64", ...image },
    })),
    { type: "text", text: prompt },
  ];
}

/** Requests on one session make its context grow: past this, a new one. */
const REQUESTS_PER_PROCESS = 40;

/** One background Claude Code session, answering one request at a time. */
export class Worker {
  private process: ClaudeProcess | null = null;
  private answer: ((result: string | Error) => void) | null = null;
  /** The answer being written (partial messages), and who hears it. */
  private written = "";
  private onText: ((soFar: string) => void) | null = null;
  private served = 0;
  busy = false;
  /** Counts the sessions started: a new one knows nothing said before. */
  generation = 0;

  constructor(private readonly spawn: () => ClaudeProcess) {}

  /** Whether a session runs now: the next request goes to the same one. */
  get running() {
    return this.process !== null;
  }

  /** Starts the session ahead of its first request. */
  warm() {
    this.start();
  }

  private start(): ClaudeProcess {
    if (this.process) return this.process;
    const process = this.spawn();
    this.process = process;
    this.served = 0;
    this.generation += 1;
    void (async () => {
      for await (const line of process.lines) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "stream_event") {
          const streamed = event.event as
            | { type?: string; delta?: { type?: string; text?: unknown } }
            | undefined;
          if (
            streamed?.type === "content_block_delta" &&
            streamed.delta?.type === "text_delta" &&
            typeof streamed.delta.text === "string"
          ) {
            this.written += streamed.delta.text;
            try {
              this.onText?.(this.written);
            } catch {
              // Its listener's trouble: the answer still comes.
            }
          }
          continue;
        }
        if (event.type !== "result") continue;
        const answer = this.answer;
        this.answer = null;
        this.onText = null;
        answer?.(
          event.is_error
            ? new Error(String(event.result ?? "The cleaner failed"))
            : String(event.result ?? ""),
        );
      }
    })().catch(() => {});
    void process.exited.then(() => {
      if (this.process === process) this.process = null;
      this.answer?.(new Error("The cleaner stopped"));
      this.answer = null;
    });
    return process;
  }

  /**
   * The answer to `prompt`, and the `images` given with it; `onText` hears
   * it as it is written, whole so far, when the session streams partial
   * messages (spawnClaude).
   */
  async ask(
    prompt: string,
    onText?: (soFar: string) => void,
    images?: readonly PromptImage[],
  ): Promise<string> {
    this.busy = true;
    try {
      const process = this.start();
      const result = await new Promise<string | Error>((resolve) => {
        this.answer = resolve;
        this.written = "";
        this.onText = onText ?? null;
        process.write(
          `${JSON.stringify({
            type: "user",
            message: { role: "user", content: promptContent(prompt, images) },
          })}\n`,
        );
      });
      if (result instanceof Error) throw result;
      return result;
    } finally {
      this.onText = null;
      this.busy = false;
      this.served += 1;
      if (this.served >= REQUESTS_PER_PROCESS) {
        this.process?.kill();
        this.process = null;
      }
    }
  }

  stop() {
    this.process?.kill();
    this.process = null;
  }
}

type Job = {
  prompt: string;
  signal?: AbortSignal;
  resolve: (reply: CleanerReply) => void;
  reject: (error: Error) => void;
};

/**
 * Background sessions shared by every voice chat: requests wait for a free
 * one, and those whose utterance is over are dropped unasked.
 */
export class VoiceCleaner {
  private workers: Worker[];
  private queue: Job[] = [];

  constructor(spawn: () => ClaudeProcess, size = 2) {
    this.workers = Array.from({ length: size }, () => new Worker(spawn));
  }

  /** Starts the sessions, so the first utterance does not wait for them. */
  warm() {
    for (const worker of this.workers) worker.warm();
  }

  session(
    context: string,
    timeoutMs?: number,
    contextLabel?: string,
  ): CleanSession {
    return new CleanSession(
      (prompt, signal) => this.ask(prompt, signal),
      context,
      timeoutMs,
      contextLabel,
    );
  }

  ask(prompt: string, signal?: AbortSignal): Promise<CleanerReply> {
    return new Promise((resolve, reject) => {
      this.queue.push({ prompt, signal, resolve, reject });
      this.next();
    });
  }

  private next() {
    for (;;) {
      const worker = this.workers.find((candidate) => !candidate.busy);
      if (!worker) return;
      let job = this.queue.shift();
      while (job?.signal?.aborted) {
        job.reject(new Error("No longer needed"));
        job = this.queue.shift();
      }
      if (!job) return;
      const { prompt, resolve, reject } = job;
      void worker
        .ask(prompt)
        .then((result) => resolve(parseCleanerReply(result)))
        .catch((error: Error) => reject(error))
        .finally(() => this.next());
    }
  }

  stop() {
    for (const worker of this.workers) worker.stop();
  }
}

/**
 * The cleaner `voice.json` asks for (`clean_model`), kept while it stays
 * the same; null without one.
 */
export function configuredCleaner(
  config: () => VoiceConfig | { error: string },
  spawn: (
    model: string,
    command?: string | AgentCommand,
  ) => ClaudeProcess = spawnClaude,
): () => VoiceCleaner | null {
  let current: { key: string; cleaner: VoiceCleaner } | null = null;
  return () => {
    const read = config();
    const model = "error" in read ? undefined : read.clean_model;
    const command = model
      ? helperCommand("error" in read ? undefined : read.claude_command)
      : undefined;
    const key = model ? `${model} ${commandKey(command)}` : "";
    if (current?.key !== key) {
      current?.cleaner.stop();
      current = model
        ? { key, cleaner: new VoiceCleaner(() => spawn(model, command)) }
        : null;
    }
    return current?.cleaner ?? null;
  };
}
