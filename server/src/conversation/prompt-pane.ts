/**
 * Text for the agent of a pane from Roamgate itself (review comments):
 * a message when conversation mode holds the pane, where typing would only
 * reach the holder; typed into the pane through Herdr's `agent.prompt`
 * when the terminal owns it. Says which way it went.
 */
export async function promptPaneAgent(
  runtime: {
    conversation: { prompt(paneId: string, text: string): Promise<boolean> };
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
): Promise<"conversation" | "terminal"> {
  if (await runtime.conversation.prompt(paneId, text)) return "conversation";
  await runtime.herdr.call("agent.prompt", { target: paneId, text }, 5000);
  return "terminal";
}
