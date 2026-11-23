import fixture from "../../../contract/vectors/session-rewind-fixture.json";

/**
 * Recorded (slimmed) from a real conversation-mode transcript: the user sent
 * "I think you should check out his last messages." and "No, I'm telling you
 * to look at Romate last messages.", each through Claude Code's queue, then
 * rewound to before the first from the chat. The next message hangs from
 * before them. Texts are cut short; thinking blocks emptied. Kept as JSON in
 * contract/vectors, which the Rust tests read too.
 */
export const rewoundAfterQueuedRecords: Record<string, unknown>[] =
  fixture.records;
