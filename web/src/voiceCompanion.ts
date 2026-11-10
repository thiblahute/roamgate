import type {
  AgentPermissionPrompt,
  AgentPromptAnswer,
} from "../../shared/review";
import type { AgentPrompt } from "./agentPrompt";
import { BLOCKED_NOTICE } from "./components/voiceStream";

/**
 * Voice chat's companion (server voice-front.ts, front_mode "companion"):
 * on a call the user talks with the front alone. The agents' answers are
 * not read as they come: each goes to the front, which tells it as the
 * conversation goes (a summary naming who wrote it, its exact words when
 * they matter, or nothing yet), and is kept here so it can be read whole
 * on request. An agent's question is the exception: it is relayed at once,
 * as written, and the answer said goes back to it as said. "relay" mode
 * reads every answer, as voice chat does without a front.
 */

export type FrontMode = "companion" | "relay";

/** What happens to an agent's answer on a call. */
export function answerDelivery(mode: FrontMode | null): "read" | "tell" {
  return mode === "companion" ? "tell" : "read";
}

/** An agent's answer heard on a call, kept for the front and for reading. */
export type AgentAnswer = {
  /** Who wrote it, as said aloud ("Roamgate", "Ranger"). */
  agent: string;
  text: string;
  /** Its chat entries, highlighted while it is read. */
  ids: string[];
  at: number;
  /** `<connection>/<pane>`, when it is a session's. */
  session?: string;
};

/**
 * What a call with the companion itself (companionCall.ts) does with a
 * route: work for the default session or a named one starts there, and
 * the call stays; a session to look at is shown. Null: as any voice chat.
 */
export type CompanionAction =
  | { kind: "forward"; pane: string }
  | { kind: "show"; pane: string };

export function companionRouteAction(
  route: { to: string; pane?: string },
  current: string,
): CompanionAction | null {
  if (route.to === "current")
    return current ? { kind: "forward", pane: current } : null;
  if (route.to === "send" && route.pane)
    return { kind: "forward", pane: route.pane };
  if (route.to === "open" && route.pane)
    return { kind: "show", pane: route.pane };
  return null;
}

/** How a session is named aloud: its workspace, or its title. */
export function sessionLabel(
  id: string,
  sessions: readonly {
    id: string;
    workspace: string;
    title: string;
    agent: string;
  }[],
): string {
  const session = sessions.find((entry) => entry.id === id);
  return (
    session?.workspace || session?.title || session?.agent || "the session"
  );
}

/** Answers kept, at most. */
const KEPT = 8;
/** What of each answer the front's state gives (the answer itself went whole). */
const CONTEXT_CHARS = 1200;

let answers: AgentAnswer[] = [];

export function noteAgentAnswer(
  answer: Omit<AgentAnswer, "at"> & { at?: number },
): AgentAnswer {
  const noted = { ...answer, at: answer.at ?? Date.now() };
  answers = [
    ...answers.filter((kept) => kept.text !== noted.text),
    noted,
  ].slice(-KEPT);
  return noted;
}

/** Forgets the agents' answers (the companion started over). */
export function forgetAgentAnswers() {
  answers = [];
}

/** The answers kept, oldest first. */
export function recentAnswers(): readonly AgentAnswer[] {
  return answers;
}

const folded = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** The last answer, or the last one of `agent` (named loosely). */
export function findAnswer(agent?: string): AgentAnswer | null {
  const wanted = agent ? folded(agent) : "";
  for (let index = answers.length - 1; index >= 0; index--) {
    const answer = answers[index]!;
    if (!wanted) return answer;
    const name = folded(answer.agent);
    if (name && (name.includes(wanted) || wanted.includes(name))) return answer;
  }
  return null;
}

function ago(at: number, now: number) {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? "just now" : `${minutes} min ago`;
}

/** The answers, shortened, for the front's state (voiceFront.ts). */
export function answersContext(now = Date.now()): string {
  if (!answers.length) return "";
  return [
    "Recent answers (oldest first; the user only heard what you said of them):",
    ...answers.slice(-5).map((answer) => {
      const text = answer.text.replace(/\s+/g, " ").trim();
      const shown =
        text.length > CONTEXT_CHARS
          ? `${text.slice(0, CONTEXT_CHARS)}... (${text.length} characters, cut)`
          : text;
      return `- ${answer.agent}, ${ago(answer.at, now)}: ${shown}`;
    }),
  ].join("\n");
}

export function __resetAnswersForTests() {
  answers = [];
}

/** Whether `said` asks to hear an answer whole, word for word. */
export function isReadWholeRequest(said: string): boolean {
  const text = folded(said);
  return (
    /\b(read|repeat)\b.*\b(whole|full|entire|complete|all of|exact|word for word)\b.*\b(answer|reply|response|message|it)\b/.test(
      text,
    ) ||
    /\bread (me )?(the |its |his |her )?(answer|reply|response) (in full|whole|word for word)\b/.test(
      text,
    ) ||
    /\b(lis|lire|relis|relire)( moi)?\b.*\b(toute la|la reponse|tout le message|en entier|mot pour mot|en integralite|complete)\b/.test(
      text,
    )
  );
}

/**
 * A switch said aloud: every answer read whole from now on ("relay": "read
 * everything", "lis tout"), or told by the companion again ("companion":
 * "stop reading everything", "just summarize", "résume"); null otherwise.
 */
export function modeRequest(said: string): FrontMode | null {
  const text = folded(said);
  if (
    /\b(stop|no longer|don t|do not) (reading|read) (everything|all)\b/.test(
      text,
    ) ||
    /\bjust (summari[sz]e|tell me)\b/.test(text) ||
    /\b(arrete|arretez) de tout lire\b/.test(text) ||
    /\b(ne lis plus tout|resume moi|fais moi des resumes)\b/.test(text)
  )
    return "companion";
  // Said alone, or "from now on": "read everything in the logs" is work.
  const fromNow = /\b(from now on|a partir de maintenant|desormais)\b/.test(
    text,
  );
  const bare = text
    .replace(
      /\b(ok|okay|please|s il te plait|alors|bon|from now on|a partir de maintenant|desormais)\b/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  if (
    /\bread (me )?(all the answers|every answer|all answers)\b/.test(text) ||
    /\b(lis|lisez) (moi )?toutes les reponses\b/.test(text) ||
    ((fromNow ||
      /^(read (me )?(everything|it all|all of it)|(lis|lisez) (moi )?tout)$/.test(
        bare,
      )) &&
      /\b(read (me )?(everything|it all|all of it)|(lis|lisez) (moi )?tout)\b/.test(
        text,
      ))
  )
    return "relay";
  return null;
}

/** An answer's text as told, without the notice that a question waits. */
export function answerText(text: string): string {
  return text.split(BLOCKED_NOTICE).join("").trim();
}

/**
 * A question an agent asks the user, from its permission hook or its
 * terminal: relayed as written, answered by voice.
 */
export type VoiceQuestion = {
  /** The same question is relayed once. */
  key: string;
  agent: string;
  /** Its words, as the agent wrote them. */
  lines: string[];
  options: { key?: string; label: string }[];
  /** An answer in the user's own words is taken, as said. */
  ownWords: boolean;
};

/**
 * What answers a question: one of its choices, the words said, or putting
 * it away unanswered (the agent is told it was dismissed, and goes on).
 */
export type QuestionAnswer =
  | { option: number }
  | { words: string }
  | { dismiss: true };

// "Dismiss it", "skip the question", "never mind", "laisse tomber (la
// question)", "ignore la question", "oublie": put away, unanswered.
const DISMISS =
  /^((please )?(dismiss|skip|ignore|drop|discard)( (it|that|this|the question|this question|that question|the questions))?|never ?mind|forget (it|about it|the question)|no answer|(laisse|laissez) tomber( (ca|ça|la question|les questions))?|(ignore|ignorez|oublie|oubliez|passe|passez)( (la|cette) question| les questions| ca| ça)?|pas de reponse|sans reponse)$/;

/** Whether `said` asks to put the question away unanswered. */
export function isDismissRequest(said: string): boolean {
  const text = folded(said).replace(
    /\s+(please|s il te plait|s il vous plait|merci)$/,
    "",
  );
  return DISMISS.test(text);
}

export function questionFromPermission(
  prompt: AgentPermissionPrompt,
  agent: string,
): VoiceQuestion {
  const questions = prompt.questions ?? [];
  if (questions.length) {
    // Several questions, or several answers each, are answered on screen.
    const one = questions.length === 1 && !questions[0]!.multiSelect;
    return {
      key: `permission:${prompt.id}`,
      agent,
      lines: questions.map((question) => question.question),
      options: one
        ? questions[0]!.options.map((option, index) => ({
            key: String(index + 1),
            label: option.label,
          }))
        : [],
      ownWords: one,
    };
  }
  return {
    key: `permission:${prompt.id}`,
    agent,
    lines: [`${agent} wants to use ${prompt.tool}: ${prompt.summary}`.trim()],
    options: [
      { key: "1", label: "Allow" },
      ...(prompt.canAlways
        ? [{ key: "2", label: "Allow, and don't ask again" }]
        : []),
      { key: prompt.canAlways ? "3" : "2", label: "Deny" },
    ],
    ownWords: false,
  };
}

/**
 * Gives a prompt the answer said to its relayed question: the choice or
 * the words for Claude's question, the decision for a permission, or its
 * dismissal (the agent told, and going on). False when it took none.
 */
export function answerPromptByVoice(
  prompt: AgentPermissionPrompt,
  asked: VoiceQuestion,
  answer: QuestionAnswer,
  send: (
    connectionId: string,
    id: string,
    answer: AgentPromptAnswer,
  ) => Promise<boolean>,
): Promise<boolean> {
  if ("dismiss" in answer)
    return send(prompt.connectionId, prompt.id, "dismiss");
  const one = prompt.questions?.[0];
  if (one) {
    const said =
      "option" in answer ? asked.options[answer.option]?.label : answer.words;
    if (!said) return Promise.resolve(false);
    return send(prompt.connectionId, prompt.id, {
      answers: { [one.question]: said },
    });
  }
  if (!("option" in answer)) return Promise.resolve(false);
  const label = asked.options[answer.option]?.label ?? "";
  return send(
    prompt.connectionId,
    prompt.id,
    label.startsWith("Deny")
      ? "deny"
      : label.startsWith("Allow, and")
        ? "always"
        : "allow",
  );
}

export function questionFromPrompt(
  prompt: AgentPrompt,
  agent: string,
): VoiceQuestion | null {
  const lines = prompt.lines.map((line) => line.trim()).filter(Boolean);
  if (!lines.length && !prompt.options.length) return null;
  return {
    key: `screen:${lines.join("\n")}\n${prompt.options.map((option) => option.label).join("\n")}`,
    agent,
    lines,
    options: prompt.options
      .filter((option) => !option.freeText)
      .map((option) => ({
        ...(option.key ? { key: option.key } : {}),
        label: option.label,
      })),
    ownWords: false,
  };
}

/** What is said of a question: its words and choices, as written. */
export function relayText(question: VoiceQuestion): string {
  const asked = question.lines.join(" ").trim();
  const choices = question.options
    .map((option, index) => `${option.key ?? index + 1}: ${option.label}`)
    .join(". ");
  const head = asked.startsWith(question.agent)
    ? asked
    : `${question.agent} asks: ${asked}`;
  return choices
    ? `${head}${/[.?!:]$/.test(head) ? "" : "."} Options: ${choices}.`
    : `${head}${/[.?!:]$/.test(head) ? "" : "."} Answer it on the screen.`;
}

const NUMBERS: Record<string, number> = {
  one: 1,
  first: 1,
  un: 1,
  une: 1,
  premier: 1,
  premiere: 1,
  two: 2,
  second: 2,
  deux: 2,
  deuxieme: 2,
  seconde: 2,
  three: 3,
  third: 3,
  trois: 3,
  troisieme: 3,
  four: 4,
  fourth: 4,
  quatre: 4,
  quatrieme: 4,
  five: 5,
  fifth: 5,
  cinq: 5,
  cinquieme: 5,
};
const YES =
  /^(yes|yeah|yep|ok|okay|sure|allow|go ahead|go|oui|ouais|vas y|d accord|ok vas y)$/;
const NO = /^(no|nope|deny|don t|non|refuse|surtout pas|pas question)$/;

/**
 * Which of the question's choices `said` picks: its number or its label;
 * a plain yes or no picks the first choice saying so. The words said, as
 * they are, when the question takes an answer of one's own; else null.
 */
export function matchAnswer(
  said: string,
  question: VoiceQuestion,
): QuestionAnswer | null {
  if (isDismissRequest(said)) return { dismiss: true };
  const text = folded(said)
    .replace(/^(option|choice|choix|numero|number|le|la|the)\s+/, "")
    .replace(/\s+(please|s il te plait|s il vous plait|merci)$/, "");
  const options = question.options;
  const byNumber = (value: number) => {
    const index = options.findIndex(
      (option, position) =>
        (option.key ?? String(position + 1)) === String(value),
    );
    return index >= 0 ? { option: index } : null;
  };
  if (/^\d{1,2}$/.test(text)) return byNumber(Number(text));
  if (NUMBERS[text] !== undefined) return byNumber(NUMBERS[text]!);
  // The longest label said: "Yes, and don't ask again" over "Yes".
  let best = -1;
  options.forEach((option, index) => {
    const label = folded(option.label);
    if (
      label &&
      (text === label || ` ${text} `.includes(` ${label} `)) &&
      (best < 0 || label.length > folded(options[best]!.label).length)
    )
      best = index;
  });
  if (best >= 0) return { option: best };
  const starts = (pattern: RegExp) => {
    const index = options.findIndex((option) =>
      pattern.test(folded(option.label)),
    );
    return index >= 0 ? { option: index } : null;
  };
  if (YES.test(text)) {
    const found = starts(/^(yes|allow|oui|ok)\b/);
    if (found) return found;
  }
  if (NO.test(text)) {
    const found = starts(/^(no|deny|non)\b/);
    if (found) return found;
  }
  return question.ownWords && said.trim() ? { words: said.trim() } : null;
}
