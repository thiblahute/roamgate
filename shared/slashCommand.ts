/**
 * A slash command the user typed in Claude Code's terminal, as its
 * transcript writes it: `<command-name>/exit</command-name>`, then
 * `<command-message>` and `<command-args>`. The chat shows the command,
 * not the tags.
 */
export type SlashCommand = {
  /** With its slash: "/exit". */
  name: string;
  /** What followed it, trimmed: often empty. */
  args: string;
};

function tag(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1]!.trim() : null;
}

/** The command a user record is, or null when it is not one. */
export function parseSlashCommand(text: string): SlashCommand | null {
  const raw = tag(text, "command-name");
  if (!raw) return null;
  // Anything besides the command's own tags is not a command record.
  const rest = text
    .replace(/<command-(?:name|message|args)>[\s\S]*?<\/command-\w+>/g, "")
    .trim();
  if (rest) return null;
  const name = raw.startsWith("/") ? raw : `/${raw}`;
  return { name, args: tag(text, "command-args") ?? "" };
}

/** What the command reads as: "/exit", "/model opus". */
export function slashCommandText(command: SlashCommand): string {
  return command.args ? `${command.name} ${command.args}` : command.name;
}

/**
 * What a command run in Claude Code itself printed, as its transcript
 * writes it: `<local-command-stdout>` (and `-stderr`). Null when the text
 * is not that, or printed nothing.
 */
export function localCommandOutput(text: string): string | null {
  const streams = [
    ...text.matchAll(
      /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g,
    ),
  ];
  if (!streams.length) return null;
  // Anything besides the streams' own tags is not an output record.
  const rest = text
    .replace(/<local-command-(stdout|stderr)>[\s\S]*?<\/local-command-\1>/g, "")
    .trim();
  if (rest) return null;
  const output = streams
    .map((match) => match[2]!.trim())
    .filter(Boolean)
    .join("\n");
  return output || null;
}
