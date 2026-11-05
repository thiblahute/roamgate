/**
 * A message said by voice says so, and where the reading was cut short, so
 * the agent knows it talks live and what was heard: `[Voice] text`, or
 * `[Voice, interrupted you at: "sentence"] text`. Every delivery of the
 * user's spoken words carries it (voice chat, the companion's jobs, errands,
 * an answer said to an agent's question); words typed never do. The chat
 * shows it as a label on the message.
 *
 * When the companion hands words over that depend on the call ("ask it
 * again", "that one"), it adds what they refer to: the words then go
 * quoted, as said, followed by its note, `[Voice] "ask it again" (Context:
 * I had just read your summary of ...)`, so the session gets a message it
 * can act on alone and still sees the user's own words.
 */
const VOICE_NOTE = /^\[Voice(?:, interrupted you at: ("(?:[^"\\]|\\.)*"))?\] /;
const WITH_CONTEXT = /^("(?:[^"\\]|\\.)*") \(Context: ([^\n]*)\)$/;

/** A context note on one line, kept short: it never ends the message early. */
export function voiceContextNote(context: string | null | undefined): string {
  return (context ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
}

export function voiceMessage(
  text: string,
  interruptedAt?: string | null,
  context?: string | null,
): string {
  const note = voiceContextNote(context);
  const body = note ? `${JSON.stringify(text)} (Context: ${note})` : text;
  return interruptedAt
    ? `[Voice, interrupted you at: ${JSON.stringify(interruptedAt)}] ${body}`
    : `[Voice] ${body}`;
}

/** A message's text without its voice note, and what the note said. */
export function parseVoiceMessage(text: string): {
  text: string;
  voice: boolean;
  interruptedAt: string | null;
  /** What the companion added about the words, when it did. */
  context: string | null;
} {
  const match = VOICE_NOTE.exec(text);
  if (!match) return { text, voice: false, interruptedAt: null, context: null };
  let interruptedAt: string | null;
  try {
    interruptedAt = match[1] ? (JSON.parse(match[1]) as string) : null;
  } catch {
    interruptedAt = null;
  }
  const body = text.slice(match[0].length);
  const noted = WITH_CONTEXT.exec(body);
  if (noted) {
    try {
      return {
        text: JSON.parse(noted[1]!) as string,
        voice: true,
        interruptedAt,
        context: noted[2]!.trim(),
      };
    } catch {
      // Not ours after all: shown as written.
    }
  }
  return { text: body, voice: true, interruptedAt, context: null };
}
