import { describe, expect, test } from "bun:test";
import { normalizeProfilesSettings } from "../../../shared/agentProfiles";
import type { GuiSettings } from "../config/gui-settings";
import { createSessionProfiles } from "./profiles";
import {
  agentNeutral,
  handleProfileRpc,
  type ProfileRpcDeps,
  returnAfterReset,
} from "./rpc";

const SETTINGS: GuiSettings = {
  version: 1,
  repositories: {},
  workspace_auto_sync: {},
  custom: {},
  ui: {},
  profiles: normalizeProfilesSettings({
    list: [
      {
        name: "Igalia GLM",
        agent: "claude",
        env: {
          ANTHROPIC_BASE_URL: "https://gw.example",
          ANTHROPIC_MODEL: "glm-5p3",
        },
      },
    ],
    default: "Claude",
    return_after_reset: true,
  }),
};

const LIMIT_TAIL = JSON.stringify({
  type: "assistant",
  isApiErrorMessage: true,
  error: "rate_limit",
  message: {
    content: [
      {
        type: "text",
        text: "You've hit your 5-hour limit · resets 5:20pm (America/Santiago)",
      },
    ],
  },
});

function deps(overrides: Partial<ProfileRpcDeps> = {}) {
  const calls: string[] = [];
  const launches: unknown[] = [];
  const store = createSessionProfiles({ file: null });
  const value: ProfileRpcDeps = {
    readSettings: async () => SETTINGS,
    store,
    agentGet: async () => ({
      agent: "claude",
      agent_status: "idle",
      agent_session: { kind: "id", value: "s-1" },
    }),
    conversationSession: () => null,
    restartProcess: async (paneId) => {
      calls.push(`process ${paneId}`);
      return { ok: true };
    },
    restartTerminal: async (paneId, sessionId) => {
      calls.push(`terminal ${paneId} ${sessionId}`);
      return { ok: true };
    },
    transcriptTail: async () => LIMIT_TAIL,
    typedLaunch: (paneId, spec) => {
      launches.push({ paneId, spec });
      return " launch TOKEN\r";
    },
    sendConversation: async (paneId, text) => {
      calls.push(`send ${paneId} ${text}`);
    },
    promptTerminal: async (paneId, text) => {
      calls.push(`prompt ${paneId} ${text}`);
    },
    ...overrides,
  };
  return { deps: value, calls, launches, store };
}

describe("agent_profile RPCs", () => {
  test("get: the session's profile, the others and its usage limit", async () => {
    const { deps: d } = deps();
    const result = (await handleProfileRpc(
      "agent_profile.get",
      { pane_id: "p" },
      d,
    )) as Record<string, any>;
    expect(result).toMatchObject({
      session_id: "s-1",
      owner: "terminal",
      profile: "Claude",
      default: "Claude",
      limit: { kind: "5-hour" },
    });
    expect(result.profiles).toEqual([
      { name: "Claude", agent: "claude", label: "Claude", default: true },
      {
        name: "Igalia GLM",
        agent: "claude",
        label: "GLM 5p3",
        default: false,
      },
    ]);
  });

  test("switch in the terminal: remembered, then the TUI restarts", async () => {
    const { deps: d, calls, store } = deps();
    const result = await handleProfileRpc(
      "agent_profile.switch",
      { pane_id: "p", profile: "Igalia GLM", resets_at: Date.now() + 60_000 },
      d,
    );
    expect(result).toMatchObject({ ok: true, label: "GLM 5p3" });
    expect(calls).toEqual(["terminal p s-1"]);
    expect(store.get("s-1")).toMatchObject({
      profile: "Igalia GLM",
      return_to: "Claude",
    });
    // Back to the default: the choice goes.
    await handleProfileRpc(
      "agent_profile.switch",
      { pane_id: "p", profile: "Claude" },
      d,
    );
    expect(store.get("s-1")).toBeNull();
  });

  test("switch in conversation mode restarts its process", async () => {
    const { deps: d, calls } = deps({ conversationSession: () => "s-9" });
    await handleProfileRpc(
      "agent_profile.switch",
      { pane_id: "p", profile: "Igalia GLM" },
      d,
    );
    expect(calls).toEqual(["process p"]);
  });

  test("a refused switch leaves the session as it was", async () => {
    const { deps: d, store } = deps({
      restartTerminal: async () => ({ ok: false, reason: "Claude is working" }),
    });
    store.set("s-1", "Claude-old");
    const result = await handleProfileRpc(
      "agent_profile.switch",
      { pane_id: "p", profile: "Igalia GLM" },
      d,
    );
    // Said of the agent: the session may run another profile's model.
    expect(result).toEqual({ ok: false, reason: "The agent is working" });
    expect(store.get("s-1")?.profile).toBe("Claude-old");
  });

  test("refusals name the agent, not its program; commands stay", () => {
    expect(
      agentNeutral(
        "Claude is working (a turn or a background task); it can switch once it is idle",
      ),
    ).toBe(
      "The agent is working (a turn or a background task); it can switch once it is idle",
    );
    expect(
      agentNeutral(
        "Something is typed in Claude's prompt box; send or clear it first",
      ),
    ).toBe(
      "Something is typed in the agent's prompt box; send or clear it first",
    );
    expect(
      agentNeutral(
        "Claude exited but did not start again: gone; run claude --resume s-1 there",
      ),
    ).toBe(
      "The agent exited but did not start again: gone; run claude --resume s-1 there",
    );
    expect(agentNeutral("Claude Code did not answer")).toBe(
      "Claude Code did not answer",
    );
  });

  test("switch checks the pane still runs the session it was asked for", async () => {
    const { deps: d } = deps();
    await expect(
      handleProfileRpc(
        "agent_profile.switch",
        { pane_id: "p", profile: "Igalia GLM", session_id: "other" },
        d,
      ),
    ).rejects.toThrow(/another session/);
  });

  test("launch: plain claude types as before, a profile a token", async () => {
    const { deps: d, launches } = deps();
    expect(
      await handleProfileRpc("agent_profile.launch", { pane_id: "p" }, d),
    ).toEqual({ text: null, profile: "Claude" });
    expect(
      await handleProfileRpc(
        "agent_profile.launch",
        { pane_id: "p", profile: "Igalia GLM" },
        d,
      ),
    ).toEqual({ text: "launch TOKEN", profile: "Igalia GLM" });
    expect(launches).toEqual([
      {
        paneId: "p",
        spec: expect.objectContaining({
          argv: ["claude"],
          terminal: false,
          env: expect.objectContaining({ ANTHROPIC_MODEL: "glm-5p3" }),
        }),
      },
    ]);
  });
});

describe("retrying after a usage limit", () => {
  test("the terminal's idle Claude is told to continue", async () => {
    const { deps: d, calls } = deps();
    expect(
      await handleProfileRpc("agent_profile.retry", { pane_id: "p" }, d),
    ).toMatchObject({ ok: true });
    expect(calls).toEqual(["prompt p continue"]);
  });

  test("conversation mode gets it as a message", async () => {
    const { deps: d, calls } = deps({ conversationSession: () => "s-9" });
    await handleProfileRpc("agent_profile.retry", { pane_id: "p" }, d);
    expect(calls).toEqual(["send p continue"]);
  });

  test("a busy terminal is left alone", async () => {
    const { deps: d, calls } = deps({
      agentGet: async () => ({
        agent: "claude",
        agent_status: "working",
        agent_session: { kind: "id", value: "s-1" },
      }),
    });
    expect(
      await handleProfileRpc("agent_profile.retry", { pane_id: "p" }, d),
    ).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });
});

describe("back to the default after a reset", () => {
  test("a running session is switched; one gone just forgets", async () => {
    let now = 0;
    const store = createSessionProfiles({ file: null, now: () => now });
    store.set("s-1", "Igalia GLM", { at: 10, to: "Claude" });
    store.set("s-2", "Igalia GLM", { at: 10, to: "Claude" });
    now = 20;
    const switched: string[] = [];
    await returnAfterReset({
      settings: SETTINGS,
      store,
      connections: [
        {
          panes: async () => [{ paneId: "p1", sessionId: "s-1" }],
          switchPane: async (paneId, profile) => {
            switched.push(`${paneId} ${profile}`);
            return { ok: true };
          },
        },
      ],
    });
    expect(switched).toEqual(["p1 Claude"]);
    expect(store.get("s-2")).toBeNull();
  });

  test("nothing happens with the setting off", async () => {
    const store = createSessionProfiles({ file: null, now: () => 20 });
    store.set("s-1", "Igalia GLM", { at: 10, to: "Claude" });
    await returnAfterReset({
      settings: {
        ...SETTINGS,
        profiles: { ...SETTINGS.profiles!, return_after_reset: false },
      },
      store,
      connections: [],
    });
    expect(store.get("s-1")?.profile).toBe("Igalia GLM");
  });
});

describe("model continuity across a switch", () => {
  const answer = (model: string) =>
    JSON.stringify({
      type: "assistant",
      message: { model, content: [{ type: "text", text: "ok" }] },
    });

  test("back on Claude after Kimi: started on its Claude model until it answered", async () => {
    let tail = [answer("claude-opus-5-5"), answer("kimi-k3p1-pro")].join("\n");
    const {
      deps: d,
      store,
      calls,
    } = deps({ transcriptTail: async () => tail });
    store.set("s-1", "Igalia GLM");
    await handleProfileRpc(
      "agent_profile.switch",
      { pane_id: "p", profile: "Claude" },
      d,
    );
    expect(calls).toEqual(["terminal p s-1"]);
    expect(store.get("s-1")).toMatchObject({
      profile: null,
      model: "claude-opus-5-5",
    });
    // Not answered yet: kept.
    await handleProfileRpc("agent_profile.get", { pane_id: "p" }, d);
    expect(store.get("s-1")?.model).toBe("claude-opus-5-5");
    // Answered on Claude: its own model choice holds from now on.
    tail = `${tail}\n${answer("claude-opus-5-5")}`;
    await handleProfileRpc("agent_profile.get", { pane_id: "p" }, d);
    expect(store.get("s-1")).toBeNull();
  });

  test("a refused switch keeps the one-time model it had", async () => {
    const { deps: d, store } = deps({
      transcriptTail: async () => answer("kimi-k3p1-pro"),
      restartTerminal: async () => ({ ok: false, reason: "busy" }),
    });
    store.set("s-1", null, undefined, "claude-opus-5-5");
    await handleProfileRpc(
      "agent_profile.switch",
      { pane_id: "p", profile: "Igalia GLM" },
      d,
    );
    expect(store.get("s-1")).toMatchObject({
      profile: null,
      model: "claude-opus-5-5",
    });
  });
});
