/**
 * Claude Code transcript records shaped as Claude Code 2.1 writes them,
 * for the limit-resume tests.
 */

export const SESSION = "362be254-14eb-4390-a96c-25032526572a";

/** A usage-limit stop as Claude Code 2.1 writes it in its transcript. */
export function stopRecord(
  options: {
    resetsAt?: number;
    kind?: string;
    timestamp?: string;
    uuid?: string;
    text?: string;
  } = {},
) {
  const info = {
    status: "rejected",
    resetsAt: options.resetsAt ?? 1794026400,
    rateLimitType: options.kind ?? "five_hour",
    overageStatus: "rejected",
    overageDisabledReason: "org_level_disabled",
    isUsingOverage: false,
  };
  return {
    parentUuid: "ebd6e871-44b7-4192-b508-388cb5222b94",
    isSidechain: false,
    type: "assistant",
    uuid: options.uuid ?? "243ce981-fba6-4e6d-8765-6373ac6cf6aa",
    timestamp: options.timestamp ?? "2026-11-07T04:33:24.450Z",
    message: {
      id: "fc3f9486-1ac4-48ff-86c5-833bc50c39ba",
      model: "<synthetic>",
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: { input_tokens: 0, output_tokens: 0 },
      content: [
        {
          type: "text",
          text:
            options.text ??
            "You've hit your 5-hour limit · resets 1:40am (America/Santiago)",
        },
      ],
    },
    requestId: "req_011CgnwfEpKbGfKMi1Qn7XrV",
    apiError: "usage_limit_reached",
    apiErrorParams: { rate_limit_info: info },
    quotaLimits: { ...info, unifiedRateLimitFallbackAvailable: false },
    error: "rate_limit",
    isApiErrorMessage: true,
    apiErrorStatus: 429,
    userType: "external",
    entrypoint: "sdk-cli",
    cwd: "/Users/thiblahute/devel/misc/roamgate",
    sessionId: SESSION,
    version: "2.1.319",
  };
}

/** What Claude Code writes after the stop: its bookkeeping. */
export const BOOKKEEPING = [
  {
    type: "last-prompt",
    lastPrompt: "Fix the tests",
    leafUuid: "243ce981-fba6-4e6d-8765-6373ac6cf6aa",
    sessionId: SESSION,
  },
  { type: "cost-state", sessionId: SESSION, totalCostUSD: 12.5 },
  { type: "tools-used", tools: ["Bash", "Edit"] },
  {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-11-07T04:34:00.000Z",
    sessionId: SESSION,
    content: "x",
  },
  {
    type: "queue-operation",
    operation: "dequeue",
    timestamp: "2026-11-07T04:34:00.000Z",
    sessionId: SESSION,
  },
  { type: "file-history-snapshot", messageId: "m1", snapshot: {} },
  { type: "system", subtype: "local_command", content: "/usage" },
];

export function userRecord(text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    isSidechain: false,
    uuid: crypto.randomUUID(),
    timestamp: "2026-11-07T11:02:18.555Z",
    message: { role: "user", content: text },
    sessionId: SESSION,
    ...extra,
  };
}

export function answerRecord(text = "Done.") {
  return {
    type: "assistant",
    isSidechain: false,
    uuid: crypto.randomUUID(),
    timestamp: "2026-11-07T11:03:00.000Z",
    message: {
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text }],
    },
    sessionId: SESSION,
  };
}

export function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}
