/**
 * A message said by voice says so, and where the reading was cut short, so
 * the agent knows it talks live and what was heard: `[Voice] text`, or
 * `[Voice, interrupted you at: "sentence"] text`. Every delivery of the
 * user's spoken words carries it (voice chat, the companion's jobs, errands,
 * an answer said to an agent's question); words typed never do. The chat
 * shows it as a label on the message.
 */
const VOICE_NOTE = /^\[Voice(?:, interrupted you at: ("(?:[^"\\]|\\.)*"))?\] /;

export function voiceMessage(
  text: string,
  interruptedAt?: string | null,
): string {
  return interruptedAt
    ? `[Voice, interrupted you at: ${JSON.stringify(interruptedAt)}] ${text}`
    : `[Voice] ${text}`;
}

/** A message's text without its voice note, and what the note said. */
export function parseVoiceMessage(text: string): {
  text: string;
  voice: boolean;
  interruptedAt: string | null;
} {
  const match = VOICE_NOTE.exec(text);
  if (!match) return { text, voice: false, interruptedAt: null };
  let interruptedAt: string | null;
  try {
    interruptedAt = match[1] ? (JSON.parse(match[1]) as string) : null;
  } catch {
    interruptedAt = null;
  }
  return { text: text.slice(match[0].length), voice: true, interruptedAt };
}
