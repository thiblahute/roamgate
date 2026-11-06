import { describe, expect, test } from "bun:test";
import {
  allProfiles,
  chosenModelAnswered,
  isPlainProfile,
  latestSessionAnswer,
  latestSessionModel,
  latestTranscriptModel,
  latestUsageLimit,
  normalizeProfilesSettings,
  parseResetTime,
  parseUsageLimit,
  profileError,
  profileModelLabel,
  profileNamed,
  profileServesModel,
  profilesSettingsError,
  profileUnset,
  profileView,
  switchModel,
} from "./agentProfiles";

const GLM = {
  name: "Igalia GLM",
  agent: "claude" as const,
  env: {
    ANTHROPIC_BASE_URL: "https://ai.example",
    ANTHROPIC_AUTH_TOKEN: { file: "~/.config/roamgate/secrets/token" },
    ANTHROPIC_MODEL: "glm-5p3",
  },
};

describe("profiles", () => {
  test("the built-in Claude is offered first and is plain", () => {
    const all = allProfiles([GLM]);
    expect(all.map((each) => each.name)).toEqual(["Claude", "Igalia GLM"]);
    expect(isPlainProfile(all[0]!)).toBe(true);
    expect(isPlainProfile(GLM)).toBe(false);
    expect(profileNamed([GLM], "igalia glm")?.name).toBe("Igalia GLM");
  });

  test("a user profile named Claude replaces the built-in", () => {
    const own = { name: "Claude", agent: "claude" as const, env: { A: "1" } };
    expect(allProfiles([own])).toEqual([own]);
  });

  test("invalid profiles are refused with a reason", () => {
    expect(profileError({ name: "", agent: "claude" })).toMatch(/name/);
    expect(profileError({ name: "X", agent: "gpt" })).toMatch(/agent/);
    expect(
      profileError({ name: "X", agent: "claude", env: { "BAD NAME": "1" } }),
    ).toMatch(/variable name/);
    expect(
      profileError({ name: "X", agent: "claude", env: { A: { path: "x" } } }),
    ).toMatch(/file/);
    expect(
      profilesSettingsError({ list: [GLM, GLM], default: "Claude" }),
    ).toMatch(/Two profiles/);
    expect(profilesSettingsError({ list: [GLM], default: "Nope" })).toMatch(
      /No profile/,
    );
    expect(profilesSettingsError({ list: [GLM], default: "Igalia GLM" })).toBe(
      null,
    );
  });

  test("normalizing drops what is invalid and resets an unknown default", () => {
    expect(
      normalizeProfilesSettings({
        list: [GLM, { name: "" }],
        default: "gone",
        return_after_reset: true,
      }),
    ).toEqual({ list: [GLM], default: "Claude", return_after_reset: true });
    expect(normalizeProfilesSettings(undefined)).toEqual({
      list: [],
      default: "Claude",
      return_after_reset: false,
    });
  });

  test("a profile with its own token removes the pane's key and providers", () => {
    expect(profileUnset(GLM)).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ]);
    expect(
      profileUnset({ name: "x", agent: "claude", unset: ["FOO"] }),
    ).toEqual(["FOO"]);
  });

  test("a browser sees a secret file's path, never a value", () => {
    expect(profileView(GLM).env).toEqual([
      { name: "ANTHROPIC_BASE_URL", value: "https://ai.example" },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        file: "~/.config/roamgate/secrets/token",
      },
      { name: "ANTHROPIC_MODEL", value: "glm-5p3" },
    ]);
  });

  test("the chip names the model", () => {
    expect(profileModelLabel(GLM)).toBe("GLM 5p3");
    expect(
      profileModelLabel({
        name: "Kimi",
        agent: "claude",
        env: { ANTHROPIC_MODEL: "kimi-k3p1-pro" },
      }),
    ).toBe("Kimi k3p1 pro");
    expect(profileModelLabel({ name: "Claude", agent: "claude" })).toBe(
      "Claude",
    );
  });
});

describe("usage limits", () => {
  // 2026-11-05 15:00 in Santiago (UTC-3).
  const now = Date.UTC(2026, 10, 5, 18, 0);

  test("Claude Code's limit message, with its reset time in its zone", () => {
    const limit = parseUsageLimit(
      "You've hit your 5-hour limit · resets 5:20pm (America/Santiago)",
      now,
    );
    expect(limit).toMatchObject({
      kind: "5-hour",
      resets: "5:20pm (America/Santiago)",
      resets_at: Date.UTC(2026, 10, 5, 20, 20),
    });
  });

  test("a reset time already past today is tomorrow's", () => {
    expect(parseResetTime("9am (America/Santiago)", now)).toBe(
      Date.UTC(2026, 10, 6, 12, 0),
    );
  });

  test("a weekly limit names its day", () => {
    expect(
      parseUsageLimit(
        "You've hit your weekly limit · resets Nov 9 at 8am (America/Santiago)",
        now,
      ),
    ).toMatchObject({
      kind: "weekly",
      resets_at: Date.UTC(2026, 10, 9, 11, 0),
    });
  });

  test("older and API forms", () => {
    expect(
      parseUsageLimit("Claude AI usage limit reached|1762380000", now),
    ).toMatchObject({ resets_at: 1762380000 * 1000 });
    expect(
      parseUsageLimit(
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
        now,
      ),
    ).toMatchObject({ kind: "rate", resets_at: null });
    expect(parseUsageLimit("All good, no limit here", now)).toBeNull();
    expect(
      parseUsageLimit("You've hit your session limit · resets soon", now),
    ).toMatchObject({ kind: "session", resets_at: null });
  });

  test("a limit is over once its reset time has passed, read from when it was hit", () => {
    const record = (timestamp: string) =>
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: true,
        timestamp,
        message: {
          content: [
            {
              type: "text",
              text: "You've hit your session limit · resets 5:20pm (America/Santiago)",
            },
          ],
        },
      });
    // Hit at 14:00 Santiago: resets 17:20 that day.
    const hit = record("2026-11-05T17:00:00.000Z");
    expect(latestUsageLimit(hit, now)).toMatchObject({
      kind: "session",
      zone: "America/Santiago",
      at: Date.UTC(2026, 10, 5, 17, 0),
      resets_at: Date.UTC(2026, 10, 5, 20, 20),
    });
    expect(latestUsageLimit(hit, Date.UTC(2026, 10, 5, 20, 21))).toBeNull();
    // Hit yesterday: its 5:20pm passed long ago.
    expect(
      latestUsageLimit(record("2026-11-04T17:00:00.000Z"), now),
    ).toBeNull();
  });

  test("a transcript's newest assistant record decides", () => {
    const error = JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      error: "rate_limit",
      message: {
        model: "<synthetic>",
        content: [
          {
            type: "text",
            text: "You've hit your 5-hour limit · resets 5:20pm (America/Santiago)",
          },
        ],
      },
    });
    const ok = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Done." }] },
    });
    const user = JSON.stringify({ type: "user", message: { content: "hi" } });
    expect(latestUsageLimit([ok, error, user].join("\n"), now)?.kind).toBe(
      "5-hour",
    );
    expect(latestUsageLimit([error, ok].join("\n"), now)).toBeNull();
    // A cut first line (a tail read) is skipped.
    expect(latestUsageLimit(`pe":"x"}\n${error}\n`, now)?.kind).toBe("5-hour");
  });
});

describe("the model a session moved to another profile starts with", () => {
  const answer = (model: string) =>
    JSON.stringify({
      type: "assistant",
      message: { model, content: [{ type: "text", text: "ok" }] },
    });
  const notice = JSON.stringify({
    type: "assistant",
    message: {
      model: "<synthetic>",
      content: [
        { type: "text", text: "There's an issue with the selected model" },
      ],
    },
  });
  const error = JSON.stringify({
    type: "assistant",
    isApiErrorMessage: true,
    message: { model: "kimi-k3p1-pro", content: [] },
  });
  const claude = { name: "Claude", agent: "claude" as const };
  const kimi = {
    name: "Kimi",
    agent: "claude" as const,
    env: {
      ANTHROPIC_BASE_URL: "https://ai.example.com",
      ANTHROPIC_MODEL: "kimi-k3p1-pro",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "glm-5p3-flash",
    },
  };

  test("the last answer's model; notices and API errors are no answers", () => {
    const tail = [answer("claude-opus-5-5"), error, notice, "{cut"].join("\n");
    expect(latestSessionModel(tail)).toBe("claude-opus-5-5");
    expect(latestSessionModel(notice)).toBeNull();
  });

  test("Anthropic's endpoint has Claude models, a gateway its slots'", () => {
    expect(profileServesModel(claude, "claude-opus-5-5")).toBe(true);
    expect(profileServesModel(claude, "kimi-k3p1-pro")).toBe(false);
    expect(profileServesModel(kimi, "glm-5p3-flash")).toBe(true);
    expect(profileServesModel(kimi, "claude-opus-5-5")).toBe(false);
  });

  test("back on Claude after Kimi: the Claude model it had", () => {
    // Claude Code would resume on kimi-k3p1-pro, unknown to Anthropic.
    const tail = [
      answer("claude-opus-5-5"),
      answer("kimi-k3p1-pro"),
      notice,
    ].join("\n");
    expect(switchModel(tail, claude)).toBe("claude-opus-5-5");
    expect(switchModel(tail, kimi)).toBeNull();
    expect(switchModel(answer("kimi-k3p1-pro"), claude)).toBe("opus");
  });

  test("onto a gateway: its own model; nothing known: nothing", () => {
    expect(switchModel(answer("claude-opus-5-5"), kimi)).toBe("kimi-k3p1-pro");
    expect(switchModel(answer("claude-opus-5-5"), claude)).toBeNull();
    expect(switchModel(null, claude)).toBeNull();
    expect(switchModel(notice, claude)).toBeNull();
  });
});

describe("a chosen model the session answered with", () => {
  const claude = { name: "Claude", agent: "claude" as const };
  const luna = {
    name: "OpenAI Luna",
    agent: "claude" as const,
    env: {
      ANTHROPIC_BASE_URL: "http://127.0.0.1:18765",
      ANTHROPIC_MODEL: "gpt-6-luna",
    },
  };
  const at = (iso: string) => Date.parse(iso);
  const chosen = {
    model: "haiku",
    resolved: "claude-haiku-5-5",
    at: "2026-11-06T10:00:00.000Z",
  };

  test("the last answer, with when it came", () => {
    const tail = [
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-06T09:00:00.000Z",
        message: { model: "claude-opus-5-5", content: [] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { model: "<synthetic>", content: [] },
      }),
    ].join("\n");
    expect(latestSessionAnswer(tail)).toEqual({
      model: "claude-opus-5-5",
      at: at("2026-11-06T09:00:00.000Z"),
    });
    expect(
      latestSessionAnswer(
        JSON.stringify({ type: "assistant", message: { model: "m" } }),
      ),
    ).toEqual({ model: "m", at: null });
  });

  test("an answer from before the choice, on another model, is not one", () => {
    // /model haiku, nothing sent since: the next start still needs it.
    expect(
      chosenModelAnswered(
        { model: "claude-opus-5-5", at: at("2026-11-06T09:00:00.000Z") },
        chosen,
        claude,
      ),
    ).toBe(false);
    expect(
      chosenModelAnswered(
        { model: "claude-opus-5-5", at: null },
        chosen,
        claude,
      ),
    ).toBe(false);
  });

  test("answered with it: by its name, or the model the agent said it is", () => {
    expect(
      chosenModelAnswered(
        { model: "claude-haiku-5-5", at: at("2026-11-06T09:00:00.000Z") },
        chosen,
        claude,
      ),
    ).toBe(true);
    expect(
      chosenModelAnswered(
        { model: "gpt-6-sol", at: null },
        { model: "gpt-6-sol", at: chosen.at },
        luna,
      ),
    ).toBe(true);
  });

  test("a later answer on another model the profile serves: the session moved on", () => {
    expect(
      chosenModelAnswered(
        { model: "claude-sonnet-5-5", at: at("2026-11-06T11:00:00.000Z") },
        chosen,
        claude,
      ),
    ).toBe(true);
    // Not a model the profile serves: not taken as a move.
    expect(
      chosenModelAnswered(
        { model: "kimi-k3p1-pro", at: at("2026-11-06T11:00:00.000Z") },
        chosen,
        claude,
      ),
    ).toBe(false);
  });
});

describe("the model a transcript names", () => {
  const line = (record: unknown) => JSON.stringify(record);
  test("Claude, Pi and Codex transcripts, the newest record first", () => {
    expect(
      latestTranscriptModel(
        [
          line({ type: "assistant", message: { model: "claude-opus-5-5" } }),
          line({ type: "assistant", message: { model: "claude-haiku-5-5" } }),
          line({
            type: "assistant",
            isApiErrorMessage: true,
            message: { model: "claude-sonnet-5-5" },
          }),
          line({ type: "assistant", message: { model: "<synthetic>" } }),
        ].join("\n"),
      ),
    ).toBe("claude-haiku-5-5");
    expect(
      latestTranscriptModel(
        [
          line({
            type: "message",
            message: { role: "assistant", model: "deepseek-v4-flash" },
          }),
          line({ type: "model_change", modelId: "glm-5p3" }),
        ].join("\n"),
      ),
    ).toBe("glm-5p3");
    expect(
      latestTranscriptModel(
        line({ type: "turn_context", payload: { model: "gpt-5.6-sol" } }),
      ),
    ).toBe("gpt-5.6-sol");
    expect(
      latestTranscriptModel(
        line({ type: "user", message: { role: "user", content: "hi" } }),
      ),
    ).toBeNull();
  });
});
