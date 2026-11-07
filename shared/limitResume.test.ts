import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LIMIT_RESUME,
  limitKindLabel,
  limitResumeSettingsError,
  limitResumeSettingsOf,
  normalizeLimitResumeSettings,
  parseLimitPauses,
  usageLimitStop,
  usageLimitStopOf,
} from "./limitResume";
import {
  answerRecord,
  BOOKKEEPING,
  jsonl,
  SESSION,
  stopRecord,
  userRecord,
} from "./limitResumeTesting";

describe("usageLimitStop", () => {
  test("reads the 5-hour stop from its structured fields", () => {
    const stop = usageLimitStop(
      jsonl(userRecord("Fix the tests"), stopRecord(), ...BOOKKEEPING),
    );
    expect(stop).toEqual({
      resets_at: 1794026400_000,
      kind: "five_hour",
      stopped_at: Date.parse("2026-11-07T04:33:24.450Z"),
      uuid: "243ce981-fba6-4e6d-8765-6373ac6cf6aa",
      message:
        "You've hit your 5-hour limit · resets 1:40am (America/Santiago)",
    });
  });

  test("reads a weekly stop the same way", () => {
    const stop = usageLimitStop(
      jsonl(
        stopRecord({
          kind: "seven_day",
          resetsAt: 1794222000,
          text: "You've hit your weekly limit · resets Nov 9, 8am (America/Santiago)",
        }),
      ),
    );
    expect(stop?.kind).toBe("seven_day");
    expect(stop?.resets_at).toBe(1794222000_000);
  });

  test("uses the fields, not the words", () => {
    // Words that would say another time do not move the reset.
    const stop = usageLimitStop(
      jsonl(stopRecord({ text: "You've hit your limit · resets 9pm" })),
    );
    expect(stop?.resets_at).toBe(1794026400_000);
    // The words alone (no structured fields) are not a stop.
    const wordsOnly = {
      ...stopRecord(),
      apiErrorParams: undefined,
      quotaLimits: undefined,
    };
    expect(usageLimitStop(jsonl(wordsOnly))).toBeNull();
  });

  test("falls back on quotaLimits when the error params lack the info", () => {
    const record = { ...stopRecord(), apiErrorParams: {} };
    expect(usageLimitStop(jsonl(record))?.resets_at).toBe(1794026400_000);
  });

  test("another API error, or an allowed rate limit, is no stop", () => {
    const overloaded = {
      ...stopRecord(),
      apiError: "overloaded",
      error: "server_error",
    };
    expect(usageLimitStop(jsonl(overloaded))).toBeNull();
    const allowed = stopRecord();
    allowed.apiErrorParams.rate_limit_info.status = "allowed";
    allowed.quotaLimits.status = "allowed";
    expect(usageLimitStop(jsonl(allowed))).toBeNull();
  });

  test("the user typing after the stop resumed it", () => {
    expect(
      usageLimitStop(
        jsonl(stopRecord(), ...BOOKKEEPING, userRecord("Keep going")),
      ),
    ).toBeNull();
    expect(
      usageLimitStop(
        jsonl(stopRecord(), userRecord("Keep going"), answerRecord()),
      ),
    ).toBeNull();
  });

  test("a resume the limit stopped again is paused by the newest stop", () => {
    const stop = usageLimitStop(
      jsonl(
        stopRecord({ uuid: "a" }),
        userRecord("Keep going"),
        stopRecord({ uuid: "b", resetsAt: 1794044400 }),
      ),
    );
    expect(stop?.uuid).toBe("b");
    expect(stop?.resets_at).toBe(1794044400_000);
  });

  test("meta records, subagents and local commands do not count as turns", () => {
    const stop = usageLimitStop(
      jsonl(
        stopRecord(),
        userRecord("<local-command-caveat>Caveat</local-command-caveat>", {
          isMeta: true,
        }),
        userRecord("<command-name>/usage</command-name>"),
        userRecord(
          "<local-command-stdout>Current session: 100% used</local-command-stdout>",
        ),
        { ...answerRecord("subagent"), isSidechain: true },
      ),
    );
    expect(stop?.kind).toBe("five_hour");
  });

  test("a tail cut inside a record skips the broken line", () => {
    const text = jsonl(userRecord("x"), stopRecord(), ...BOOKKEEPING);
    expect(usageLimitStop(`ive":true}\n${text}`)?.kind).toBe("five_hour");
    // An in-flight request: only a request blob's end, nothing to say.
    expect(usageLimitStop('"text":"...a long request blob"}')).toBeNull();
  });

  test("reads conversation mode's stream-json spelling too", () => {
    const streamed = {
      type: "assistant",
      session_id: SESSION,
      uuid: "22360b0f-7506-4a29-a797-1fe649b67bed",
      timestamp: "2026-11-06T16:01:54.559Z",
      error: "rate_limit",
      is_api_error_message: true,
      api_error_status: 429,
      api_error: "usage_limit_reached",
      api_error_params: {
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1793989800,
          rateLimitType: "five_hour",
        },
      },
      message: {
        content: [
          {
            type: "text",
            text: "You've hit your 5-hour limit · resets 3:30pm (America/Santiago)",
          },
        ],
      },
    };
    expect(usageLimitStopOf(streamed)?.resets_at).toBe(1793989800_000);
  });
});

describe("settings", () => {
  test("defaults: on, a minute after the reset, the message", () => {
    expect(limitResumeSettingsOf(undefined)).toEqual(DEFAULT_LIMIT_RESUME);
    expect(DEFAULT_LIMIT_RESUME.enabled).toBe(true);
    expect(DEFAULT_LIMIT_RESUME.margin_seconds).toBe(60);
    expect(DEFAULT_LIMIT_RESUME.message).toContain("background agents");
    expect(DEFAULT_LIMIT_RESUME.message).not.toContain("—");
  });

  test("validates each key", () => {
    expect(limitResumeSettingsError({ enabled: false })).toBeNull();
    expect(limitResumeSettingsError({ enabled: "no" })).toContain("enabled");
    expect(limitResumeSettingsError({ message: "  " })).toContain("message");
    expect(limitResumeSettingsError({ margin_seconds: -1 })).toContain(
      "margin_seconds",
    );
    expect(limitResumeSettingsError({ margin_seconds: 1.5 })).toContain(
      "margin_seconds",
    );
    expect(limitResumeSettingsError({ other: 1 })).toContain("other");
  });

  test("keeps the valid stored keys only", () => {
    expect(
      normalizeLimitResumeSettings({
        enabled: false,
        message: " Go on. ",
        margin_seconds: "soon",
      }),
    ).toEqual({ enabled: false, message: "Go on." });
    expect(normalizeLimitResumeSettings(null)).toBeUndefined();
  });
});

test("limit kinds read as the user knows them", () => {
  expect(limitKindLabel("five_hour")).toBe("5-hour");
  expect(limitKindLabel("seven_day")).toBe("weekly");
  expect(limitKindLabel("seven_day_opus")).toBe("weekly Opus");
  expect(limitKindLabel("monthly_thing")).toBe("monthly thing");
});

test("parseLimitPauses keeps well-formed pauses", () => {
  expect(
    parseLimitPauses({
      pauses: [
        {
          connection_id: "local",
          pane_id: "w1:p1",
          session_id: "s",
          resets_at: 1,
          state: "scheduled",
        },
        { pane_id: 3 },
      ],
    }),
  ).toHaveLength(1);
});
