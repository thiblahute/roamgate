import { type ClaudeProcess, spawnClaude, Worker } from "./voice-cleaner";
import type { VoiceConfig } from "./voice-helper";

export const ROUTER_SYSTEM_PROMPT = `You route what the user says aloud while talking to their coding agents by voice. They work with many agent sessions (Claude Code and others) across machines, shown in Roamgate. Speech recognition mishears names and technical words: "Roamgate" may come out as "Rome gate", "room gate" or "wrong gate", "Claude" as "cloud", "gst-plugins-rs" as "just plugins RS", "cloud-project-system" as "clock system", numbers as words. People talking nearby can be picked up too, often in French or Spanish.

Each request gives the session on screen ("current") and what was just said; the list of sessions comes when it changes. Decide who it is for, and answer with only a JSON object:

- {"to": "current"}: for the agent on screen. This is by far the most common case: anything that is a request, a question, an answer or a remark to that agent, even if it mentions another session, a branch or a project ("like the IGA-184 session did", "open the review", "switch the default to X").
- {"to": "open", "pane": "<id>", "say": "<short name>"}: the user asks to go to, open, switch to, look for or check on another session. "say" is how to name it aloud, a few words.
- {"to": "send", "pane": "<id>", "say": "<short name>"}: the user asks to tell, ask or pass something to another session's agent. The words go to it as said.
- {"to": "ranger"}: a question about the user's sessions or workspaces, one or several, without asking to go there: what one is doing, whether it is done or waits on them, the state of work it owns (its merge request, CI, branch or ticket), what they worked on today, which ones wait on them; or a request to manage workspaces said to Ranger or Roamgate by name ("Ranger, close the docker cleanup pane"). Work the agent on screen is asked to do, creating worktrees or starting sessions included, stays "current". A question is "ranger" however it is put ("if I ask you whether X is ready, can you answer?") and whichever session is on screen, the Roamgate one included. Ranger, Roamgate's assistant, answers it while the user stays where they are. "Go to", "open", "switch to" or "move to" a session is "open", even with "see what is happening there".
- {"to": "errand", "pane": "<id>", "say": "<short name>"}: a question or an errand not about any session, project or Roamgate: the news, football, the weather, sending a WhatsApp message or a mail, a purchase. It goes to the session marked "handles errands", which answers while the user stays where they are. Without such a session, it is "current".
- {"to": "ask", "panes": ["<id>", "<id>"], "question": "<short question>"}: only when two or three sessions fit equally and nothing said tells them apart, such as the same title on two machines. Otherwise pick the best match: a session whose own workspace or title carries the name said ("IGA-184") beats one that only mentions it among others. The question is a few words naming them, so the user can answer by voice.
- {"to": "nobody"}: not said to an agent: talk with someone nearby, on the phone, or a fragment of it.

Talk about Roamgate itself (its voice chat, this routing, a feature idea or a bug for it) is for the session working on Roamgate's code when one is listed: "send" it there, whichever session is on screen.

Match sessions on what they are about: title, workspace, folder, branch, machine, all as the user may describe them loosely or misheard. Only use ids from the list. When unsure whether something is for the current agent, it is. Reply with the JSON object alone, never a tool call.`;

/** An agent session the user may name, as the page lists them. */
export type VoiceSessionInfo = {
  /** `<connection>/<pane>`. */
  id: string;
  machine: string;
  workspace: string;
  title: string;
  folder: string;
  agent: string;
  status: string;
  /** Minutes since its session last changed, when known. */
  active?: number;
  /** The session general questions and errands go to. */
  errands?: boolean;
};

export type VoiceRoute =
  | { to: "current" }
  | { to: "nobody" }
  | { to: "open" | "send"; pane: string; say: string }
  | { to: "ranger" }
  | { to: "errand"; pane: string; say: string; job?: string }
  | { to: "ask"; panes: string[]; question: string };

const CURRENT: VoiceRoute = { to: "current" };
/** A route not decided by then goes to the agent on screen. */
const ROUTE_TIMEOUT_MS = 8000;

/** The model's answer, kept to sessions it was given; anything else is "current". */
export function parseVoiceRoute(text: string, ids: Set<string>): VoiceRoute {
  let reply: Record<string, unknown>;
  // Now and then a model answers as a tool call: <invoke name="open">
  // <parameter name="pane">…</parameter>…</invoke>.
  const invoked = /<invoke name="(\w+)">([\s\S]*?)<\/invoke>/.exec(text);
  if (invoked) {
    reply = { to: invoked[1] };
    for (const [, key, value] of invoked[2]!.matchAll(
      /<parameter name="(\w+)">([\s\S]*?)<\/parameter>/g,
    ))
      reply[key!] = parameterValue(value!.trim());
    return checked(reply, ids);
  }
  try {
    reply = JSON.parse(
      text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
    );
  } catch {
    return CURRENT;
  }
  return checked(reply, ids);
}

function parameterValue(value: string): unknown {
  if (!value.startsWith("[")) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function checked(reply: Record<string, unknown>, ids: Set<string>): VoiceRoute {
  const say = typeof reply.say === "string" ? reply.say.slice(0, 80) : "";
  switch (reply.to) {
    case "nobody":
      return { to: "nobody" };
    case "ranger":
      return { to: "ranger" };
    case "open":
    case "send":
    case "errand":
      return typeof reply.pane === "string" && ids.has(reply.pane)
        ? { to: reply.to, pane: reply.pane, say }
        : CURRENT;
    case "ask": {
      const panes = Array.isArray(reply.panes)
        ? reply.panes.filter(
            (pane): pane is string => typeof pane === "string" && ids.has(pane),
          )
        : [];
      const question =
        typeof reply.question === "string" ? reply.question.slice(0, 300) : "";
      return panes.length && question
        ? { to: "ask", panes, question }
        : CURRENT;
    }
    default:
      return CURRENT;
  }
}

function sessionLine(session: VoiceSessionInfo) {
  return [
    session.id,
    session.machine,
    `workspace ${session.workspace}`,
    session.title,
    session.folder,
    `${session.agent} ${session.status}`,
    ...(session.active === undefined
      ? []
      : [`active ${formatMinutes(session.active)} ago`]),
    ...(session.errands ? ["handles errands"] : []),
  ].join(" | ");
}

function formatMinutes(minutes: number) {
  return minutes < 60
    ? `${Math.round(minutes)} min`
    : minutes < 48 * 60
      ? `${Math.round(minutes / 60)} h`
      : `${Math.round(minutes / 1440)} days`;
}

/**
 * Decides who each thing said by voice is for, in one background Claude
 * Code session: it keeps what was said and asked before, so "the other
 * one" or the answer to its question make sense to it.
 */
export class VoiceRouter {
  private worker: Worker;
  private chain: Promise<unknown> = Promise.resolve();
  /** The session list last given, and to which background session. */
  private listed: { generation: number; list: string } | null = null;

  constructor(spawn: () => ClaudeProcess) {
    this.worker = new Worker(spawn);
  }

  warm() {
    this.worker.warm();
  }

  route(request: {
    current: string;
    said: string;
    sessions: VoiceSessionInfo[];
    timeoutMs?: number;
  }): Promise<VoiceRoute> {
    const routed = this.chain.then(() => this.ask(request));
    this.chain = routed.catch(() => {});
    const timeout = new Promise<VoiceRoute>((resolve) =>
      setTimeout(() => resolve(CURRENT), request.timeoutMs ?? ROUTE_TIMEOUT_MS),
    );
    return Promise.race([routed.catch(() => CURRENT), timeout]);
  }

  private async ask({
    current,
    said,
    sessions,
  }: {
    current: string;
    said: string;
    sessions: VoiceSessionInfo[];
  }): Promise<VoiceRoute> {
    const ids = new Set(sessions.map((session) => session.id));
    const list = sessions.map(sessionLine).join("\n");
    const request = `Current: ${current}\nSaid: ${JSON.stringify(said)}`;
    const send = async (withList: boolean) => {
      const generation = this.worker.generation;
      const answer = await this.worker.ask(
        withList ? `Sessions:\n${list}\n\n${request}` : request,
      );
      // A new background session started for it: it never saw the list.
      if (!withList && this.worker.generation !== generation) return null;
      this.listed = { generation: this.worker.generation, list };
      return answer;
    };
    const known =
      this.worker.running &&
      this.listed?.list === list &&
      this.listed.generation === this.worker.generation;
    const answer = (await send(!known)) ?? (await send(true));
    return parseVoiceRoute(answer ?? "", ids);
  }

  stop() {
    this.worker.stop();
  }
}

/** The router `route_model` in voice.json sets up, or null without one. */
export function configuredRouter(
  config: () => VoiceConfig | { error: string },
  spawn: (model: string, command?: string) => ClaudeProcess = (
    model,
    command,
  ) => spawnClaude(model, command, ROUTER_SYSTEM_PROMPT),
): () => VoiceRouter | null {
  let current: { key: string; router: VoiceRouter } | null = null;
  return () => {
    const read = config();
    const model = "error" in read ? undefined : read.route_model;
    const command = "error" in read ? undefined : read.claude_command;
    const key = model ? `${model} ${command ?? ""}` : "";
    if (current?.key !== key) {
      current?.router.stop();
      current = model
        ? { key, router: new VoiceRouter(() => spawn(model, command)) }
        : null;
    }
    return current?.router ?? null;
  };
}
