/**
 * What delivers to a pane's Claude through Roamgate's Claude mod, when that
 * Claude runs a live one: the message's inbox id, else null.
 */
export type ClaudeModDelivery = {
  deliver(paneId: string, text: string, kind?: string): { id: number } | null;
  /** Whether the pane's Claude has the mod's tools (it said so lately). */
  hasTools?(paneId: string): boolean;
};

/**
 * Text for the agent of a pane from Roamgate itself (review comments):
 * a message when conversation mode holds the pane, where typing would only
 * reach the holder; the pane's Claude mod when it runs a live one, which
 * submits it once Claude is idle; typed into the pane through Herdr's
 * `agent.prompt` otherwise. Says which way it went.
 */
export async function promptPaneAgent(
  runtime: {
    conversation: { prompt(paneId: string, text: string): Promise<boolean> };
    claudeMod?: ClaudeModDelivery;
    herdr: {
      call(
        method: string,
        params: Record<string, unknown>,
        timeoutMs?: number,
      ): Promise<unknown>;
    };
  },
  paneId: string,
  text: string,
  kind = "",
): Promise<"conversation" | "mod" | "terminal"> {
  if (await runtime.conversation.prompt(paneId, text)) return "conversation";
  if (runtime.claudeMod?.deliver(paneId, text, kind)) return "mod";
  await runtime.herdr.call("agent.prompt", { target: paneId, text }, 5000);
  return "terminal";
}
